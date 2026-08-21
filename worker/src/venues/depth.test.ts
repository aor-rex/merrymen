import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLevels,
  cashAcrossRange,
  cashWithinBps,
  deriveZones,
  getSqrtRatioAtTick,
  MAX_TICK,
  MIN_TICK,
  tokenAcrossRange,
  wordPosition,
  type DepthLevel,
  type PoolDepth,
} from "./depth";

const Q96 = 2n ** 96n;

test("getSqrtRatioAtTick matches Uniswap's published vectors", () => {
  // These three are the values the Solidity library is itself tested against.
  // If a refactor ever swaps this for Math.pow(1.0001, tick/2), tick 0 will
  // still pass and both extremes will not — which is the point of pinning them.
  assert.equal(getSqrtRatioAtTick(0), Q96, "tick 0 is exactly 2^96");
  assert.equal(getSqrtRatioAtTick(MIN_TICK), 4295128739n);
  assert.equal(
    getSqrtRatioAtTick(MAX_TICK),
    1461446703485210103287273052203988822378723970342n,
  );
});

test("getSqrtRatioAtTick is monotonic and symmetric about zero", () => {
  let prev = 0n;
  for (const t of [-500_000, -100_000, -10_000, -1, 0, 1, 10_000, 100_000, 500_000]) {
    const v = getSqrtRatioAtTick(t);
    assert.ok(v > prev, `tick ${t} must exceed the tick below it`);
    prev = v;
  }
  // ratio(-t) · ratio(t) ≈ 2^192. Exact equality is not available — the library
  // rounds up at both ends — but drift beyond a few ulps means the constants
  // were mistyped, which is the realistic failure for a hand-ported table.
  for (const t of [1, 1000, 250_000]) {
    const product = getSqrtRatioAtTick(t) * getSqrtRatioAtTick(-t);
    const expected = 2n ** 192n;
    const driftBps = ((product > expected ? product - expected : expected - product) * 10_000n) / expected;
    assert.ok(driftBps <= 1n, `tick ±${t} round-trips to 2^192 (drift ${driftBps} bps)`);
  }
});

test("getSqrtRatioAtTick refuses ticks the pool could never hold", () => {
  assert.throws(() => getSqrtRatioAtTick(MAX_TICK + 1), /out of range/);
  assert.throws(() => getSqrtRatioAtTick(MIN_TICK - 1), /out of range/);
  assert.throws(() => getSqrtRatioAtTick(1.5), /integer/);
});

test("wordPosition floors toward negative infinity, not toward zero", () => {
  // The trap: JS `>>` on a negative quotient truncated by `/` puts ticks just
  // below zero in the wrong word, so the bitmap read silently misses them and
  // the map looks thin on one side only.
  assert.equal(wordPosition(0, 10), 0);
  assert.equal(wordPosition(2559, 10), 0);
  assert.equal(wordPosition(2560, 10), 1);
  assert.equal(wordPosition(-10, 10), -1);
  assert.equal(wordPosition(-2560, 10), -1);
  assert.equal(wordPosition(-2570, 10), -2);
});

test("cash across a range is exactly L·(√b−√a)/2^96, and direction-free", () => {
  const L = 1_000_000_000_000_000_000n;
  const a = getSqrtRatioAtTick(0);
  const b = getSqrtRatioAtTick(100);
  assert.equal(cashAcrossRange(L, a, b), (L * (b - a)) / Q96);
  assert.equal(cashAcrossRange(L, b, a), cashAcrossRange(L, a, b), "argument order must not matter");
  assert.equal(cashAcrossRange(0n, a, b), 0n);
  assert.equal(tokenAcrossRange(L, a, b), (L * Q96 * (b - a)) / (a * b));
});

/** A three-range ladder with the active range in the middle. */
function ladder(currentLiquidity: bigint) {
  const ticks = [-200, -100, 100, 200];
  const netByTick = new Map<number, bigint>([
    [-200, 400n * 10n ** 18n],
    [-100, 600n * 10n ** 18n],
    [100, -600n * 10n ** 18n],
    [200, -400n * 10n ** 18n],
  ]);
  return buildLevels({
    ticks,
    netByTick,
    currentTick: 0,
    currentLiquidity,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    tokenIsToken0: true,
    tokenDecimals: 18,
    cashDecimals: 6,
  });
}

