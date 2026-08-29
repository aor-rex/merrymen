/**
 * Pricing a Pons bonding-curve token.
 *
 * WHY THIS CANNOT REUSE THE POOL PRICER. Every existing price path assumes a
 * Uniswap pool with an observation oracle behind it: `poolPriceUsable`
 * (venues/pool-price.ts) refuses with `no-twap` BEFORE it looks at depth or
 * divergence, because its whole safety model is "does spot agree with a
 * time-weighted average". A bonding curve has no observations to average, so
 * every curve token is structurally unpriceable there — which is why they show
 * as `priceable: false` and trencher's entry gate refuses them.
 *
 * The fix is NOT to synthesise a TWAP to get past that check. That would
 * launder an unguarded number through a guard designed for something else, and
 * the guard would then report a confidence it does not have. A curve needs its
 * own safety model, and this module says plainly what that model is:
 *
 *   DEPTH IS THE GUARD. A constant-product curve's price is an exact function
 *   of its reserves — there is no oracle to disagree with and nothing to
 *   manipulate through a stale window. What CAN hurt you is size: the reserve
 *   is the entire market, so what matters is how much is really in there and
 *   how much of it your own trade would move.
 *
 * THE VIRTUAL SEED, AND THE BUG IT CAUSED HERE. Pons opens every curve with a
 * VIRTUAL quote reserve of exactly 40% of that curve's graduation threshold —
 * 1.68 ETH on a 4.2 ETH curve — while the contract holds none of the quote
 * asset at all. Verified on mainnet: fresh curves report `quoteReserve /
 * graduationThreshold() == 0.400000` with an on-chain balance of zero, and
 * where there IS real money, `r0 - 0.4 x threshold` matches the balance held
 * (0.0147 computed against 0.015 actual).
 *
 * The first version of this module reported that seed as depth. It would have
 * told the owner a curve holding $0 had $4,106 to sell into — on the very
 * figure the safety model rests on, and off by however much money was not
 * there. The module had already caught this exact hazard on the token side
 * ("the token side is not liquidity — it is inventory the curve mints") and
 * then made the same mistake on the quote side one field down.
 *
 * WHAT THE SEED DOES AND DOES NOT AFFECT. The constant product genuinely uses
 * the full reserve INCLUDING the seed — verified exact to 1 wei against real
 * buys — so spot price and price impact are correct computed from `quoteRaw`
 * and must not be "fixed". Only figures that claim something about REAL MONEY
 * — depth, and progress toward graduation — subtract it.
 *
 * The maths is pure and lives apart from the RPC so it can be tested against
 * figures read off mainnet — the same discipline fills.ts uses.
 */

/**
 * Reserves as the curve reports them, plus what it takes to interpret them.
 *
 * `graduationThresholdRaw` is not optional, and that is deliberate: without it
 * the virtual seed cannot be subtracted, and every depth figure computed from
 * these reserves would be the fiction described above. Making it a required
 * field means no caller can accidentally ask for a depth this module cannot
 * honestly give. It is free to obtain — data word 2 of the launch event, and
 * `graduationThreshold()` on the curve agrees with it 18/18 across quote assets.
 */
export interface CurveReserves {
  /**
   * Reserve of the QUOTE asset as getReserves() reports it, raw units.
   *
   * INCLUDES the virtual seed. Correct for pricing, wrong for depth — see the
   * header. Use `realQuoteRaw` for anything that asserts money exists.
   */
  quoteRaw: bigint;
  /** Reserve of the launched token, raw units. */
  tokenRaw: bigint;
  quoteDecimals: number;
  tokenDecimals: number;
  /** The curve's own graduation threshold, raw quote units. */
  graduationThresholdRaw: bigint;
}

/**
 * The seed is 40% of the graduation threshold, as a fraction in basis points.
 *
 * Measured, not documented: across 2,000 sampled curves, 63.1% sit within 5 wei
 * of exactly 0.4 x threshold, 76.0% at or below it, and NOT ONE below — which is
 * what makes the subtraction below safe to floor at zero.
 */
