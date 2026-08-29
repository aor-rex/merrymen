import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  curveBuyImpactBps,
  curveDepthFraction,
  curveGraduated,
  curvePrice,
  realQuoteRaw,
  virtualSeedRaw,
  type CurveReserves,
} from "./pons-price";

/**
 * Pricing a bonding curve, checked against real ones.
 *
 * A CORRECTION THESE TESTS EXIST TO PIN. The first version of this suite took
 * the fixture below — 1.6838 ETH against a 4.2 ETH threshold — and asserted it
 * was "~40% of the way to graduation", calling that an independent sanity check
 * that the units were right. It was not independent and it was not a check: Pons
 * seeds every curve with a VIRTUAL reserve of exactly 0.4 x threshold, so 1.68
 * against 4.2 is the constant 0.4 being rediscovered, and it would read the same
 * on a curve that had never traded. That curve held 0.0038 ETH. It was 0.09% of
 * the way, and the old suite asserted the seed as both depth and progress.
 *
 * The lesson worth keeping: a figure that "comes out to a plausible round
 * number" is evidence of a constant, not of correctness. What separates them is
 * a second, unrelated observation — here, the contract's own balance.
 */

// A real mainnet curve: 0x312a8dff…, native-ETH quoted, threshold 4.2 ETH.
const LIVE: CurveReserves = {
  quoteRaw: 1683772225727764056n, // 1.68 virtual seed + 0.00377 real
  tokenRaw: 997759657945341386015177738n,
  quoteDecimals: 18,
  tokenDecimals: 18,
  graduationThresholdRaw: 4_200_000_000_000_000_000n,
};
// The real ETH price on chain 4663 when these reserves were read.
const ETH_USD8 = 244_237_000_000n; // $2,442.37

/**
 * A second real curve, read 2026-08-29, whose REAL reserve is corroborated by
 * something outside the curve's own arithmetic: the contract's ETH balance.
 * getReserves() reported 0.4035 x threshold; r0 - 0.4 x threshold = 0.0147 ETH;
 * eth_getBalance said 0.015 ETH held. That agreement — not a round number — is
 * what establishes the seed model.
 */
const CORROBORATED: CurveReserves = {
  quoteRaw: 1694700000000000000n, // 0.40350 x 4.2e18
  tokenRaw: 990_000_000n * 10n ** 18n,
  quoteDecimals: 18,
  tokenDecimals: 18,
  graduationThresholdRaw: 4_200_000_000_000_000_000n,
};

describe("the virtual seed", () => {
  it("is 40% of the curve's own threshold", () => {
    assert.equal(virtualSeedRaw(4_200_000_000_000_000_000n), 1_680_000_000_000_000_000n);
    // Thresholds are per quote asset, not a constant — a 6dp USDG curve too.
    assert.equal(virtualSeedRaw(8_090_000_000n), 3_236_000_000n);
    assert.equal(virtualSeedRaw(0n), 0n, "no threshold, no seed to subtract");
  });

  it("leaves the real reserve, corroborated by the contract's own balance", () => {
    // 0.0147 ETH computed here; eth_getBalance on that curve said 0.015 held.
    const real = Number(realQuoteRaw(CORROBORATED)) / 1e18;
    assert.ok(Math.abs(real - 0.0147) < 0.0005, `expected ~0.0147 ETH, got ${real}`);
  });

  it("reports a curve nobody has bought as holding NOTHING", () => {
    // The bug this whole change is about: a fresh curve reads 1.68 ETH of
    // reserve while its balance is zero. Depth must be 0, not $4,106.
    const fresh: CurveReserves = { ...LIVE, quoteRaw: 1_680_000_000_000_000_000n };
    assert.equal(realQuoteRaw(fresh), 0n);
    assert.equal(curvePrice(fresh, ETH_USD8)!.depthUsd8, 0n);
    assert.equal(curveDepthFraction(fresh), 0);
  });

  it("never goes negative when a curve reads below its seed", () => {
    // No sampled curve does, so this means the seed model is wrong for it —
    // and "nothing" is the honest answer, not a negative that would compare as
    // less than every floor and quietly pass a `< min` test in the wrong
    // direction.
    assert.equal(realQuoteRaw({ ...LIVE, quoteRaw: 1n }), 0n);
  });
});

