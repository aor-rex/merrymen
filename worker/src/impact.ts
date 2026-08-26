/**
 * WHAT THE POOL CHARGES YOU FOR YOUR OWN SIZE.
 *
 * A quote that exists is not a quote worth taking. Until this existed, the only
 * thing between a $5,000 order and a $4,000 pool was `minOut` — and minOut is
 * derived FROM the quote, so a fill forty percent through the book got a floor
 * one percent below its own forty percent and executed happily. minOut defends
 * against the price moving between the quote and the fill. Nothing defended
 * against the quote itself.
 *
 * The header of venues/uniswap.ts claimed a terrible quote "is skipped by the
 * impact guard upstream". There was no such guard, anywhere in the repo. This
 * is it, and that comment now points here.
 *
 * MEASURED FROM TWO QUOTES ON THE SAME ROUTE, not from the depth map.
 * venues/depth.ts can compute this exactly — its own header says its ladder
 * reproduces QuoterV2 to 0.0000% — but the depth read is up to five minutes
 * old, covers ONE pool where the router fills across several tiers, is
 * quantised to a 50bps band, and is simply absent for every token with no
 * direct USDG pair, which is most of the memecoins this guard exists for.
 * The quoter is fresh, whole-route, exact, and already being called. Given two
 * methods that agree to 0.0000%, take the one that is about to execute.
 *
 * That choice also keeps this clear of the propose/dispose line that
 * venues/depth.invariant.test.ts pins. This module consumes no depth data and
 * adds no input to checkPolicy. Its inputs are two QuoterV2 answers about the
 * identical route this trade is about to take. The invariant's fear is an
 * attacker flooding a pool so the agent SIZES UP; here, adding liquidity can
 * only lower measured impact toward passing — toward the fill the agent would
 * have got anyway. This guard can only ever refuse. It can never permit more.
 *
 * THE ARITHMETIC. Impact is how much worse the AVERAGE execution price of this
 * size is than the MARGINAL price of the same route:
 *
 *   impactBps = 10_000 − (amountOut × probeIn × 10_000) / (probeOut × amountIn)
 *
 * Both quotes pay the same proportional pool fee, so the FEE CANCELS and what
 * is left is impact alone. That is why the default does not have to be inflated
 * to absorb a 1% fee tier, and why the same threshold means the same thing on a
 * 5bps pool and a 10000bps one.
 *
 * KNOWN BIAS, stated rather than buried: the probe sits at 1% of the order
 * rather than at zero, so this measures (dx − probe)/(x + dx) where the true
 * figure is dx/(x + dx) — an understatement of about 1%. Checked against
 * closed-form constant-product math in impact.test.ts. At a 300bps cap the
 * guard really admits up to ~303bps. Probing smaller would close the gap and
 * lose more to integer rounding on a 6dp token, which is the worse trade.
 *
 * An oracle comparison (quote vs. lastPrices) was considered and rejected: it
 * conflates the pool's persistent premium or discount to Chainlink with impact,
 * and it is unavailable for exactly the unpriceable scout tokens that need this
 * most. QuoterV2's `sqrtPriceX96After` was considered too: it measures the END
 * price move rather than average execution cost, and does not compose across a
 * multi-hop path or v4. The two-quote ratio composes uniformly across v3
 * single-hop, v3 multi-hop and v4.
 */

/**
 * The probe is 1% of the order, floored — small enough that its own impact is
 * negligible, large enough not to vanish into rounding on a 6dp token.
 */
export const PROBE_FRACTION = 100n;
/** 0.01 USDG at 6dp. Below this a quote is mostly rounding error. */
export const MIN_PROBE_IN = 10_000n;

/**
 * The probe size for an order, or null when the order is too small to measure.
 *
 * NULL, NOT `amountIn`. Returning the full amount would make probeOut equal
 * amountOut and yield exactly 0 impact — a trade whose impact was never
 * measured, reported as a trade with no impact. That is "unknown represented as
 * zero", the one thing this codebase does not do. A trade too small to probe is
 * also too small for impact to matter, but the caller decides that, not this.
 */
