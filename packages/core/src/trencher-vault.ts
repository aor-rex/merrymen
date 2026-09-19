import { erc20Abi, parseAbi, type Address } from "viem";
import { ParamCondition } from "@zerodev/permissions/policies";
import { CASH } from "./tokens";

export const GRANT_TRENCHER = "trencher-vault-v1";
export const TRENCHER_VAULT_ABI = parseAbi([
  "function VERSION() view returns (uint256)",
  "function owner() view returns (address)",
  "function cash() view returns (address)",
  "function router() view returns (address)",
  "function poolFactory() view returns (address)",
  "function spent() view returns (uint256)",
  "function windowStart() view returns (uint256)",
  "function tokens() view returns (address[])",
  "function entryAt(address token) view returns (uint256)",
  "function cost(address token) view returns (uint256)",
  "function buy(address token,uint24 fee1,uint24 fee2,uint256 cashIn,uint256 minOut,uint256 deadline) returns (uint256)",
  "function sell(address token,uint24 fee1,uint24 fee2,uint256 tokensIn,uint256 minOut,uint256 deadline) returns (uint256)",
  "function recover(address token)",
  "event Bought(address indexed token,uint256 cashIn,uint256 tokensOut)",
  "event Sold(address indexed token,uint256 tokensIn,uint256 cashOut)",
]);
export const TRENCHER_FACTORY_ABI = parseAbi([
  "function vaultFor(address owner) view returns (address)",
  "function deploy(address owner) returns (address)",
  "function cash() view returns (address)",
  "function bridge() view returns (address)",
  "function router() view returns (address)",
  "function poolFactory() view returns (address)",
]);
export interface TrencherPermission {
  trencherVaultAddress?: string;
  trencherFactoryAddress?: string;
}
export function trencherAddresses(opts: TrencherPermission): { vault: Address; factory: Address } | null {
  if (opts.trencherVaultAddress === undefined && opts.trencherFactoryAddress === undefined) return null;
  const valid = (s: string | undefined): s is Address => !!s && /^0x[0-9a-fA-F]{40}$/.test(s) && !/^0x0{40}$/i.test(s);
  if (!valid(opts.trencherVaultAddress) || !valid(opts.trencherFactoryAddress) || opts.trencherVaultAddress.toLowerCase() === opts.trencherFactoryAddress.toLowerCase()) {
    throw new Error("Trencher permission requires a distinct nonzero vault and factory");
  }
  return { vault: opts.trencherVaultAddress.toLowerCase() as Address, factory: opts.trencherFactoryAddress.toLowerCase() as Address };
}
export function grantTrencher(grant: (TrencherPermission & {grantFeatures?: readonly string[]}) | null | undefined) {
  if (!grant?.grantFeatures?.includes(GRANT_TRENCHER)) return null;
  try { return trencherAddresses(grant); } catch { return null; }
}

/** Exactly one capped cash approval, buy, sell and idempotent deployment. No recovery or arbitrary approval. */
export function trencherPermissions(opts: TrencherPermission, self: Address, cap: bigint) {
  const addresses = trencherAddresses(opts);
  if (!addresses) return [];
  if (cap <= 0n) throw new Error("Trencher needs a positive entry cap");
  const limit = cap < 5_000_000n ? cap : 5_000_000n;
  return [
    { target: CASH.USDG as Address, valueLimit: 0n, abi: erc20Abi, functionName: "approve", args: [
      {condition: ParamCondition.EQUAL,value:addresses.vault},
      {condition: ParamCondition.LESS_THAN_OR_EQUAL,value:limit},
    ] } as const,
    { target: addresses.vault, valueLimit: 0n, abi: TRENCHER_VAULT_ABI, functionName: "buy", args: [
      null,null,null,{condition:ParamCondition.LESS_THAN_OR_EQUAL,value:limit},null,null,
    ] } as const,
    { target: addresses.vault, valueLimit: 0n, abi: TRENCHER_VAULT_ABI, functionName: "sell", args: [null,null,null,null,null,null] } as const,
    { target: addresses.factory, valueLimit: 0n, abi: TRENCHER_FACTORY_ABI, functionName: "deploy", args: [
      {condition:ParamCondition.EQUAL,value:self},
    ] } as const,
  ];
}