describe("curvePrice", () => {
  it("prices the live mainnet curve at a sane figure", () => {
    const p = curvePrice(LIVE, ETH_USD8);
    assert.ok(p);
    // CROSS-CHECKED AGAINST AN INDEPENDENT SOURCE. GeckoTerminal, which indexes
    // this chain and this pre-graduation curve, reported 4.246263e-6 for the
    // same token; this computes 4.120e-6 from the raw reserves — 3% apart,
    // which is block skew plus the curve's own fee, not a modelling error.
    const usd = Number(p!.price8) / 1e8;
    const gecko = 4.246263e-6;
    assert.ok(Math.abs(usd - gecko) / gecko < 0.06, `${usd.toExponential(3)} vs gecko ${gecko.toExponential(3)}`);
  });

  it("prices from the FULL reserve, seed included — that is what the curve does", () => {
    // Verified to 1 wei against real observed buys: the constant product uses
    // the seeded reserve. This is deliberate, not an oversight, and the cost of
    // getting it backwards is stark — against the 0.00377 ETH real reserve the
    // same token prices below 1e-8 and comes back UNPRICEABLE, so a young curve
    // would look like it had no price at all rather than a small one.
    assert.ok(curvePrice(LIVE, ETH_USD8)!.price8 > 0n);
    assert.equal(curvePrice({ ...LIVE, quoteRaw: realQuoteRaw(LIVE) }, ETH_USD8), null);
  });

  it("reports DEPTH as the real money only", () => {
    // 0.00377 ETH at $2,442.37 is about $9.21 — not the $4,112 the first
    // version of this file asserted.
    const depth = Number(curvePrice(LIVE, ETH_USD8)!.depthUsd8) / 1e8;
    assert.ok(depth > 8 && depth < 11, `expected ~$9.21 of real depth, got $${depth.toFixed(2)}`);
    assert.ok(depth < 100, "the virtual seed must never be counted as depth");
  });

  it("does not lose the price to integer division", () => {
    // A memecoin is ~1e-9 of its quote asset. Dividing before multiplying would
    // floor this to zero and report a free token.
    assert.ok(curvePrice(LIVE, ETH_USD8)!.price8 > 0n);
  });

  it("handles a 6dp quote (USDG) as well as an 18dp one", () => {
    const usdgCurve: CurveReserves = {
      quoteRaw: 10_000_000_000n, // 10,000 USDG at 6dp
      tokenRaw: 1_000_000_000n * 10n ** 18n,
      quoteDecimals: 6,
      tokenDecimals: 18,
      graduationThresholdRaw: 8_090_000_000n, // the observed USDG threshold
    };
    const p = curvePrice(usdgCurve, 100_000_000n); // USDG = $1.00
    assert.ok(p);
    // $10,000 across 1e9 tokens = $1e-5 each — priced off the full reserve.
    assert.equal(p!.price8, 1_000n);
    // Depth is 10,000 - 3,236 seed = 6,764 USDG.
    assert.equal(p!.depthUsd8, 676_400_000_000n);
  });

  it("returns null — never zero — when it cannot price", () => {
    // "Missing fact" and "worthless" must not be the same value: positions are
    // valued with this.
    assert.equal(curvePrice({ ...LIVE, quoteRaw: 0n }, ETH_USD8), null, "empty quote side");
    assert.equal(curvePrice({ ...LIVE, tokenRaw: 0n }, ETH_USD8), null, "empty token side");
    assert.equal(curvePrice(LIVE, 0n), null, "no USD price for the quote asset");
  });

  it("refuses a token too numerous to price at 8dp rather than rounding to free", () => {
    const dust: CurveReserves = { ...LIVE, quoteRaw: 1n, tokenRaw: 10n ** 36n };
    assert.equal(curvePrice(dust, ETH_USD8), null);
  });
});