test("the ladder anchors on the pool's reported liquidity, not on a sum from the window edge", () => {
  const active = 1000n * 10n ** 18n;
  const levels = ladder(active);
  // The active range straddles spot, so it is reported as two halves split at
  // the current price — both carrying the same active liquidity.
  const midBid = levels.find((l) => l.tickLower === -100 && l.tickUpper === 0);
  const midAsk = levels.find((l) => l.tickLower === 0 && l.tickUpper === 100);
  assert.ok(midBid && midAsk, "the active range is present as a bid half and an ask half");
  assert.equal(midBid.side, "bid");
  assert.equal(midAsk.side, "ask");
  assert.equal(midAsk.liquidity, midBid.liquidity, "both halves are the same position");
  const mid = midBid;
  // THE BUG THIS PINS: summing liquidityNet upward from the lowest tick in the
  // window gives whatever the window happens to contain. A position opened below
  // the window contributes net the slice never saw, so that sum is wrong by
  // exactly that amount — and wrong quietly, since the shape still looks fine.
  assert.equal(mid.liquidity, active, "the active range is the pool's own liquidity()");
  // Outer ranges follow by removing the boundary net on the way out.
  const below = levels.find((l) => l.tickUpper === -100);
  const above = levels.find((l) => l.tickLower === 100);
  assert.equal(below?.liquidity, active - 600n * 10n ** 18n);
  assert.equal(above?.liquidity, active - 600n * 10n ** 18n);
});

test("liquidity never goes negative even if the window's nets do not balance", () => {
  const levels = buildLevels({
    ticks: [-100, 0, 100],
    // A net far larger than the active liquidity — what a half-seen position
    // looks like from inside a window.
    netByTick: new Map([[0, 10n ** 30n]]),
    currentTick: -50,
    currentLiquidity: 1000n,
    sqrtPriceX96: getSqrtRatioAtTick(-50),
    tokenIsToken0: true,
    tokenDecimals: 18,
    cashDecimals: 6,
  });
  for (const l of levels) assert.ok(l.liquidity >= 0n, "clamped at zero, never negative");
});

test("sides are assigned by price, so an inverted pool does not report support as resistance", () => {
  const upright = ladder(1000n * 10n ** 18n);
  const below = upright.filter((l) => l.side === "bid");
  const above = upright.filter((l) => l.side === "ask");
  assert.ok(below.every((l) => l.tickUpper <= 0), "bids sit below the current tick");
  assert.ok(above.every((l) => l.tickLower >= 0), "asks sit above it");

  // token0 = CASH means a HIGHER tick is a LOWER price. Read naively that turns
  // every support into a resistance and vice versa — a chart that is not merely
  // wrong but exactly backwards, which is worse than absent.
  const inverted = buildLevels({
    ticks: [-200, -100, 100, 200],
    netByTick: new Map([
      [-200, 400n * 10n ** 18n],
      [-100, 600n * 10n ** 18n],
      [100, -600n * 10n ** 18n],
      [200, -400n * 10n ** 18n],
    ]),
    currentTick: 0,
    currentLiquidity: 1000n * 10n ** 18n,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    tokenIsToken0: false,
    tokenDecimals: 6,
    cashDecimals: 18,
  });
  const invertedBid = inverted.find((l) => l.side === "bid");
  assert.ok(invertedBid, "an inverted pool still has a bid side");
  assert.ok(
    invertedBid.tickLower >= 0,
    "on an inverted pool the bid side is ABOVE the tick, because price runs the other way",
  );
  for (const l of inverted) {
    assert.ok(l.priceLower8 <= l.priceUpper8, "price edges are ordered by value, not by tick");
  }
});

test("zones land on the correct side of spot and report a share of their own side", () => {
  const levels = ladder(1000n * 10n ** 18n);
  const spot8 = 100_000_000n;
  const zones = deriveZones(levels, spot8);
  assert.ok(zones.length > 0, "a laddered pool has at least one zone");
  for (const z of zones) {
    assert.ok(z.shareBps > 0 && z.shareBps <= 10_000, `share ${z.shareBps} is a fraction of its side`);
    assert.ok(z.priceLow8 <= z.priceHigh8);
    assert.ok(z.distanceBps >= 0);
  }
  assert.deepEqual(
    [...new Set(zones.map((z) => z.side))].sort(),
    ["resistance", "support"],
    "a two-sided ladder produces both",
  );
});

