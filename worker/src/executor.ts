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
import { deserializePermissionAccount } from "@zerodev/permissions";
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

export interface AgentExecutor {
  /** Counterfactual smart-account address (deploys itself on first op). */
  address: `0x${string}`;
  /** Send a batch of calls as one UserOperation and report what settled. */
  execute(calls: Call[]): Promise<ExecutionResult>;
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

  const account = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    KERNEL_V3_3,
    opts.serializedGrant,
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
    async execute(calls: Call[]) {
      const userOpHash = await client.sendUserOperation({
        callData: await account.encodeCalls(calls),
      });
      const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
      if (!receipt.success) {
        // Surface the on-chain revert reason when the bundler provides one.
        const reason = (receipt as { reason?: string }).reason;
        throw new Error(`reverted on-chain${reason ? `: ${reason}` : ""} (${userOpHash})`);
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
