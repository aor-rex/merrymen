/**
 * Pricing a Uniswap v4 pool — the gap that stopped the agent trading memecoins.
 *
 * WHY THIS FILE EXISTS. Pons graduates a coin off its bonding curve into a
 * Uniswap **v4** pool, and v4 has no observation oracle: TWAP moved into hooks,
 * so a vanilla pool cannot be asked what its price was thirty minutes ago.
 * `readRoutedPrice` reads `observe()` and is therefore v3-only, so every
 * graduated coin came back unpriceable, `priceable` was false, and trencher
 * refused it before forming any judgement about the token. The agent could route
 * a v4 swap and execute one; it could not VALUE the thing it would be buying.
 *
 * THE SAFETY MODEL IS DIFFERENT, DELIBERATELY. `poolPriceUsable` rests on
 * spot-vs-TWAP divergence — a pool being pushed shows a spot that has run from
 * its own history. There is no history here, and synthesising a TWAP to satisfy
 * the existing guard would launder an unguarded price through a check built for
 * something else. `pons-price.ts` faced exactly this and refused; so does this.
 *
 * WHAT REPLACES IT, and this is the part measurement changed. The first draft
 * checked a round trip and forgave whatever the fee explained. Then 163 live
 * pools were sampled:
 *
 *     LP fee bps    min 0   p25 200   median 8633   p75 9450   max 9910
 *     over 100bps   76.1%     over 5000bps  66.9%
 *     at or under 100bps — 23.9%, and that is the entire tradeable set
 *
 * The median graduated pool charges **86% to trade through it**. Forgiving the
 * fee would have waved every one of them through, because a 98.8% round trip is
 * exactly what an 89% fee predicts. On this chain THE FEE IS THE RUG, so the fee
 * is a first-class refusal and not a term to be netted out.
 *
 * Three more things measurement settled:
 *   - The fee is DYNAMIC. Keys carry 0x800000 (LPFeeLibrary's flag) and the live
 *     rate is in slot0's `lpFee`. Reading key.fee literally yields 167,772 bps.
 *   - Keys cannot be guessed — see venues/v4-keys.ts. They are read from
 *     Initialize events and verified by hashing back to the poolId.
 *   - Most pools quote against NATIVE ETH (address(0)), not USDG and not WETH,
 *     so a USD price usually needs a second leg.
 *
 * What this does NOT claim: it is a SPOT price. It values a holding; it is not
 * oracle-grade evidence, and `source: "v4"` keeps that visible to the dashboard
 * and keeps the token inside the scout budget's reach.
 */

import type { PublicClient } from "viem";
import { CASH, UNISWAP } from "../../../packages/core/src/index";
import { cashDepthFromLiquidity, cashRawToUsdg, sqrtPriceX96ToPrice } from "./pool-price";
import { quoteV4, poolId, STATE_VIEW_ABI, type PoolKey } from "./uniswap-v4";
import { DYNAMIC_FEE_FLAG, quoteSideOf } from "./v4-keys";

/** v4 spells native ETH as address(0). It is not WETH and does not equal it. */
export const V4_NATIVE = "0x0000000000000000000000000000000000000000" as const;

export interface V4PoolState {
  key: PoolKey;
  id: `0x${string}`;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  /** The LIVE fee, hundredths of a bip, from slot0 — never `key.fee`. */
  lpFeeHundredthsBip: number;
}

/** What a v4 pool can honestly say about a token. */
export interface V4Price {
  /** USD per whole token, 8dp — SPOT. There is no TWAP here. */
  price8: bigint;
  /** In-range cash depth at the current price, USDG 6dp — same function as v3. */
  liquidityUsdg: bigint;
  /**
   * The pool's live LP fee in bps. THE headline risk on this chain: the median
   * graduated pool charges 8,633 of these.
   */
  feeBps: number;
  /** Gross round-trip loss in bps, measured through the quoter the trade uses. */
  roundTripBps: number;
  /** What the token is quoted in — usually native ETH, sometimes USDG. */
  quoteAsset: `0x${string}`;
  poolId: `0x${string}`;
  key: PoolKey;
}

