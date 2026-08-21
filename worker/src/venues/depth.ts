/**
 * WHERE THE MONEY IS STACKED — a price-level depth map read from the chain.
 *
 * WHAT THIS IS NOT. There is no order book here to read. Robinhood Chain has no
 * CLOB: Rialto's own OpenAPI says "No orderbook is exposed", the limit-order
 * contracts deployed on 4663 have 0-2 lifetime transactions, and the strategist
 * prompt has always told the model it cannot see one. Anything calling itself an
 * order book on this chain would be a fiction.
 *
 * WHAT IT IS INSTEAD, and why it is arguably better. Uniswap v3 liquidity is
 * CONCENTRATED: an LP commits capital to a specific price range, so the amount
 * sitting at each tick is a real, public, verifiable map of where capital is
 * parked. A dense band below spot absorbs selling the way a bid wall does, and a
 * dense band above absorbs buying. Unlike a book, nobody can spoof it — the
 * capital is posted, not promised, and you can check every number against the
 * explorer.
 *
 * AND IT IS EXACT. Within one range the pool is a constant-product curve, so the
 * cash needed to walk price from sqrtA to sqrtB is L·(sqrtB−sqrtA) exactly — not
 * an estimate. Summing that across the ladder reproduces what QuoterV2 returns
 * for the same trade to 0.0000% at sizes from $200 to $434k. The depth map is not
 * a picture OF the execution curve; it IS the execution curve, arrived at by
 * arithmetic instead of by a simulated swap per size.
 *
 * WHAT IT HONESTLY IS NOT, and this belongs in any copy that ships:
 *   - A v3 range is not a resting order. It is a two-sided quote that flips from
 *     bid to ask as price crosses it. Calling the lower half "bids" is a reading,
 *     not a fact about someone's intent.
 *   - LPs leave. One pool showed 695 mints and 310 burns in 24h. A wall is a
 *     photograph, not a promise, and it can be gone in a block.
 *   - There is no queue, no participant count, no cancellation to watch.
 *   - This is ONE pool. The router may fill across four, so a per-pool map
 *     understates true depth for a token that trades in several.
 *
 * PROPOSE SIDE ONLY. Everything here is read-only market colour. It reaches the
 * strategist and the Telegram reads; it does not reach policy.ts, and it must
 * never become an input to a cap. depth.invariant.test.ts pins that.
 */

import type { PublicClient } from "viem";
import { parseAbi } from "viem";
import { scalePrice, tickToPrice8 } from "./pool-price";

const POOL_DEPTH_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
  "function token0() view returns (address)",
  "function tickBitmap(int16 wordPosition) view returns (uint256)",
  "function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

const Q96 = 2n ** 96n;
const MAX_UINT256 = 2n ** 256n - 1n;

/** v3's own tick bounds. Outside these getSqrtRatioAtTick is undefined. */
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/**
 * How far either side of spot to map, in basis points.
 *
 * 20% covers the band where support and resistance mean anything for an agent
 * whose per-trade cap is measured in tens of dollars. Wider costs more bitmap
 * words for liquidity nobody in this system will ever reach.
 */
export const DEFAULT_BAND_BPS = 2000;

/** Hard ceiling on bitmap words read per side, so a pathological pool can't
 * turn one depth read into hundreds of RPC calls. Hitting it sets `truncated`,
 * which callers must surface rather than quietly presenting a partial map. */
const MAX_WORDS_PER_SIDE = 32;

/**
 * Uniswap's TickMath.getSqrtRatioAtTick, ported exactly.
 *
 * Deliberately NOT Math.pow(1.0001, tick/2) * 2**96. That is accurate to about
 * 1e-15 relative, which sounds fine until it is multiplied by a liquidity figure
 * of 1e18 and summed across 260 ranges — and the whole claim this module rests
 * on is that its arithmetic reproduces the quoter EXACTLY. Float exponentiation
 * would make that claim false in the last digits, and "exact" is not a property
 * worth having approximately.
 */