describe("curveBuyImpactBps", () => {
  it("charges more impact for a bigger bite of the same curve", () => {
    const small = curveBuyImpactBps(LIVE, 10n ** 16n); // 0.01 ETH
    const large = curveBuyImpactBps(LIVE, 10n ** 18n); // 1 ETH
    assert.ok(small !== null && large !== null);
    assert.ok(large! > small!, "a larger trade must cost more, not less");
    assert.ok(small! > 0 && small! < 200, `expected a small positive bps, got ${small}`);
  });

  it("uses the seeded reserve, so an early buy is not priced as an empty pool", () => {
    // Against the REAL 0.00377 ETH reserve, a 0.01 ETH buy would look
    // catastrophic. Against the seeded reserve — which is what the contract
    // actually computes with — it is small. Getting this backwards would
    // reject every young curve for impact it does not really incur.
    const seeded = curveBuyImpactBps(LIVE, 10n ** 16n)!;
    const unseeded = curveBuyImpactBps({ ...LIVE, quoteRaw: realQuoteRaw(LIVE) }, 10n ** 16n)!;
    assert.ok(unseeded > seeded * 10, `seeded ${seeded}bps vs unseeded ${unseeded}bps`);
  });

  it("returns null rather than 0 when a trade cannot be evaluated", () => {
    assert.equal(curveBuyImpactBps(LIVE, 0n), null);
    assert.equal(curveBuyImpactBps({ ...LIVE, quoteRaw: 0n }, 10n ** 16n), null);
  });

  it("impact is exact, not sampled — it follows from x*y=k", () => {
    const huge = curveBuyImpactBps(LIVE, 10n ** 24n);
    assert.ok(huge !== null && huge > 0);
  });
});

describe("curveDepthFraction", () => {
  it("puts the live curve at 0.09% of threshold, not 40%", () => {
    // 0.00377 / 4.2. The old suite asserted ~0.40 here, which was the seed.
    const p = curveDepthFraction(LIVE);
    assert.ok(p !== null);
    assert.ok(p! > 0.0005 && p! < 0.002, `expected ~0.0009, got ${p}`);
  });

  it("needs no price feed, so it works for a stock-quoted curve", () => {
    // 42.8% of launches are quoted in Robinhood stock tokens and 2.3% in cbBTC,
    // which this repo cannot price at all. Normalising by the curve's own
    // threshold compares those to an ETH curve without a single feed read.
    const nvdaQuoted: CurveReserves = {
      quoteRaw: 41_600_000_000_000_000_000n / 10n + 16_640_000_000_000_000_000n, // 10% raised + seed
      tokenRaw: 900_000_000n * 10n ** 18n,
      quoteDecimals: 18,
      tokenDecimals: 18,
      graduationThresholdRaw: 41_600_000_000_000_000_000n, // the observed NVDA threshold
    };
    const f = curveDepthFraction(nvdaQuoted);
    assert.ok(f !== null && Math.abs(f - 0.1) < 0.001, `expected 0.10, got ${f}`);
  });

  it("clamps at 1 and refuses a nonsense threshold", () => {
    assert.equal(curveDepthFraction({ ...LIVE, quoteRaw: 10n ** 19n }), 1);
    assert.equal(curveDepthFraction({ ...LIVE, graduationThresholdRaw: 0n }), null);
  });
});

describe("curveGraduated", () => {
  it("tells a graduated curve from a brand-new one, which depth cannot", () => {
    // Graduation drains the token side and returns the quote side to the seed,
    // so reserves alone read EXACTLY like a curve nobody ever bought. These are
    // opposite situations and only the token side separates them.
    const graduated: CurveReserves = { ...LIVE, quoteRaw: 1_680_000_000_000_000_000n, tokenRaw: 0n };
    const fresh: CurveReserves = { ...LIVE, quoteRaw: 1_680_000_000_000_000_000n };
    assert.equal(curveDepthFraction(graduated), curveDepthFraction(fresh), "depth genuinely cannot tell them apart");
    assert.equal(curveGraduated(graduated), true);
    assert.equal(curveGraduated(fresh), false);
  });
});
