/**
 * Agent executor — turns an approved, simulated intent into a UserOperation
 * signed by the agent's session key. The Kernel account contract re-checks the
 * grant's policies on-chain; this code cannot exceed them even if buggy.
 *
 * Needs a bundler:
 *   MERRYMEN_BUNDLER_URL   e.g. Pimlico/Alchemy bundler RPC for chain 46630/4663
 *
 * The serialized grant embeds the session private key for the TESTNET demo
 * (mirrors web/src/lib/session.ts). Production: Turnkey TEE holds the key and
 * this module signs via its API instead of deserializing a local key.
 */

import { http, createPublicClient, type Chain, type Hex } from "viem";
import { createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { deserializeFlaggedPermissionAccount } from "./session-account";
import { WALL_POLICY_FLAG } from "../../packages/core/src/index";
import { userOpGasConfig } from "./gas";

export interface Call {
  to: `0x${string}`;
  value: bigint;
  data: Hex;
}

/**
 * What actually happened on-chain. This used to be a bare tx hash, and the
 * receipt — logs, gas, the UserOp hash already in hand — was dropped on the
 * floor. Everything downstream then had to be built on the PRE-TRADE quote:
 * cost basis, realized P&L and the equity curve were all estimates of a
 * settled fact we were holding and threw away.
 */
export interface ExecutionResult {
  /** The bundled transaction. Shared with other users' ops — not unique to us. */
  txHash: `0x${string}`;
  /** OUR operation. The only id that identifies this trade on a 4337 explorer. */
  userOpHash: `0x${string}`;
  /** Emitted logs — the real swap amounts live here (see fills.ts). */
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
  /**
   * Gas actually paid, in wei. The account self-pays with no paymaster, so this
   * is a real cost of the trade and it was invisible to P&L: `equity_usdg` is
   * cash + vault + positions, and ETH is not in it.
   */
  gasWei: bigint;
  /** Block the operation landed in — an anchor for anyone re-deriving this later. */
  blockNumber: bigint;
}

/**
 * A UserOp that DID reach the bundler and then went wrong. Both of these carry
 * the hash, because the hash is the only thing that makes the op recoverable —
 * and the ledger could not record what it was never handed.
 */
export class UserOpReverted extends Error {
  readonly userOpHash: `0x${string}`;
  constructor(userOpHash: `0x${string}`, reason?: string) {
    super(`reverted on-chain${reason ? `: ${reason}` : ""} (${userOpHash})`);
    this.name = "UserOpReverted";
    this.userOpHash = userOpHash;
  }
}

/**
 * WE DO NOT KNOW. The op was submitted; the receipt could not be read.
 *
 * This is the state the code had no word for, and the absence was not
 * cosmetic. A receipt-wait timeout throws an ordinary Error whose message does
 * not match /reverted on-chain/, so index.ts's catch classified it as "failed
 * before submit" — told the owner something false about an op that may well
 * have landed, wrote status 'reverted', AND refunded the budget. Every one of
 * those three is the unsafe direction: the day's spend under-counts by exactly
 * that op's notional, and the ledger says the chain refused a trade the chain
 * may have executed.
 *
 * Distinguishing it is the whole point of this class. What the caller does with
 * it — leave the pre-broadcast row 'submitted', keep the budget charged — is
 * index.ts's business, but it cannot make that choice from a string match.
 */
export class UserOpUnresolved extends Error {
  readonly userOpHash: `0x${string}`;
  constructor(userOpHash: `0x${string}`, cause: string) {
    super(`submitted but unresolved (${userOpHash}): ${cause}`);
    this.name = "UserOpUnresolved";
    this.userOpHash = userOpHash;
  }
}

/** How many times the RECEIPT is re-read. Never the send — see execute(). */
const RECEIPT_ATTEMPTS = 3;

export interface ExecuteHooks {
  /**
   * Called with the hash the moment the op leaves, BEFORE the receipt wait, and
   * awaited. Everything after this point can crash, hang or be SIGKILLed, so
   * whatever durability this trade is going to get has to be taken here.
   *
   * A throw from this hook aborts before the wait — deliberately, because the
   * reason to have it is that an unrecorded in-flight op is worse than a late
   * one. The op is already sent by then; the error carries the hash so it is
   * still recoverable.
   */
  onSubmitted?(userOpHash: `0x${string}`): Promise<void>;
}

export interface AgentExecutor {
  /** Counterfactual smart-account address (deploys itself on first op). */
  address: `0x${string}`;
  /** Send a batch of calls as one UserOperation and report what settled. */
  execute(calls: Call[], hooks?: ExecuteHooks): Promise<ExecutionResult>;
}

export async function createAgentExecutor(opts: {
  chain: Chain;
  serializedGrant: string;
  bundlerUrl: string;
  /** RPC override (settings rpcMainnet/rpcTestnet) — falls back to the chain default. */
  rpcUrl?: string;
}): Promise<AgentExecutor> {
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const entryPoint = getEntryPoint("0.7");

  // NOT deserializePermissionAccount. That function silently drops the policy
  // flag the owner signed over, so the enable data we submit would not match
  // the enable data they authorised — and the first UserOp of every grant
  // would fail at plugin-enable. See session-account.ts for the full trace.
  const account = await deserializeFlaggedPermissionAccount(
    publicClient,
    entryPoint,
    KERNEL_V3_3,
    opts.serializedGrant,
    WALL_POLICY_FLAG,
  );

  const client = createKernelAccountClient({
    account,
    chain: opts.chain,
    bundlerTransport: http(opts.bundlerUrl),
    // Without this the SDK calls the ZeroDev-only `zd_getUserOperationGasPrice`,
    // which Pimlico/Alchemy/self-hosted bundlers reject — see worker/src/gas.ts.
    userOperation: userOpGasConfig(publicClient, opts.bundlerUrl),
  });

  return {
    address: account.address,
    async execute(calls: Call[], hooks?: ExecuteHooks) {
      const userOpHash = await client.sendUserOperation({
        callData: await account.encodeCalls(calls),
      });
      // DURABILITY BEFORE THE WAIT. Between here and the ledger write in
      // index.ts sits a receipt wait, a network price call and a DB round
      // trip; nothing was written durably across any of it, so a SIGTERM from
      // a redeploy left a landed op with no record of its hash at all.
      if (hooks?.onSubmitted) await hooks.onSubmitted(userOpHash);

      // ONLY THE READ IS RETRIED. A re-send is a second operation and a second
      // spend — the one mistake this whole shape exists to make impossible, so
      // sendUserOperation sits outside the loop by construction rather than by
      // a comment asking the next reader not to move it.
      let receipt: Awaited<ReturnType<typeof client.waitForUserOperationReceipt>> | null = null;
      let lastErr = "";
      for (let attempt = 1; attempt <= RECEIPT_ATTEMPTS; attempt++) {
        try {
          receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
          break;
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
        }
      }
      // Not "it reverted" and not "it never went" — the two things the caller
      // used to have to choose between. It went, and we could not find out.
      if (!receipt) throw new UserOpUnresolved(userOpHash, lastErr || "receipt never resolved");

      if (!receipt.success) {
        // Surface the on-chain revert reason when the bundler provides one.
        throw new UserOpReverted(userOpHash, (receipt as { reason?: string }).reason);
      }
      // actualGasCost is the ERC-4337 field: what the EntryPoint charged the
      // account, verification included. gasUsed × effectiveGasPrice covers only
      // the bundled transaction and would under-count our share of it, so it is
      // a fallback for bundlers that omit the former, not a preference.
      const gasWei =
        typeof receipt.actualGasCost === "bigint"
          ? receipt.actualGasCost
          : (receipt.receipt.gasUsed ?? 0n) * (receipt.receipt.effectiveGasPrice ?? 0n);
      return {
        txHash: receipt.receipt.transactionHash,
        userOpHash,
        logs: receipt.logs ?? [],
        gasWei,
        blockNumber: receipt.receipt.blockNumber ?? 0n,
      };
    },
  };
}