test("deriveZones survives an empty or one-sided ladder without inventing a level", () => {
  assert.deepEqual(deriveZones([], 100_000_000n), []);
  const oneSided: DepthLevel[] = [
    {
      tickLower: -200,
      tickUpper: -100,
      priceLower8: 90_000_000n,
      priceUpper8: 95_000_000n,
      liquidity: 10n ** 18n,
      cashRaw: 5_000_000n,
      side: "bid",
    },
  ];
  const zones = deriveZones(oneSided, 100_000_000n);
  assert.ok(zones.every((z) => z.side === "support"), "no resistance is invented from thin air");
});

function depthOf(levels: DepthLevel[], spot8: bigint): PoolDepth {
  return {
    pool: "0x00000000000000000000000000000000000000aa",
    tick: 0,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    spot8,
    tickSpacing: 10,
    bandBps: 2000,
    levels,
    zones: deriveZones(levels, spot8),
    bidCashRaw: levels.filter((l) => l.side === "bid").reduce((a, l) => a + l.cashRaw, 0n),
    askCashRaw: levels.filter((l) => l.side === "ask").reduce((a, l) => a + l.cashRaw, 0n),
    truncated: false,
    cashDecimals: 6,
  };
}

test("cashWithinBps grows with the band and never exceeds that side's total", () => {
  const spot8 = 100_000_000n; // $1.00 at 8dp
  const levels: DepthLevel[] = [
    // 0–5% below spot
    { tickLower: -600, tickUpper: -100, priceLower8: 95_000_000n, priceUpper8: 100_000_000n, liquidity: 1n, cashRaw: 1_000_000n, side: "bid" },
    // 5–10% below spot
    { tickLower: -1200, tickUpper: -600, priceLower8: 90_000_000n, priceUpper8: 95_000_000n, liquidity: 1n, cashRaw: 4_000_000n, side: "bid" },
    { tickLower: 100, tickUpper: 600, priceLower8: 100_000_000n, priceUpper8: 105_000_000n, liquidity: 1n, cashRaw: 2_000_000n, side: "ask" },
  ];
  const d = depthOf(levels, spot8);

  let prev = -1n;
  for (const bps of [10, 100, 300, 500, 1000, 5000]) {
    const v = cashWithinBps(d, bps, "bid");
    assert.ok(v >= prev, `bid depth must not shrink as the band widens (${bps}bps)`);
    prev = v;
  }
  assert.equal(cashWithinBps(d, 0, "bid"), 0n, "a zero band absorbs nothing");
  assert.ok(cashWithinBps(d, 100_000, "bid") <= d.bidCashRaw, "cannot exceed the mapped total");
  assert.ok(cashWithinBps(d, 100_000, "ask") <= d.askCashRaw);

  // A 5% band reaches exactly the first bid range and none of the second.
  assert.equal(cashWithinBps(d, 500, "bid"), 1_000_000n);
  // Widening to 10% takes all of both.
  assert.equal(cashWithinBps(d, 1000, "bid"), 5_000_000n);
  // Half-way into the second range takes half of it, pro-rata by price width.
  assert.equal(cashWithinBps(d, 750, "bid"), 1_000_000n + 2_000_000n);
});

test("cashWithinBps keeps the two sides apart", () => {
  const spot8 = 100_000_000n;
  const levels: DepthLevel[] = [
    { tickLower: -600, tickUpper: -100, priceLower8: 95_000_000n, priceUpper8: 100_000_000n, liquidity: 1n, cashRaw: 7n, side: "bid" },
    { tickLower: 100, tickUpper: 600, priceLower8: 100_000_000n, priceUpper8: 105_000_000n, liquidity: 1n, cashRaw: 11n, side: "ask" },
  ];
  const d = depthOf(levels, spot8);
  assert.equal(cashWithinBps(d, 1000, "bid"), 7n, "the bid side never counts ask liquidity");
  assert.equal(cashWithinBps(d, 1000, "ask"), 11n, "and the reverse");
});
