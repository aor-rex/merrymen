/**
 * Agent executor — turns an approved, simulated intent into a UserOperation
 * signed by the agent's session key. The Kernel account contract re-checks the
 * grant's policies on-chain; this code cannot exceed them even if buggy.
 *
 * Needs a bundler:
 *   MERRYMEN_BUNDLER_URL   e.g. Pimlico/Alchemy bundler RPC for chain 46630/4663
 *
 * The serialized grant embeds the session private key, on every deployment —
 * not just a testnet demo (mirrors web/src/lib/session.ts). A TEE that holds
 * it instead and signs via an API is the roadmap, not the present tense: this
 * comment used to claim it already worked that way in production, and nothing
 * of the sort is shipped.
 */

import { http, createPublicClient, type Chain, type Hex } from "viem";
import { createKernelAccountClient } from "@zerodev/sdk";
import { SponsorRefused, assertBoundsHeld, type Sponsor } from "./paymaster";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { deserializeFlaggedPermissionAccount } from "./session-account";
import { WALL_POLICY_FLAG } from "../../packages/core/src/index";
import { userOpGasConfig } from "./gas";
import { getUserOperationHash } from "viem/account-abstraction";
import { boundGas, DEPLOY_GAS_BOUNDS, GAS_BOUNDS, type UserOpGas } from "./gas-limits";

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

/**
 * REFUSING TO BROADCAST UNTRACKED.
 *
 * The durable pre-broadcast row could not be written, so this operation would
 * go out with nothing able to reconcile it: no 'submitted' row means
 * `resolveStrandedOps` cannot see it, `inflight-reconcile` only sweeps ops that
 * succeeded, and a crash before the outcome write loses it entirely.
 *
 * Only reachable because `onSubmitted` now runs BEFORE the send. While it ran
 * after, this situation existed and there was nothing useful to do about it —
 * the money was already committed, and the code said so in a comment. Now the
 * cheaper answer is available: don't send.
 *
 * A sibling of GasRefused, not of a revert. Nothing was signed, nothing spent.
 */
export class NotRecorded extends Error {
  constructor(readonly userOpHash: `0x${string}`) {
    super(
      `refusing to broadcast ${userOpHash}: the durable pre-broadcast row could not be written, ` +
        `so nothing would be able to reconcile this operation. Nothing was sent.`,
    );
    this.name = "NotRecorded";
  }
}

/**
 * Refused BEFORE broadcast, on gas grounds. Nothing was signed and nothing
 * spent, so this is a sibling of a policy rejection rather than of a revert —
 * index.ts must not book it as an on-chain failure.
 */
export class GasRefused extends Error {
  constructor(readonly rule: string, detail: string) {
    super(`gas refused (${rule}): ${detail}`);
    this.name = "GasRefused";
  }
}

/** How many times the RECEIPT is re-read. Never the send — see execute(). */
const RECEIPT_ATTEMPTS = 3;

export interface ExecuteHooks {
  /**
   * Called with the hash BEFORE the operation is broadcast, and awaited.
   *
   * IT USED TO RUN AFTER THE SEND, and moving it is what makes the guarantee
   * real rather than nearly-real. A userOpHash is a pure function of the packed
   * operation, the EntryPoint and the chain id, so it is knowable before anyone
   * is asked to accept it — which means the durable row can exist before the
   * operation does, and every window after this point has something to attach
   * itself to.
   *
   * A THROW FROM THIS HOOK NOW REFUSES TO BROADCAST. That is the whole benefit
   * of the new ordering, and the caller is expected to use it: an operation
   * whose row could not be written is an operation nothing can ever reconcile,
   * so not sending it is strictly better than sending it blind. Nothing has been
   * signed to the network at that point and nothing is spent.
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
  /**
   * Who pays the gas. Absent means the account self-pays from its own ETH,
   * which is what every agent did before sponsorship existed and what a
   * self-hosted owner still does unless they wire their own.
   */
  sponsor?: Sponsor;
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

  // WHO PAYS, and nothing else. A paymaster settles with the EntryPoint
  // directly, so the account never handles ETH and every `valueLimit: 0n` in
  // the wall is untouched. A sponsored operation faces exactly the policies an
  // unsponsored one does; only the payer changes.
  const client = createKernelAccountClient({
    account,
    chain: opts.chain,
    bundlerTransport: http(opts.bundlerUrl),
    ...(opts.sponsor
      ? { paymaster: opts.sponsor.paymaster, paymasterContext: opts.sponsor.paymasterContext }
      : {}),
    // Without this the SDK calls the ZeroDev-only `zd_getUserOperationGasPrice`,
    // which Pimlico/Alchemy/self-hosted bundlers reject — see worker/src/gas.ts.
    userOperation: userOpGasConfig(publicClient, opts.bundlerUrl),
  });