export function probeAmountIn(amountIn: bigint): bigint | null {
  if (amountIn <= 0n) return null;
  const probe = amountIn / PROBE_FRACTION;
  if (probe >= MIN_PROBE_IN) return probe;
  // The order itself is under ~1 USDG-equivalent: there is no probe that is
  // both meaningfully smaller than it and above the rounding floor.
  if (amountIn <= MIN_PROBE_IN) return null;
  return MIN_PROBE_IN;
}

/**
 * Price impact in basis points, or null when it cannot be measured.
 *
 * Negative results are clamped to 0: a probe can quote infinitesimally worse
 * than the full order through tick rounding, and reporting "-3 bps of impact"
 * would be noise dressed as a discount.
 */
export function impactBps(args: {
  amountIn: bigint;
  amountOut: bigint;
  probeIn: bigint;
  probeOut: bigint;
}): number | null {
  const { amountIn, amountOut, probeIn, probeOut } = args;
  // Any degenerate input is UNKNOWN, never zero. A zero probeOut in particular
  // means the probe found no liquidity at all, which is the opposite of "no
  // impact" and would be catastrophic to read as such.
  if (amountIn <= 0n || probeIn <= 0n || probeOut <= 0n || amountOut < 0n) return null;
  if (probeIn >= amountIn) return null; // no leverage between the two sizes
  // ratio = (amountOut/amountIn) ÷ (probeOut/probeIn), in bps, integer-only.
  const ratioBps = (amountOut * probeIn * 10_000n) / (probeOut * amountIn);
  const bps = 10_000n - ratioBps;
  if (bps <= 0n) return 0;
  // A ratio worse than 100% is not meaningful; cap so callers can format it.
  return Number(bps > 10_000n ? 10_000n : bps);
}

export type ImpactVerdict =
  | { ok: true; bps: number | null; note?: string }
  | { ok: false; rule: "impact-cap" | "impact-unknown"; bps: number | null; detail: string };

/**
 * Should this trade proceed?
 *
 * DIRECTION DECIDES WHAT UNKNOWN MEANS, which is the whole design.
 *
 * A BUY is discretionary. Skipping one costs a tick, so an unmeasurable buy is
 * refused: entering a position at a price nobody could verify is exactly the
 * risk this exists for.
 *
 * An EXIT is not discretionary, and is NEVER refused — not on a bad number and
 * not on a missing one. Money coming home is never blocked. Refusing an
 * expensive sell is how you hold a rug forever, and it is the same trap the
 * drawdown breaker had until exits were exempted from it. The number is still
 * measured and still reported when it is ugly, so the tape shows what the exit
 * cost; it just does not get a veto.
 */
export function judgeImpact(args: {
  bps: number | null;
  maxBps: number;
  /** True when this trade is getting OUT — see above. */
  isExit: boolean;
}): ImpactVerdict {
  const { bps, maxBps, isExit } = args;
  // A cap of 0 or less is how an owner turns the guard off entirely.
  if (maxBps <= 0) return { ok: true, bps, note: "impact guard disabled" };

  if (bps === null) {
    if (isExit) return { ok: true, bps: null, note: "impact unknown — exits are never blocked on it" };
    return {
      ok: false,
      rule: "impact-unknown",
      bps: null,
      detail:
        "couldn't measure what this pool would charge for this size, so the buy was skipped. " +
        "Unknown impact is not zero impact.",
    };
  }

  if (bps > maxBps) {
    if (isExit) {
      return {
        ok: true,
        bps,
        note: `costly exit: ${(bps / 100).toFixed(2)}% impact, above the ${(maxBps / 100).toFixed(2)}% cap — allowed anyway, because getting out is never blocked`,
      };
    }
    return {
      ok: false,
      rule: "impact-cap",
      bps,
      detail:
        `this size would move the pool ${(bps / 100).toFixed(2)}%, over the ${(maxBps / 100).toFixed(2)}% cap. ` +
        "Trade smaller, or raise maxImpactBps if you meant it.",
    };
  }

  return { ok: true, bps };
}
