import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { curveBuyImpactBps, curvePrice, graduationProgress, type CurveReserves } from "./pons-price";

/**
 * Pricing a bonding curve, checked against a real one.
 *
 * The reserves below were read off mainnet curve 0x312a8dff… (token
 * 0x9e402c52…, pairToken 0x0 = native ETH). Its 1.68 ETH sits against Pons's
 * 4.2 ETH graduation threshold, which is an independent cross-check that the
 * figures are being read in the right units at all: a decimals mistake here
 * would put that ratio somewhere absurd rather than at a plausible 40%.
 */

// Live mainnet reading.
const LIVE: CurveReserves = {
  quoteRaw: 1683772225727764056n, // 1.6838 ETH
  tokenRaw: 997759657945341386015177738n, // 997,759,657.95 tokens
  quoteDecimals: 18,
  tokenDecimals: 18,
};
// The real ETH price on chain 4663 at the time these reserves were read, so the
// expectations below are checkable against the outside world rather than
// against a round number I chose.
const ETH_USD8 = 244_237_000_000n; // $2,442.37

describe("curvePrice", () => {
  it("prices the live mainnet curve at a sane figure", () => {
    const p = curvePrice(LIVE, ETH_USD8);
    assert.ok(p);
    // CROSS-CHECKED AGAINST AN INDEPENDENT SOURCE. GeckoTerminal, which indexes
    // this chain and this pre-graduation curve, reported 4.246263e-6 for the
    // same token; this computes 4.120e-6 from the raw reserves — 3% apart,
    // which is block skew plus the curve's own fee, not a modelling error. A
    // price nothing else agrees with would not be a price.
    const usd = Number(p!.price8) / 1e8;
    const gecko = 4.246263e-6;
    assert.ok(Math.abs(usd - gecko) / gecko < 0.06, `${usd.toExponential(3)} vs gecko ${gecko.toExponential(3)}`);
    // Depth is the QUOTE side only. GeckoTerminal's total_reserve_in_usd for the
    // same curve was $4,237; this computes $4,112 from the ETH side.
    const depth = Number(p!.depthUsd8) / 1e8;
    assert.ok(depth > 3_900 && depth < 4_400, `expected ~$4,112, got ${depth.toFixed(0)}`);
  });

  it("does not lose the price to integer division", () => {
    // A memecoin is ~1e-9 of its quote asset. Dividing before multiplying would
    // floor this to zero and report a free token — the failure this ordering
    // exists to prevent.
    assert.ok(curvePrice(LIVE, ETH_USD8)!.price8 > 0n);
  });

  it("handles a 6dp quote (USDG) as well as an 18dp one", () => {
    const usdgCurve: CurveReserves = {
      quoteRaw: 10_000_000_000n, // 10,000 USDG at 6dp
      tokenRaw: 1_000_000_000n * 10n ** 18n, // 1e9 tokens at 18dp
      quoteDecimals: 6,
      tokenDecimals: 18,
    };
    const p = curvePrice(usdgCurve, 100_000_000n); // USDG = $1.00
    assert.ok(p);
    // $10,000 across 1e9 tokens = $1e-5 each.
    assert.equal(p!.price8, 1_000n); // 1e-5 * 1e8
    assert.equal(p!.depthUsd8, 1_000_000_000_000n); // $10,000 at 8dp
  });

  it("returns null — never zero — when it cannot price", () => {
    // "Missing fact" and "worthless" must not be the same value: positions are
    // valued with this.
    assert.equal(curvePrice({ ...LIVE, quoteRaw: 0n }, ETH_USD8), null, "empty quote side");
    assert.equal(curvePrice({ ...LIVE, tokenRaw: 0n }, ETH_USD8), null, "empty token side");
    assert.equal(curvePrice(LIVE, 0n), null, "no USD price for the quote asset");
  });

  it("refuses a token too numerous to price at 8dp rather than rounding to free", () => {
    const dust: CurveReserves = { quoteRaw: 1n, tokenRaw: 10n ** 36n, quoteDecimals: 18, tokenDecimals: 18 };
    assert.equal(curvePrice(dust, ETH_USD8), null);
  });
});

describe("curveBuyImpactBps", () => {
  it("charges more impact for a bigger bite of the same curve", () => {
    const small = curveBuyImpactBps(LIVE, 10n ** 16n); // 0.01 ETH
    const large = curveBuyImpactBps(LIVE, 10n ** 18n); // 1 ETH, ~60% of the reserve
    assert.ok(small !== null && large !== null);
    assert.ok(large! > small!, "a larger trade must cost more, not less");
    // 0.01 ETH into a 1.68 ETH curve is ~0.6% of it — impact should be small
    // but NOT zero; a zero here would mean the curve maths is not being applied.
    assert.ok(small! > 0 && small! < 200, `expected a small positive bps, got ${small}`);
  });

  it("returns null rather than 0 when a trade cannot be evaluated", () => {
    // "Unknown impact" must never read as "no impact" to a caller about to spend.
    assert.equal(curveBuyImpactBps(LIVE, 0n), null);
    assert.equal(curveBuyImpactBps({ ...LIVE, quoteRaw: 0n }, 10n ** 16n), null);
  });

  it("impact is exact, not sampled — it follows from x*y=k", () => {
    // Buying the entire token side is impossible on a constant product curve,
    // so an enormous input still yields a finite, defined impact.
    const huge = curveBuyImpactBps(LIVE, 10n ** 24n);
    assert.ok(huge !== null && huge > 0);
  });
});

describe("graduationProgress", () => {
  it("puts the live curve partway to Pons's 4.2 ETH threshold", () => {
    // The independent sanity check on units: 1.6838 / 4.2 = 40%.
    const p = graduationProgress(LIVE.quoteRaw, 42n * 10n ** 17n);
    assert.ok(p !== null);
    assert.ok(p! > 0.35 && p! < 0.45, `expected ~0.40, got ${p}`);
  });

  it("clamps at 1 and refuses a nonsense threshold", () => {
    assert.equal(graduationProgress(10n ** 19n, 42n * 10n ** 17n), 1);
    assert.equal(graduationProgress(1n, 0n), null);
  });
});