  /**
   * Has this account ever operated?
   *
   * Asked here rather than passed in, because the answer CHANGES and the caller
   * reads it once at arm: an `accountDeployed: false` threaded down from arm
   * time would still say false for every later op of that arm, leaving them all
   * under the wide deploy ceiling. That is a guard turning itself off silently.
   *
   * One read, memoised, and only on the first execute of a process that has an
   * executor at all. A FAILED READ ANSWERS "not deployed", which is the safe
   * direction here and the opposite of the rule elsewhere in this repo: being
   * wrong that way widens a pre-sign ceiling for one operation, while being
   * wrong the other way refuses the operation outright. The bound still holds —
   * DEPLOY_GAS_BOUNDS is a ceiling, not an exemption.
   */
  let deployed: boolean | null = null;
  const isDeployed = async (): Promise<boolean> => {
    if (deployed !== null) return deployed;
    try {
      const code = await publicClient.getCode({ address: account.address });
      deployed = code !== undefined && code !== "0x";
    } catch {
      deployed = false;
    }
    return deployed;
  };

  return {
    address: account.address,
    async execute(calls: Call[], hooks?: ExecuteHooks) {
      const callData = await account.encodeCalls(calls);

      // ── BOUND THE GAS BEFORE SIGNING ANYTHING ───────────────────────
      // Estimating ourselves is not optional here: viem's prepareUserOperation
      // fills each field only when it is undefined, and skips the bundler
      // estimate entirely once all three are set — so the only way to bound a
      // limit is to have a number of our own first. See gas-limits.ts for why a
      // floor matters at all (an under-estimated callGasLimit does not bounce;
      // it OOGs inside the EntryPoint and the account pays anyway).
      //
      // TWO estimates of the same calldata. The second is the disagreement
      // probe, and it is the only signal available for "this number is not
      // trustworthy" without knowing what the calldata should cost. It costs one
      // round trip against an operation that is about to spend real money.
      // Kept outside the closure so a refusal can carry what the bundler said.
      let estimateError = "";
      const estimate = async (): Promise<UserOpGas | null> => {
        try {
          const g = (await client.estimateUserOperationGas({
            callData,
            // Estimate the operation we will actually SEND. An unsponsored probe
            // of a sponsored op omits the paymaster's own verification and postOp
            // gas, so the three limits we bound would be measured against a
            // different operation than the one that gets signed.
            ...(opts.sponsor ? { paymaster: opts.sponsor.estimateOnly } : {}),
          })) as Partial<UserOpGas>;
          if (
            typeof g.callGasLimit !== "bigint" ||
            typeof g.verificationGasLimit !== "bigint" ||
            typeof g.preVerificationGas !== "bigint"
          ) {
            return null;
          }
          return {
            callGasLimit: g.callGasLimit,
            verificationGasLimit: g.verificationGasLimit,
            preVerificationGas: g.preVerificationGas,
          };
        } catch (e) {
          // A refusal to quote, NOT a quote of zero — boundGas is told null and
          // says so in its own words.
          //
          // BUT KEEP THE REASON. Before this file existed, a failing estimate
          // happened INSIDE prepareUserOperation and its error propagated with
          // the AA code and revert reason attached — reaching the owner as
          // `couldn't submit: <the actual cause>`. Moving the estimate one
          // layer earlier and swallowing it here would collapse AA21 (account
          // underfunded), AA23 (the wall refused the call), a simulation
          // revert, a 429 and a bundler outage into one sentence that names
          // none of them — on the single most likely outcome of a first op.
          // A SPONSOR REFUSAL IS NOT AN UNREADABLE ESTIMATE. This catch exists to
          // keep a bundler's diagnosis, and it would otherwise swallow
          // SponsorRefused into `estimateError` — so a drained or declining
          // sponsor would book as `gas-unreadable` and the typed vocabulary this
          // whole class exists for would never fire on its most likely path.
          if (e instanceof SponsorRefused) throw e;
          estimateError = e instanceof Error ? e.message : String(e);
          return null;
        }
      };
      const first = await estimate();
      // Only probe a second time when the first succeeded: a null first is
      // already a refusal, and asking again would just be slower.
      const second = first ? await estimate() : null;
      // WHICH CEILING APPLIES DEPENDS ON WHETHER THIS ACCOUNT EXISTS YET.
      // See DEPLOY_GAS_BOUNDS: the first op also deploys the account and enables
      // the permission validator, and the steady-state ceiling would refuse it.
      const bounded = boundGas(first, second, (await isDeployed()) ? GAS_BOUNDS : DEPLOY_GAS_BOUNDS);
      if (!bounded.ok) {
        // BEFORE the send, so nothing is spent and no 'submitted' row exists.
        // This is a pre-broadcast rejection in the same shape as a policy one.
        throw new GasRefused(
          bounded.rule,
          // The bundler's own words first when we have them — they are the
          // diagnosis; ours is the policy.
          estimateError ? `${estimateError} — ${bounded.detail}` : bounded.detail,
        );
      }

      // ── PREPARE, SIGN, HASH, PERSIST, *THEN* SEND ───────────────────
      //
      // THE HASH EXISTS BEFORE THE NETWORK DOES, and that ordering is the whole
      // point of this block. It used to be one `sendUserOperation` with no
      // try/catch, and `onSubmitted` fired after it returned — so a throw at the
      // send edge produced three wrong answers at once in index.ts's generic
      // catch: the budget was released, the row was written `reverted` (a claim
      // about a chain that never saw the operation), and no hash was stored. The
      // last one is the worst: `resolveStrandedOps` selects on
      // `status='submitted' AND user_op_hash IS NOT NULL`, so the op was
      // structurally unfindable by the sweep built to find it.
      //
      // And the failure that motivates it is not the tidy one. If the send lands
      // on the wire but the RESPONSE is lost — a socket reset, a proxy 502, a
      // client timeout after the bundler already accepted — then an operation is
      // in flight, spending real money, with no record anywhere.
      //
      // Reimplemented from Vex's staged broadcast (permission on record from its
      // author), which computes keccak256 of the signed transaction locally and
      // persists it before `sendRawTransaction`. The 4337 analogue is exact: a
      // userOpHash is a pure function of the packed operation, the EntryPoint and
      // the chain id, so it can be known before anyone is asked to accept it.
      //
      // Sending the SAME object back through sendUserOperation is idempotent by
      // construction, not by luck: viem's prepareUserOperation returns an
      // explicit nonce, fees and factory unchanged, and sendUserOperation uses
      // `parameters.signature ||` so a signed operation is never re-signed. It
      // also issues the RPC with retryCount: 0, so the send is never repeated.
      const prepared = (await client.prepareUserOperation({
        callData,
        // Explicit, so prepareUserOperation uses these instead of estimating.
        ...bounded.gas,
      } as never)) as Record<string, unknown>;

      // THE LIMITS WE SIGNED MUST BE THE LIMITS WE BOUNDED. viem spreads the
      // paymaster's reply OVER the prepared request, so a sponsor that returned
      // callGasLimit would replace boundGas's number with no error and no log —
      // and under sponsorship the payer of an out-of-gas is the house. The
      // allowlist in paymaster.ts stops our wrappers propagating that; this
      // proves it stayed stopped, against the operation about to be signed.
      //
      // It now runs against the operation we are ABOUT to send rather than a
      // second preparation of it, which is strictly the stronger claim.
      if (opts.sponsor) assertBoundsHeld(bounded.gas, prepared);

      const signature = await account.signUserOperation(prepared as never);
      const signed = { ...prepared, signature };
      const userOpHash = getUserOperationHash({
        chainId: opts.chain.id,
        entryPointAddress: entryPoint.address,
        entryPointVersion: entryPoint.version,
        userOperation: signed as never,
      });

      // DURABLE BEFORE BROADCAST. From here on, every outcome — accepted,
      // refused, or never answered — has a row to attach itself to.
      if (hooks?.onSubmitted) await hooks.onSubmitted(userOpHash);

      let accepted: `0x${string}`;
      try {
        accepted = await client.sendUserOperation(signed as never);
      } catch (err) {
        // NOT A REVERT. Nothing on-chain has said anything. We asked, and we do
        // not know whether the ask arrived — which is precisely the state
        // UserOpUnresolved names, and which index.ts already handles correctly:
        // it holds the budget charged, leaves the row 'submitted', and warns
        // with the hash so the resolver can pick it up. NEVER re-send.
        throw new UserOpUnresolved(userOpHash, err instanceof Error ? err.message : String(err));
      }
      // Whatever happens to this op from here — landed, reverted, unresolved —
      // the bundler accepted it, so the account is deployed or is being deployed
      // by it. The wide deploy ceiling has done its job and must not apply to the
      // next one; a stale `false` would leave every op of this arm loosely
      // bounded, which is the guard quietly turning itself off.
      deployed = true;

      // Both sides derive this from the same bytes by the same rule, so a
      // difference is a defect in one of the two implementations rather than a
      // condition of the network. Treated as UNRESOLVED rather than swallowed:
      // the operation is genuinely in flight, and we no longer know which hash
      // the chain will index it under, which is the definition of the state.
      if (accepted.toLowerCase() !== userOpHash.toLowerCase()) {
        throw new UserOpUnresolved(
          userOpHash,
          `the bundler indexed this operation as ${accepted}, not the hash it was signed under. ` +
            `It IS in flight; which hash resolves it is now unknown.`,
        );
      }
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