export interface V4Guard {
  /** Refuse pools shallower than this (USDG, 6dp). */
  minLiquidityUsdg: bigint;
  /** Refuse a pool whose LP fee is extortionate. The primary memecoin filter. */
  maxFeeBps: number;
  /** Refuse when getting in and straight back out costs more than this, all-in. */
  maxRoundTripBps: number;
  /** How much cash to push through the quoter to measure the round trip. */
  probeUsdg: bigint;
}

/**
 * Defaults, and where each number comes from.
 *
 * `minLiquidityUsdg` matches the v3 `PriceGuard` default rather than inventing a
 * second floor — reusing `cashDepthFromLiquidity` is what lets one floor govern
 * both venues, so trencher's $25k keeps meaning what it already meant.
 *
 * `maxFeeBps` is 100. Not a taste: the measured distribution is bimodal — a
 * cluster at or under 100 bps (23.9%) and a cluster above 5,000 (66.9%), with
 * very little between. Anywhere in that gap separates the same two populations,
 * and 100 bps is the edge of the honest one. It is also the point past which the
 * repo's own cost floor stops making sense: at ~47 bps of existing cost, a 100
 * bps venue fee already doubles the price of being right.
 *
 * `maxRoundTripBps` is 400 — the fee twice at the cap, plus room for ordinary
 * impact at the probe size. It catches the asymmetric pool a fee check alone
 * would miss: one that charges little to enter and refuses to let you leave.
 *
 * `probeUsdg` is $100 — big enough not to be rounding noise on a token priced in
 * millionths, small enough not to be the thing moving the pool.
 */
export const V4_GUARD_DEFAULTS: V4Guard = {
  minLiquidityUsdg: 25_000_000_000n,
  maxFeeBps: 100,
  maxRoundTripBps: 400,
  probeUsdg: 100_000_000n,
};

export type V4RefusalKind = "no-price" | "too-thin" | "extortionate-fee" | "wide-round-trip";

/** The live fee in bps. Handles the dynamic flag by preferring slot0's value. */
export function liveFeeBps(keyFee: number, slot0LpFee: number): number {
  const raw = keyFee === DYNAMIC_FEE_FLAG ? slot0LpFee : (slot0LpFee > 0 ? slot0LpFee : keyFee);
  return Math.round(raw / 100);
}

/**
 * Round-trip loss in bps: what a probe loses going out and coming straight back.
 *
 * Null rather than 0 when nothing came back — "the pool would not quote the way
 * out" is the worst possible signal and must not be recorded as a costless trip.
 */
export function roundTripBps(sent: bigint, returned: bigint): number | null {
  if (sent <= 0n || returned <= 0n) return null;
  // More back than went in is not a windfall, it is a reading that does not mean
  // what we think. Clamp rather than report a gain.
  if (returned >= sent) return 0;
  return Number(((sent - returned) * 10_000n) / sent);
}

/**
 * Is this price safe to act on?
 *
 * Mirrors `poolPriceUsable`'s shape — `{ok} | {ok:false, kind, reason}` — so a
 * caller branches on one thing whichever venue answered, and every refusal names
 * a true reason instead of vanishing into a null.
 */