export const VIRTUAL_SEED_BPS = 4_000n;

/** The quote reserve a curve reports before anyone has bought anything. */
export function virtualSeedRaw(graduationThresholdRaw: bigint): bigint {
  if (graduationThresholdRaw <= 0n) return 0n;
  return (graduationThresholdRaw * VIRTUAL_SEED_BPS) / 10_000n;
}

/**
 * The quote asset actually raised — what is really there to sell into.
 *
 * Saturates at zero rather than going negative. No sampled curve reads below
 * the seed, so a negative result would mean the seed model is wrong for that
 * curve, and in that case reporting "nothing" is the honest answer rather than
 * a negative depth that would compare as less than every floor.
 */
export function realQuoteRaw(r: CurveReserves): bigint {
  const real = r.quoteRaw - virtualSeedRaw(r.graduationThresholdRaw);
  return real > 0n ? real : 0n;
}

export interface CurvePrice {
  /** USD per whole token, 8dp — the same convention as every other PriceQuote. */
  price8: bigint;
  /**
   * USD value of the REAL quote raised, 8dp. Zero for a curve nobody has bought.
   *
   * This is the honest depth figure twice over: it excludes the virtual seed,
   * which is not money, and it excludes the token side, which is inventory the
   * curve mints rather than anything to sell into.
   *
   * NOTE THE UNITS. This is 8dp, while every existing depth guard in the worker
   * (`PriceGuard.minLiquidityUsdg`, `cfg.minPoolLiquidityUsdg`) is 6dp USDG.
   * Comparing the two directly makes a $250 curve clear a $25,000 floor.
   */
  depthUsd8: bigint;
}

/**
 * Price a curve from its reserves and the USD price of its quote asset.
 *
 * Returns null rather than a zero when the curve cannot be priced — an empty
 * side, or a quote asset we have no USD price for. A zero price is not a
 * cheaper token, it is a missing fact, and downstream code values positions
 * with this.
 */
export function curvePrice(r: CurveReserves, quoteUsd8: bigint): CurvePrice | null {
  if (r.quoteRaw <= 0n || r.tokenRaw <= 0n || quoteUsd8 <= 0n) return null;
  if (r.quoteDecimals < 0 || r.tokenDecimals < 0) return null;

  // price_usd = (quoteRaw / 10^qd) / (tokenRaw / 10^td) * quoteUsd
  //
  // The FULL reserve, seed included — the curve's constant product really does
  // use it, verified to 1 wei against observed buys, so this is the price a
  // trade would actually get. Subtracting the seed here would produce a number
  // no trade could ever execute at.
  //
  // Kept as one integer expression so the division happens once, at the end:
  // dividing early throws away every significant digit, because a memecoin's
  // price is ~1e-9 of the quote asset and the intermediate is exactly where
  // that precision lives.
  const price8 =
    (r.quoteRaw * 10n ** BigInt(r.tokenDecimals) * quoteUsd8) /
    (r.tokenRaw * 10n ** BigInt(r.quoteDecimals));

  // Depth is the REAL quote raised, valued in USD at 8dp to match price8.
  const depthUsd8 = (realQuoteRaw(r) * quoteUsd8) / 10n ** BigInt(r.quoteDecimals);

  // A curve so thin (or a token so numerous) that a whole token rounds to zero
  // at 8dp cannot be priced honestly at this precision. Say so instead of
  // returning a zero that reads as free.
  if (price8 <= 0n) return null;
  return { price8, depthUsd8 };
}

