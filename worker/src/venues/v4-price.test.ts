import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  V4_GUARD_DEFAULTS,
  liveFeeBps,
  roundTripBps,
  v4PriceUsable,
  type V4Price,
} from "./v4-price";
import { DYNAMIC_FEE_FLAG, parseInitializeLog, V4_INITIALIZE_TOPIC } from "./v4-keys";
import { poolId } from "./uniswap-v4";

/**
 * WHAT THIS VENUE ACTUALLY LOOKS LIKE, pinned from measurement.
 *
 * 163 live v4 pools sampled on mainnet 2026-08-30:
 *
 *     LP fee bps    min 0   p25 200   median 8633   p75 9450   max 9910
 *     over 100bps   76.1%     over 5000bps  66.9%
 *     at or under 100bps — 23.9%, the whole tradeable set
 *
 * The median graduated pool charges 86% to trade through it. Every assertion
 * about the fee below exists because the first version of this guard forgave
 * whatever the fee "explained" — a 98.8% round trip is exactly what an 89% fee
 * predicts, so that design waved through two-thirds of the chain.
 *
 * Prices produced by this module were cross-checked against GeckoTerminal for
 * six real graduated coins: agreement within 1.7%–4.2% on all six.
 */

const base: V4Price = {
  price8: 100_000_000n,
  liquidityUsdg: 50_000_000_000n,
  feeBps: 30,
  roundTripBps: 120,
  quoteAsset: "0x0000000000000000000000000000000000000000",
  poolId: "0xabc" as `0x${string}`,
  key: { currency0: "0x1", currency1: "0x2", fee: 0, tickSpacing: 60, hooks: "0x0" } as never,
};

describe("liveFeeBps reads the fee that is actually charged", () => {
  it("prefers slot0 when the key carries the DYNAMIC flag", () => {
    // 0x800000 is LPFeeLibrary's flag, not a fee. Read literally it is
    // 167,772 bps — a number large enough to sail through a sanity check
    // written in basis points, and small enough to look like a typo.
    assert.equal(liveFeeBps(DYNAMIC_FEE_FLAG, 863_300), 8_633);
    assert.notEqual(liveFeeBps(DYNAMIC_FEE_FLAG, 863_300), Math.round(DYNAMIC_FEE_FLAG / 100));
  });

  it("uses a static key fee when slot0 reports none", () => {
    assert.equal(liveFeeBps(3_000, 0), 30);
  });

  it("a genuinely free pool reads as zero, not as the flag", () => {
    assert.equal(liveFeeBps(0, 0), 0);
  });
});

describe("roundTripBps", () => {
  it("measures what a probe loses out and back", () => {
    assert.equal(roundTripBps(1_000_000n, 990_000n), 100);
  });

  it("returns NULL when nothing came back — the worst signal is not a free trip", () => {
    assert.equal(roundTripBps(1_000_000n, 0n), null);
    assert.equal(roundTripBps(0n, 100n), null);
  });

  it("clamps a reported gain to zero rather than believing it", () => {
    assert.equal(roundTripBps(1_000_000n, 1_200_000n), 0);
  });
});

describe("v4PriceUsable", () => {
  it("admits an honest pool", () => {
    assert.equal(v4PriceUsable(base, V4_GUARD_DEFAULTS).ok, true);
  });

  it("REFUSES the fee trap that is two-thirds of this chain", () => {
    // The measured median. This is the assertion the first design failed.
    const r = v4PriceUsable({ ...base, feeBps: 8_633, roundTripBps: 9_880 }, V4_GUARD_DEFAULTS);
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.kind, "extortionate-fee");
    assert.match(r.ok === false ? r.reason : "", /86\.33%/);
  });

  it("names the FEE first, not the depth", () => {
    // An 86%-fee pool that is also thin must not be reported as "too thin":
    // true, and beside the point — the reader would go looking for a deeper
    // pool of the same rug.
    const r = v4PriceUsable({ ...base, feeBps: 9_450, liquidityUsdg: 1n }, V4_GUARD_DEFAULTS);
    assert.equal(r.ok === false && r.kind, "extortionate-fee");
  });

  it("catches the pool you can enter but not leave", () => {
    // A fee check alone misses the asymmetric pool: cheap in, refuses to quote
    // the way out. That arrives as a 10,000bps round trip.
    const r = v4PriceUsable({ ...base, feeBps: 10, roundTripBps: 10_000 }, V4_GUARD_DEFAULTS);
    assert.equal(r.ok === false && r.kind, "wide-round-trip");
  });

  it("still refuses a thin pool at an honest fee", () => {
    const r = v4PriceUsable({ ...base, liquidityUsdg: 25_000_000n }, V4_GUARD_DEFAULTS);
    assert.equal(r.ok === false && r.kind, "too-thin");
  });

  it("the depth floor matches the v3 one — one floor, both venues", () => {
    // cashDepthFromLiquidity is shared with the v3 route precisely so that
    // trencher's $25k gate keeps meaning what it already meant.
    assert.equal(V4_GUARD_DEFAULTS.minLiquidityUsdg, 25_000_000_000n);
  });
});

describe("parseInitializeLog verifies the key it rebuilds", () => {
  const key = {
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: "0xbcf042898887b03d52c0ea245ee998ac193775a0",
    fee: 955_609,
    tickSpacing: 1,
    hooks: "0x0000000000000000000000000000000000000000",
  } as const;
  const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, "0");
  const data = `0x${word(key.fee)}${word(key.tickSpacing)}${word(BigInt(key.hooks))}${word(0)}${word(0)}`;
  const topics = [V4_INITIALIZE_TOPIC, poolId(key as never), `0x${"0".repeat(64)}`, `0x${key.currency1.slice(2).padStart(64, "0")}`];

  it("accepts a log whose key hashes back to the id it was indexed by", () => {
    const got = parseInitializeLog({ topics, data, blockNumber: 7n });
    assert.ok(got, "a well-formed Initialize log must parse");
    assert.equal(got!.key.fee, key.fee);
    assert.equal(got!.key.currency1, key.currency1);
    assert.equal(got!.blockNumber, 7n);
  });

  it("REFUSES a log whose id does not match — the check that makes this trustworthy", () => {
    // A key assembled in the wrong topic order still hashes to something; it
    // simply addresses a pool that does not exist, and every read against it
    // comes back empty and reads as "no liquidity". Verification turns that
    // silent class of error into a null.
    const wrong = [...topics];
    wrong[1] = `0x${"f".repeat(64)}`;
    assert.equal(parseInitializeLog({ topics: wrong, data, blockNumber: 7n }), null);
  });

  it("ignores a log that is not Initialize at all", () => {
    const other = [...topics];
    other[0] = `0x${"1".repeat(64)}`;
    assert.equal(parseInitializeLog({ topics: other, data, blockNumber: 7n }), null);
  });
});
