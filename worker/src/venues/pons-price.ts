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
 *   how much of it your own trade would move. Depth and impact, not divergence.
 *
 * The maths is pure and lives apart from the RPC so it can be tested against
 * figures read off mainnet — the same discipline fills.ts uses.
 */

/** Reserves as the curve reports them, plus what it is denominated in. */
export interface CurveReserves {
  /** Reserve of the QUOTE asset (what you pay with), raw units. */
  quoteRaw: bigint;
  /** Reserve of the launched token, raw units. */
  tokenRaw: bigint;
  quoteDecimals: number;
  tokenDecimals: number;
}

export interface CurvePrice {
  /** USD per whole token, 8dp — the same convention as every other PriceQuote. */
  price8: bigint;
  /**
   * USD value of the QUOTE side of the curve.
   *
   * This is the honest depth figure: it is what is actually there to sell into.
   * The token side is not liquidity — it is inventory the curve mints, and
   * counting it would make an empty curve look bottomless.
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
  // Kept as one integer expression so the division happens once, at the end:
  // dividing early here throws away every significant digit, because a
  // memecoin's price is ~1e-9 of the quote asset and the intermediate is
  // exactly where that precision lives.
  const price8 =
    (r.quoteRaw * 10n ** BigInt(r.tokenDecimals) * quoteUsd8) /
    (r.tokenRaw * 10n ** BigInt(r.quoteDecimals));

  // Depth is the quote side valued in USD, at 8dp to match price8.
  const depthUsd8 = (r.quoteRaw * quoteUsd8) / 10n ** BigInt(r.quoteDecimals);

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
 * How far along the curve is toward graduating to a Uniswap pool, 0..1.
 *
 * Pons graduates at a fixed amount of the quote asset raised (4.2 ETH on the
 * ETH-quoted curves). Worth surfacing because the two sides of graduation are
 * different products: before it, the curve is the only venue and this module
 * prices it; after it, the token is an ordinary v4 pool and the normal pricer
 * takes over. A position held across that boundary changes venue underneath.
 */
export function graduationProgress(quoteRaw: bigint, thresholdRaw: bigint): number | null {
  if (thresholdRaw <= 0n || quoteRaw < 0n) return null;
  const pct = Number((quoteRaw * 10_000n) / thresholdRaw) / 10_000;
  return pct > 1 ? 1 : pct;
}