/**
 * What a buy of `quoteInRaw` would actually cost, as price impact in bps.
 *
 * On a constant-product curve this is exact rather than estimated: the reserves
 * ARE the market, so the post-trade price follows from x*y=k with no routing,
 * no other liquidity, and nothing to sample. That makes impact the natural size
 * guard here — the equivalent of the probe-requote the Uniswap path has to do
 * because it cannot see the whole book.
 *
 * Uses the FULL reserve including the virtual seed, because that is what the
 * curve itself uses. This is not an oversight and must not be "corrected": the
 * seed is what makes an early buy cost less than the empty pool it would
 * otherwise be, and pricing against the real reserve would overstate impact
 * enormously on exactly the curves the agent is most likely to look at.
 *
 * Returns null when the trade cannot be evaluated, never 0 — "unknown impact"
 * and "no impact" must not be the same value to a caller deciding whether to
 * spend money.
 */
export function curveBuyImpactBps(r: CurveReserves, quoteInRaw: bigint): number | null {
  if (r.quoteRaw <= 0n || r.tokenRaw <= 0n || quoteInRaw <= 0n) return null;
  // Constant product: tokensOut = tokenRaw - k/(quoteRaw + in)
  const k = r.quoteRaw * r.tokenRaw;
  const newQuote = r.quoteRaw + quoteInRaw;
  const newToken = k / newQuote;
  const tokensOut = r.tokenRaw - newToken;
  if (tokensOut <= 0n) return null;

  // Effective price paid vs the spot price before the trade, in bps. Scaled up
  // before dividing for the same precision reason as above.
  const SCALE = 1_000_000_000_000n;
  const spotScaled = (r.quoteRaw * SCALE) / r.tokenRaw;
  const paidScaled = (quoteInRaw * SCALE) / tokensOut;
  if (spotScaled <= 0n) return null;
  const bps = ((paidScaled - spotScaled) * 10_000n) / spotScaled;
  return Number(bps);
}

/**
 * Real quote raised as a fraction of this curve's own graduation threshold, 0..1.
 *
 * THE PRICE-FEED-FREE MEASURE, and the one worth building a filter on. Pons
 * curves are quoted in whatever the launcher chose — 53.6% native ETH, but 42.8%
 * in Robinhood STOCK TOKENS, plus cbBTC and USDG — and their thresholds are not
 * a constant USD value either (they range $7,737 to $10,377 at today's prices,
 * having been configured at different times and never repriced). So comparing
 * curves in USD needs a price for every quote asset, some of which have no
 * usable feed at all, and would still be comparing against a moving bar.
 *
 * A curve's progress along its OWN threshold needs no feed, is exact, and is
 * the thing Pons itself is measuring. It is directly predictive: against a base
 * graduation rate of 0.96%, curves that reach 25% of threshold graduate 18.2%
 * of the time.
 *
 * Clamped to 1. A graduated curve resets — token side to zero, quote side back
 * to the seed — so a LOW reading cannot distinguish "graduated" from "never
 * traded"; check `curveGraduated` before believing one.
 */
export function curveDepthFraction(r: CurveReserves): number | null {
  if (r.graduationThresholdRaw <= 0n) return null;
  const pct = Number((realQuoteRaw(r) * 10_000n) / r.graduationThresholdRaw) / 10_000;
  return pct > 1 ? 1 : pct;
}

/**
 * Has this curve already graduated to a Uniswap pool?
 *
 * Graduation drains the token side entirely and returns the quote side to the
 * virtual seed, so reserves alone read exactly like a brand-new empty curve.
 * That collision matters: the two are opposite situations — one has moved its
 * whole market to a pool the ordinary pricer can handle, the other has no
 * market at all — and a depth reading cannot tell them apart. The token side
 * can: only a graduated curve has none of its own token left.
 */
export function curveGraduated(r: CurveReserves): boolean {
  return r.tokenRaw === 0n;
}

/**
 * How far along the curve is toward graduating, 0..1 — an alias kept for the
 * meaning rather than the maths, since "progress" and "depth" are the same
 * quantity here expressed for different audiences.
 */
export const graduationProgress = curveDepthFraction;
