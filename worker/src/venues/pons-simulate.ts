/**
 * Running a curve trade for real, against the real chain, for nothing.
 *
 * WHY THIS EXISTS. The agent has never landed a live trade of any kind, and a
 * bonding curve is a poor place to discover that something upstream is broken.
 * This chain's RPC supports `eth_simulateV1` with state overrides, which means
 * the EXACT two calls `buildCurveTradeCalls` emits can be replayed against a
 * LIVE curve, at the current block, with the adapter's compiled bytecode
 * injected at an address nobody has deployed to — and it costs nothing.
 *
 * WHAT THAT ACTUALLY PROVES, which is most of what a first live trade would:
 * the calldata encodes as the wall expects, the adapter's direction derivation
 * agrees with the curve's own `token()`/`pairToken()`, the graduated check
 * fires or does not, the approve is sufficient, the curve accepts the call, the
 * balance-measured output floor behaves, the residue sweep leaves nothing, and
 * the amount that comes back is the amount the curve would really pay. It also
 * measures the fee, which is how the 100bps-per-side figure was established.
 *
 * WHAT IT DOES NOT PROVE, and must never be reported as proving: that the
 * account's session key can make this call. The wall is enforced by the Kernel
 * account against a signed permission, and a simulation runs as a plain `from`
 * address with no validator in the path. A trade that simulates perfectly can
 * still be refused on-chain by a grant that does not carry the permission —
 * that is what `grantPonsAdapter` and the arm-time liveness check are for.
 *
 * THE HONEST USE. A simulated `amountOut` is a MEASUREMENT, not a model. Paper
 * mode's ordinary fill is derived from `price8`, which for a curve is wrong in
 * three independent directions — it carries no fee, it prices off a reserve
 * that is ~60% virtual seed with no impact term, and it assumes the cash leg is
 * USDG when 42.8% of curves are quoted in a stock token. Filling paper from
 * this instead is the difference between a simulated tape and a fabricated one.
 */
import type { PublicClient } from "viem";
import { decodeFunctionResult } from "viem";
import { PONS_SELFTRADE_ABI } from "../../../packages/core/src/index";
import type { Call } from "../executor";

/** Where the adapter's code is injected when nothing is deployed yet. */
export const SIM_ADAPTER_ADDRESS = "0x00000000000000000000000000000000506f6e73" as const;

export type CurveSimResult =
  | { ok: true; amountOut: bigint; gasUsed: bigint }
  | { ok: false; reason: string };

/**
 * Replay a curve trade against the live chain without sending anything.
 *
 * `adapterCode` is the compiled runtime bytecode. Passing it in rather than
 * reading an artifact keeps this file free of build-layout knowledge and lets a
 * caller simulate against a DEPLOYED adapter instead simply by omitting it.
 *
 * Returns a refusal rather than throwing on every failure path, including a
 * revert: a simulation that says "this would revert, and here is the selector"
 * is a useful answer, and the caller is a tick that must not be taken down by a
 * probe.
 */
export async function simulateCurveTrade(opts: {
  client: PublicClient;
  /** The account the calls run as — the smart account in production. */
  account: `0x${string}`;
  /** Exactly what buildCurveTradeCalls returned. Order matters: approve, then trade. */
  calls: readonly Call[];
  /** Runtime bytecode to inject at `adapter`. Omit to simulate a deployed one. */
  adapterCode?: `0x${string}`;
  /** Where the adapter lives (or is injected). */
  adapter?: `0x${string}`;
}): Promise<CurveSimResult> {
  const adapter = opts.adapter ?? SIM_ADAPTER_ADDRESS;
  if (opts.calls.length !== 2) {
    return { ok: false, reason: `expected an approve and a trade, got ${opts.calls.length} calls` };
  }
  try {
    const stateOverrides: Record<string, { code?: `0x${string}` }> = {};
    if (opts.adapterCode) stateOverrides[adapter] = { code: opts.adapterCode };

    const res = (await opts.client.request({
      method: "eth_simulateV1",
      params: [
        {
          blockStateCalls: [
            {
              // Both calls run in ONE simulated block, in order, with state
              // carrying from the first to the second. That is the whole point:
              // the approve has to be visible to the trade, exactly as it would
              // be inside one UserOp.
              calls: opts.calls.map((c) => ({
                from: opts.account,
                to: c.to,
                data: c.data,
                value: `0x${c.value.toString(16)}`,
              })),
              ...(Object.keys(stateOverrides).length ? { stateOverrides } : {}),
            },
          ],
          // Ask for logs: they are how a caller can tell what the curve
          // actually did, rather than only what it returned.
          traceTransfers: false,
          validation: false,
        },
        "latest",
      ],
    } as never)) as { calls: { status: string; returnData: string; gasUsed: string; error?: { message: string } }[] }[];

    const block = res?.[0];
    if (!block || !Array.isArray(block.calls) || block.calls.length !== 2) {
      return { ok: false, reason: "the node returned a shape this code does not understand" };
    }
    const [approve, trade] = block.calls;
    if (approve!.status !== "0x1") {
      return { ok: false, reason: `the approve reverted: ${approve!.error?.message ?? "no reason given"}` };
    }
    if (trade!.status !== "0x1") {
      // The selector is the useful part — the adapter's errors are named, so a
      // caller can tell "this curve graduated" from "not enough came back".
      const sel = trade!.returnData?.slice(0, 10) ?? "";
      return { ok: false, reason: `the trade reverted${sel ? ` (${sel})` : ""}: ${trade!.error?.message ?? ""}`.trim() };
    }
    const amountOut = decodeFunctionResult({
      abi: PONS_SELFTRADE_ABI,
      functionName: "tradeExactIn",
      data: trade!.returnData as `0x${string}`,
    }) as bigint;
    return { ok: true, amountOut, gasUsed: BigInt(trade!.gasUsed) };
  } catch (e) {
    // A node that does not support eth_simulateV1 lands here. That is a
    // refusal, not a crash: the probe is an improvement on a fabricated fill,
    // never a dependency of the tick.
    return { ok: false, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}

/**
 * What the simulation says a trade really costs, in bps against the mid.
 *
 * The number the whole venue decision turns on. A curve charges its fee inside
 * the trade rather than as a separate line, so the only honest way to see it is
 * to compare what a simulated trade returns against what the reserves say a
 * frictionless one would.
 */
export function simulatedCostBps(args: { amountOut: bigint; frictionlessOut: bigint }): number | null {
  if (args.frictionlessOut <= 0n || args.amountOut < 0n) return null;
  const diff = args.frictionlessOut - args.amountOut;
  return Number((diff * 10_000n) / args.frictionlessOut);
}