export function v4PriceUsable(
  p: Pick<V4Price, "price8" | "liquidityUsdg" | "feeBps" | "roundTripBps">,
  guard: V4Guard,
): { ok: true } | { ok: false; kind: V4RefusalKind; reason: string } {
  if (p.price8 <= 0n) {
    return { ok: false, kind: "no-price", reason: "the pool reported no usable price" };
  }
  // FEE FIRST. It is the most common disqualifier by a wide margin, and it is
  // the one a reader most needs named: "too thin" about an 86%-fee pool would
  // be true and beside the point.
  if (p.feeBps > guard.maxFeeBps) {
    return {
      ok: false,
      kind: "extortionate-fee",
      reason: `this pool charges ${(p.feeBps / 100).toFixed(2)}% a trade — ${p.feeBps}bps against a ${guard.maxFeeBps}bps ceiling. Two-thirds of graduated pools on this chain are built this way.`,
    };
  }
  if (p.liquidityUsdg < guard.minLiquidityUsdg) {
    return {
      ok: false,
      kind: "too-thin",
      reason: `pool too thin: $${(Number(p.liquidityUsdg) / 1e6).toFixed(0)} in range < $${Number(guard.minLiquidityUsdg) / 1e6} floor`,
    };
  }
  if (p.roundTripBps > guard.maxRoundTripBps) {
    return {
      ok: false,
      kind: "wide-round-trip",
      reason: `in and straight out costs ${p.roundTripBps}bps — more than the ${guard.maxRoundTripBps}bps this pool is allowed to cost`,
    };
  }
  return { ok: true };
}

/** Read slot0 + liquidity for a known key. Null when the pool is not initialized. */
export async function readV4PoolState(client: PublicClient, key: PoolKey): Promise<V4PoolState | null> {
  const id = poolId(key);
  try {
    const slot0 = (await client.readContract({
      address: UNISWAP.v4StateView as `0x${string}`,
      abi: STATE_VIEW_ABI,
      functionName: "getSlot0",
      args: [id],
    })) as readonly [bigint, number, number, number];
    if (slot0[0] === 0n) return null;
    const liquidity = (await client.readContract({
      address: UNISWAP.v4StateView as `0x${string}`,
      abi: STATE_VIEW_ABI,
      functionName: "getLiquidity",
      args: [id],
    })) as bigint;
    return {
      key,
      id,
      sqrtPriceX96: slot0[0],
      liquidity,
      lpFeeHundredthsBip: slot0[3],
    };
  } catch {
    return null;
  }
}

/**
 * Price a token from a KNOWN v4 pool key.
 *
 * `quoteUsd8` is what one whole unit of the pool's quote asset is worth in USD,
 * 8dp — $1e8 for USDG, the live ETH price for a native pool. It is a REQUIRED
 * input rather than something fetched here, because a wrong ETH price would
 * silently rescale every memecoin on the chain, and the caller already holds a
 * guarded one.
 */
export async function readV4PriceForKey(
  client: PublicClient,
  args: {
    token: `0x${string}`;
    tokenDecimals: number;
    key: PoolKey;
    quoteUsd8: bigint;
    quoteDecimals: number;
    probeUsdg?: bigint;
  },
): Promise<V4Price | null> {
  const probeUsdg = args.probeUsdg ?? V4_GUARD_DEFAULTS.probeUsdg;
  try {
    const state = await readV4PoolState(client, args.key);
    if (!state || state.liquidity <= 0n || args.quoteUsd8 <= 0n) return null;

    const tokenIsToken0 = args.key.currency0.toLowerCase() === args.token.toLowerCase();
    const quoteAsset = quoteSideOf(args.key, args.token);

    // Price in QUOTE units first, then into USD. Doing it in one step means
    // guessing a combined scale, which is how these land 1e12 out.
    const priceInQuote8 = sqrtPriceX96ToPrice({
      sqrtPriceX96: state.sqrtPriceX96,
      tokenIsToken0,
      tokenDecimals: args.tokenDecimals,
      cashDecimals: args.quoteDecimals,
      decimals: 8,
    });
    if (priceInQuote8 <= 0n) return null;
    const price8 = (priceInQuote8 * args.quoteUsd8) / 100_000_000n;

    // Depth at the current price from IN-RANGE liquidity — never the pool's
    // balance, which anyone can inflate with an out-of-range mint.
    const liquidityUsdg = cashRawToUsdg(
      cashDepthFromLiquidity({
        liquidity: state.liquidity,
        sqrtPriceX96: state.sqrtPriceX96,
        cashIsToken0: !tokenIsToken0,
      }),
      args.quoteDecimals,
      args.quoteUsd8,
    );

    // The round trip, through the same quoter the trade would use. The probe is
    // stated in USD, so convert it into the quote asset at its own price.
    const probeRawQuote =
      (probeUsdg * 10n ** BigInt(args.quoteDecimals) * 100_000_000n) / (args.quoteUsd8 * 1_000_000n);
    const out =
      probeRawQuote > 0n
        ? await quoteV4(client, { key: args.key, tokenIn: quoteAsset, amountIn: probeRawQuote })
        : null;
    const back = out
      ? await quoteV4(client, { key: args.key, tokenIn: args.token, amountIn: out.amountOut })
      : null;
    // A pool that will not quote the way out is not a pool to value. Report a
    // round trip that fails the guard rather than a null, which the caller would
    // read as "there is no v4 pool here" — a different fact.
    const trip = back ? (roundTripBps(probeRawQuote, back.amountOut) ?? 10_000) : 10_000;

    return {
      price8,
      liquidityUsdg,
      feeBps: liveFeeBps(args.key.fee, state.lpFeeHundredthsBip),
      roundTripBps: trip,
      quoteAsset,
      poolId: state.id,
      key: args.key,
    };
  } catch {
    return null;
  }
}