export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new Error(`tick must be an integer, got ${tick}`);
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick ${tick} out of range`);
  const abs = BigInt(Math.abs(tick));

  let ratio =
    (abs & 0x1n) !== 0n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((abs & 0x2n) !== 0n) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((abs & 0x4n) !== 0n) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((abs & 0x8n) !== 0n) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((abs & 0x10n) !== 0n) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((abs & 0x20n) !== 0n) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((abs & 0x40n) !== 0n) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((abs & 0x80n) !== 0n) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((abs & 0x100n) !== 0n) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((abs & 0x200n) !== 0n) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((abs & 0x400n) !== 0n) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((abs & 0x800n) !== 0n) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((abs & 0x1000n) !== 0n) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((abs & 0x2000n) !== 0n) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((abs & 0x4000n) !== 0n) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((abs & 0x8000n) !== 0n) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((abs & 0x10000n) !== 0n) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((abs & 0x20000n) !== 0n) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((abs & 0x40000n) !== 0n) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((abs & 0x80000n) !== 0n) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;

  if (tick > 0) ratio = MAX_UINT256 / ratio;
  // Round UP to the next Q96, exactly as the Solidity does.
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** Which bitmap word a tick's compressed index lives in. Floor division, so it
 * is correct for negative ticks where JS `/` would truncate toward zero. */
export function wordPosition(tick: number, spacing: number): number {
  const compressed = Math.floor(tick / spacing);
  return compressed >> 8;
}

/** One initialized range in the ladder, already priced. */
export interface DepthLevel {
  tickLower: number;
  tickUpper: number;
  /** Cash per whole token at each edge, 8dp — the same unit as prices elsewhere. */
  priceLower8: bigint;
  priceUpper8: bigint;
  /** Liquidity active inside this range. */
  liquidity: bigint;
  /** Cash-equivalent this range would absorb, in the cash token's raw units. */
  cashRaw: bigint;
  /** Below spot absorbs selling; above spot absorbs buying. See the header on
   * why this is a reading of a two-sided quote and not someone's resting order. */
  side: "bid" | "ask";
}

/** A cluster of adjacent liquidity — what "support" and "resistance" mean here. */
export interface DepthZone {
  side: "support" | "resistance";
  priceLow8: bigint;
  priceHigh8: bigint;
  cashRaw: bigint;
  /** This zone's share of all mapped depth on its side, in bps. */
  shareBps: number;
  /** Distance from spot to the near edge, in bps. */
  distanceBps: number;
}

export interface PoolDepth {
  pool: `0x${string}`;
  tick: number;
  sqrtPriceX96: bigint;
  spot8: bigint;
  tickSpacing: number;
  bandBps: number;
  levels: DepthLevel[];
  zones: DepthZone[];
  /** Cash absorbed by everything below spot inside the band. */
  bidCashRaw: bigint;
  /** Cash needed to lift price to the top of the band. */
  askCashRaw: bigint;
  /** The ladder hit the word cap before the band closed — the map is partial and
   * every total here is a FLOOR. Never present a truncated map as complete. */
  truncated: boolean;
  cashDecimals: number;
}

/**
 * Cash (token1-side) needed to walk price across one range at liquidity L.
 * Δy = L·(√b − √a). Exact — this is the identity the pool itself integrates.
 */
export function cashAcrossRange(liquidity: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  if (liquidity <= 0n) return 0n;
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  return (liquidity * (hi - lo)) / Q96;
}

/**
 * Token (token0-side) released by walking price across one range at L.
 * Δx = L·(√b − √a)/(√a·√b). Also exact.
 */
export function tokenAcrossRange(liquidity: bigint, sqrtA: bigint, sqrtB: bigint): bigint {
  if (liquidity <= 0n) return 0n;
  const [lo, hi] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];
  if (lo === 0n) return 0n;
  return (liquidity * Q96 * (hi - lo)) / (lo * hi);
}

/**
 * Rebuild the liquidity ladder from the bitmap words and tick reads.
 *
 * `netByTick` is liquidityNet keyed by tick. Walking upward from the lowest
 * mapped tick and accumulating net gives the liquidity active in each range —
 * the same accumulation the pool performs when a swap crosses a tick, which is
 * why reconstructing it and re-integrating reproduces the quoter exactly.
 */
export function buildLevels(args: {
  ticks: readonly number[];
  netByTick: ReadonlyMap<number, bigint>;
  currentTick: number;
  currentLiquidity: bigint;
  sqrtPriceX96: bigint;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  cashDecimals: number;
}): DepthLevel[] {
  const sorted = [...args.ticks].sort((a, b) => a - b);
  if (sorted.length < 2) return [];

  // Anchor the accumulation on the pool's OWN reported liquidity rather than on
  // a running sum from the bottom of the window. A window is a slice: positions
  // opened below it contribute net the slice never saw, so summing from the edge
  // would be wrong by exactly that amount. Anchoring at the active range and
  // walking outward in both directions makes the window's edge irrelevant.
  const active = sorted.findIndex((t, i) => {
    const next = sorted[i + 1];
    return next !== undefined && t <= args.currentTick && args.currentTick < next;
  });
  if (active < 0) return [];

  const liquidityByIndex = new Array<bigint>(sorted.length - 1).fill(0n);
  liquidityByIndex[active] = args.currentLiquidity;
  // Upward: crossing tick[i] adds its net.
  for (let i = active + 1; i < sorted.length - 1; i++) {
    const boundary = sorted[i]!;
    const prev = liquidityByIndex[i - 1]!;
    const next = prev + (args.netByTick.get(boundary) ?? 0n);
    liquidityByIndex[i] = next > 0n ? next : 0n;
  }
  // Downward: crossing tick[i+1] going down removes its net.
  for (let i = active - 1; i >= 0; i--) {
    const boundary = sorted[i + 1]!;
    const above = liquidityByIndex[i + 1]!;
    const next = above - (args.netByTick.get(boundary) ?? 0n);
    liquidityByIndex[i] = next > 0n ? next : 0n;
  }

  const priceOf = (tick: number) =>
    tickToPrice8({
      tick,
      tokenIsToken0: args.tokenIsToken0,
      tokenDecimals: args.tokenDecimals,
      cashDecimals: args.cashDecimals,
    });

  const out: DepthLevel[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const lower = sorted[i]!;
    const upper = sorted[i + 1]!;
    const liquidity = liquidityByIndex[i]!;
    if (liquidity <= 0n) continue;

    // The cash side of a range is token1's delta when the pool is TOKEN/CASH
    // with cash as token1, and token0's when the sides are reversed. Getting
    // this backwards silently reports the token quantity as dollars.
    const sqrtLower = getSqrtRatioAtTick(lower);
    const sqrtUpper = getSqrtRatioAtTick(upper);

    const push = (a: number, b: number, sqrtA: bigint, sqrtB: bigint, side: "bid" | "ask") => {
      const cash = args.tokenIsToken0
        ? cashAcrossRange(liquidity, sqrtA, sqrtB)
        : tokenAcrossRange(liquidity, sqrtA, sqrtB);
      if (cash <= 0n) return;
      const lo = priceOf(a);
      const hi = priceOf(b);
      // Inverted pools price DOWN as tick goes up, so order the edges by value.
      const [priceLower8, priceUpper8] = lo <= hi ? [lo, hi] : [hi, lo];
      out.push({ tickLower: a, tickUpper: b, priceLower8, priceUpper8, liquidity, cashRaw: cash, side });
    };

    if (lower < args.currentTick && args.currentTick < upper) {
      // THE ACTIVE RANGE IS BOTH SIDES AT ONCE. Labelling it wholly bid (or
      // wholly ask) miscounts the half that is not, and it is the range nearest
      // spot — precisely where cashWithinBps is asked about most. Split it at
      // the pool's OWN sqrtPriceX96, which is the true current price and sits
      // between ticks, rather than at the tick boundary.
      push(lower, args.currentTick, sqrtLower, args.sqrtPriceX96, "bid");
      push(args.currentTick, upper, args.sqrtPriceX96, sqrtUpper, "ask");
      continue;
    }
    push(lower, upper, sqrtLower, sqrtUpper, upper <= args.currentTick ? "bid" : "ask");
  }

  // For an inverted pool a HIGHER tick is a LOWER price, so "below spot" flips.
  if (!args.tokenIsToken0) {
    for (const level of out) {
      level.side = level.side === "bid" ? "ask" : "bid";
    }
  }
  return out;
}

/**
 * Collapse the ladder into a handful of zones.
 *
 * A "zone" is a run of adjacent ranges whose density is above the mean — the
 * places where capital actually piles up rather than the long thin tail either
 * side. Reported as a share of its own side's depth, because the absolute number
 * means nothing without knowing whether the pool holds $4k or $4m.
 */
export function deriveZones(levels: readonly DepthLevel[], spot8: bigint, limit = 3): DepthZone[] {
  const zones: DepthZone[] = [];
  for (const side of ["bid", "ask"] as const) {
    const own = levels.filter((l) => l.side === side && l.cashRaw > 0n);
    if (own.length === 0) continue;
    const total = own.reduce((a, l) => a + l.cashRaw, 0n);
    if (total <= 0n) continue;
    const mean = total / BigInt(own.length);

    // Ascending by price so a run is genuinely contiguous in price space.
    const byPrice = [...own].sort((a, b) => (a.priceLower8 < b.priceLower8 ? -1 : 1));
    let run: DepthLevel[] = [];
    const runs: DepthLevel[][] = [];
    for (const level of byPrice) {
      if (level.cashRaw >= mean) {
        run.push(level);
      } else if (run.length > 0) {
        runs.push(run);
        run = [];
      }
    }
    if (run.length > 0) runs.push(run);

    for (const r of runs) {
      const cashRaw = r.reduce((a, l) => a + l.cashRaw, 0n);
      const priceLow8 = r[0]!.priceLower8;
      const priceHigh8 = r[r.length - 1]!.priceUpper8;
      const near = side === "bid" ? priceHigh8 : priceLow8;
      zones.push({
        side: side === "bid" ? "support" : "resistance",
        priceLow8,
        priceHigh8,
        cashRaw,
        shareBps: Number((cashRaw * 10_000n) / total),
        distanceBps: spot8 > 0n ? Math.abs(Number(((near - spot8) * 10_000n) / spot8)) : 0,
      });
    }
  }
  // Biggest first, and only a few — a list of twenty "zones" is a histogram with
  // extra steps, and the point of a zone is that it is worth naming.
  return zones.sort((a, b) => (a.cashRaw > b.cashRaw ? -1 : 1)).slice(0, limit * 2);
}

/**
 * Cash that can be spent (side "ask") or absorbed (side "bid") before price moves
 * `bps` away from spot. This is the number a trader actually wants: not "how much
 * is in the pool" but "how much can I do before I move it".
 */
export function cashWithinBps(depth: PoolDepth, bps: number, side: "bid" | "ask"): bigint {
  if (bps <= 0 || depth.spot8 <= 0n) return 0n;
  const delta = (depth.spot8 * BigInt(Math.round(bps))) / 10_000n;
  const bound = side === "ask" ? depth.spot8 + delta : depth.spot8 - delta;
  let total = 0n;
  for (const level of depth.levels) {
    if (level.side !== side) continue;
    if (side === "ask" ? level.priceLower8 >= bound : level.priceUpper8 <= bound) continue;
    // A range straddling the bound counts pro-rata by price width. Ranges are
    // narrow relative to the band, so linear apportioning is well inside the
    // noise of an LP leaving mid-read.
    const width = level.priceUpper8 - level.priceLower8;
    if (width <= 0n) continue;
    const inside =
      side === "ask"
        ? (bound < level.priceUpper8 ? bound : level.priceUpper8) - level.priceLower8
        : level.priceUpper8 - (bound > level.priceLower8 ? bound : level.priceLower8);
    if (inside <= 0n) continue;
    total += inside >= width ? level.cashRaw : (level.cashRaw * inside) / width;
  }
  return total;
}

/**
 * Read a pool's depth map. Batched through multicall3 — 3 RPC round trips for a
 * full profile, against the 28 the routed price read already spends every tick.
 * Doing this with the venue layer's usual Promise.all-of-readContract style would
 * cost ~59 and make it the most expensive thing in the loop.
 */
export async function readPoolDepth(
  client: PublicClient,
  args: {
    pool: `0x${string}`;
    token: `0x${string}`;
    tokenDecimals: number;
    cashDecimals: number;
    bandBps?: number;
  },
): Promise<PoolDepth | null> {
  // REFUSE RATHER THAN RETURN A ZERO PRICE. StockToken.decimals is optional —
  // the registry omits it for the 18dp stock tokens — so a caller reaching for
  // `token.decimals` gets undefined, scalePrice sees NaN, and every price in the
  // map comes back 0 while the liquidity figures still look completely healthy.
  // A depth map with a $0.00 spot is not a degraded reading, it is a wrong one,
  // and it would sail straight into a prompt or a chart. Caught this exact way.
  for (const [name, value] of [
    ["tokenDecimals", args.tokenDecimals],
    ["cashDecimals", args.cashDecimals],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 36) {
      throw new Error(`readPoolDepth: ${name} must be an integer 0-36, got ${String(value)}`);
    }
  }
  const bandBps = args.bandBps ?? DEFAULT_BAND_BPS;
  const base = { address: args.pool, abi: POOL_DEPTH_ABI } as const;

  const [slot0, liquidity, spacingRaw, token0] = (await client.multicall({
    contracts: [
      { ...base, functionName: "slot0" },
      { ...base, functionName: "liquidity" },
      { ...base, functionName: "tickSpacing" },
      { ...base, functionName: "token0" },
    ],
    allowFailure: false,
  })) as [readonly [bigint, number, number, number, number, number, boolean], bigint, number, `0x${string}`];

  const spacing = Number(spacingRaw);
  if (!Number.isFinite(spacing) || spacing <= 0) return null;
  const currentTick = Number(slot0[1]);
  const sqrtPriceX96 = slot0[0];
  const tokenIsToken0 = token0.toLowerCase() === args.token.toLowerCase();

  // A band in PRICE is a fixed distance in TICKS: 1.0001^t, so t = ln(1+b)/ln(1.0001).
  const tickSpan = Math.ceil(Math.log(1 + bandBps / 10_000) / Math.log(1.0001));
  const loTick = Math.max(MIN_TICK, currentTick - tickSpan);
  const hiTick = Math.min(MAX_TICK, currentTick + tickSpan);

  const loWord = wordPosition(loTick, spacing);
  const hiWord = wordPosition(hiTick, spacing);
  const centre = wordPosition(currentTick, spacing);
  const from = Math.max(loWord, centre - MAX_WORDS_PER_SIDE);
  const to = Math.min(hiWord, centre + MAX_WORDS_PER_SIDE);
  const truncated = from > loWord || to < hiWord;

  const words: number[] = [];
  for (let w = from; w <= to; w++) words.push(w);
  if (words.length === 0) return null;

  const bitmaps = (await client.multicall({
    contracts: words.map((w) => ({ ...base, functionName: "tickBitmap" as const, args: [w] as const })),
    allowFailure: false,
  })) as bigint[];

  const initialized: number[] = [];
  for (const [i, word] of words.entries()) {
    const bits = bitmaps[i];
    if (bits === undefined || bits === 0n) continue;
    for (let bit = 0; bit < 256; bit++) {
      if (((bits >> BigInt(bit)) & 1n) === 0n) continue;
      const tick = ((word << 8) + bit) * spacing;
      if (tick >= loTick && tick <= hiTick) initialized.push(tick);
    }
  }
  if (initialized.length < 2) return null;

  const tickInfos = (await client.multicall({
    contracts: initialized.map((t) => ({ ...base, functionName: "ticks" as const, args: [t] as const })),
    allowFailure: false,
  })) as readonly (readonly [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean])[];

  const netByTick = new Map<number, bigint>();
  for (const [i, info] of tickInfos.entries()) {
    const tick = initialized[i];
    if (tick === undefined || info === undefined) continue;
    netByTick.set(tick, info[1]);
  }

  const levels = buildLevels({
    ticks: initialized,
    netByTick,
    currentTick,
    currentLiquidity: liquidity,
    sqrtPriceX96,
    tokenIsToken0,
    tokenDecimals: args.tokenDecimals,
    cashDecimals: args.cashDecimals,
  });
  if (levels.length === 0) return null;

  const spot8 = tickToPrice8({
    tick: currentTick,
    tokenIsToken0,
    tokenDecimals: args.tokenDecimals,
    cashDecimals: args.cashDecimals,
  });

  return {
    pool: args.pool,
    tick: currentTick,
    sqrtPriceX96,
    spot8,
    tickSpacing: spacing,
    bandBps,
    levels,
    zones: deriveZones(levels, spot8),
    bidCashRaw: levels.filter((l) => l.side === "bid").reduce((a, l) => a + l.cashRaw, 0n),
    askCashRaw: levels.filter((l) => l.side === "ask").reduce((a, l) => a + l.cashRaw, 0n),
    truncated,
    cashDecimals: args.cashDecimals,
  };
}

/** Human cash figure from raw units — for display and for the model's prompt. */
export function cashToNumber(raw: bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}

/** Round-trip helper so callers can express a size in dollars without importing
 * the scaling rules. Mirrors scalePrice's careful float handling. */
export function cashFromNumber(human: number, decimals: number): bigint {
  return scalePrice(human, decimals);
}
