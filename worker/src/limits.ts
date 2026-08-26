import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  UNISWAP,
  grantHasTransfer,
  grantHasV4,
  grantV4Adapter,
  sellableAssets,
  usdgUnits,
  type StockToken,
  type StoredGrant,
} from "../../packages/core/src/index";
import type { AgentLimits } from "./policy";

/** Build the off-chain mirror of the limits sealed into a signed grant. */
export function limitsFromGrant(
  grant: StoredGrant,
  watchTokens: readonly StockToken[] = STOCK_TOKENS,
): AgentLimits {
  return {
    perTradeUsdg: usdgUnits(grant.caps.perTradeUsdg),
    dailyUsdg: usdgUnits(grant.caps.dailyUsdg),
    allowedTargets: [
      RIALTO.routerSnapshot as `0x${string}`,
      UNISWAP.swapRouter02 as `0x${string}`,
      MORPHO.steakhouseUsdgVault as `0x${string}`,
      CASH.USDG as `0x${string}`,
      ...(grantHasV4(grant)
        ? [UNISWAP.permit2 as `0x${string}`, UNISWAP.universalRouter as `0x${string}`]
        : []),
      // THE V4 ADAPTER, MIRRORED — and mirrored from the GRANT, not from
      // settings. grantV4Adapter returns the address the swapExactIn
      // permission was actually sealed against (marker AND address, or null),
      // so this list can never admit an adapter the chain would refuse. The
      // transfer-mirror lesson runs in both directions: without this entry a
      // correctly-granted adapter call dies off-chain at `target-allowlist`,
      // a route that looks granted and never fires — the multihop bug's
      // silent sibling.
      ...((): `0x${string}`[] => {
        const a = grantV4Adapter(grant);
        return a ? [a] : [];
      })(),
    ],
    allowedAssets: [CASH.USDG as `0x${string}`, ...watchTokens.map((token) => token.address)],
    sellableAssets: [...sellableAssets(grant)],
    // THE TRANSFER PERMISSION, MIRRORED. checkPolicy has always known how to
    // judge this — it was simply never told. A grant without the transfer
    // marker has NO USDG transfer permission in its call policy:
    // buildCallPermissions emits one only for withdrawal addresses registered
    // at signing, and neither signer registers any.
    //
    // EMPTY, not undefined. undefined means "a pre-allowlist grant, still
    // free-form" and is deliberately permissive; conflating the two is exactly
    // what let the worker build a transfer the chain refuses. This is the
    // load-bearing half of the fix, because it covers EVERY producer of a
    // transfer intent rather than just the Telegram command — and it turns an
    // opaque on-chain revert into the sentence checkPolicy already writes.
    ...(grantHasTransfer(grant) ? {} : { withdrawalAddresses: [] as string[] }),
    // So the breaker can tell a de-risking sell (swap INTO cash) from a buy.
    cashToken: CASH.USDG as string,
    maxDrawdownBps: grant.caps.maxDrawdownPct * 100,
    expiresAt: grant.expiresAt,
    maxOpsPerDay: grant.caps.maxOpsPerDay,
  };
}