/**
 * Pick the pool a token should be valued from, among keys already learned.
 *
 * DEEPEST WINS, after the fee check — not "first that quotes". A token often has
 * several pools and the shallow one is exactly where a price can be pushed for
 * pocket change; the v3 router picks on depth for the same reason. Pools whose
 * fee already disqualifies them are dropped before depth is compared, so one
 * deep 90%-fee trap cannot hide a shallow honest pool from the caller's view.
 */
export async function readBestV4Price(
  client: PublicClient,
  args: {
    token: `0x${string}`;
    tokenDecimals: number;
    keys: readonly PoolKey[];
    /** USD per whole unit of each possible quote asset, 8dp, keyed lowercase. */
    quoteUsd8: Map<string, { usd8: bigint; decimals: number }>;
    guard?: V4Guard;
    probeUsdg?: bigint;
  },
): Promise<{ price: V4Price; usable: ReturnType<typeof v4PriceUsable> } | null> {
  const guard = args.guard ?? V4_GUARD_DEFAULTS;
  const priced: V4Price[] = [];
  for (const key of args.keys) {
    const quote = args.quoteUsd8.get(quoteSideOf(key, args.token).toLowerCase());
    if (!quote) continue; // we cannot price what the other side is worth
    const p = await readV4PriceForKey(client, {
      token: args.token,
      tokenDecimals: args.tokenDecimals,
      key,
      quoteUsd8: quote.usd8,
      quoteDecimals: quote.decimals,
      probeUsdg: args.probeUsdg,
    });
    if (p) priced.push(p);
  }
  if (!priced.length) return null;

  const affordable = priced.filter((p) => p.feeBps <= guard.maxFeeBps);
  const pool = (affordable.length ? affordable : priced).reduce((best, p) =>
    p.liquidityUsdg > best.liquidityUsdg ? p : best,
  );
  return { price: pool, usable: v4PriceUsable(pool, guard) };
}

/** One line a human can judge the number by, in the idiom of `describeRoute`. */
export function describeV4(p: V4Price): string {
  const depth = Math.round(Number(p.liquidityUsdg) / 1e6).toLocaleString("en-US");
  const quote = p.quoteAsset === V4_NATIVE ? "ETH" : p.quoteAsset === CASH.USDG.toLowerCase() ? "USDG" : "token";
  return `v4/${quote} · fee ${p.feeBps}bps · $${depth} in range · round trip ${p.roundTripBps}bps`;
}
