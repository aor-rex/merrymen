import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWhy, type Why } from "./reasons";

/**
 * These strings go on a PUBLIC page, under an agent's name, next to somebody's
 * money. They are the only prose a deterministic strategy ever publishes, and
 * `renderWhy` is the only function allowed to produce them — which is what makes
 * "is this safe to publish?" a question about types rather than about vigilance.
 *
 * So the tests here are about the two things that would embarrass us: a sentence
 * that reads badly, and a sentence that claims something the strategy cannot
 * actually know.
 */

const ALL: Why[] = [
  { code: "dca-leg", symbol: "NVDA", usdgRaw: 16_660_000n, weightBps: 3_333, legs: 3 },
  { code: "park", usdgRaw: 24_100_000n, floorRaw: 50_000_000n, clamped: false },
  { code: "park", usdgRaw: 24_100_000n, floorRaw: 50_000_000n, clamped: true },
  { code: "unpark", usdgRaw: 66_000_000n, needRaw: 66_000_000n },
  { code: "gap-enter", symbol: "AAPL", usdgRaw: 33_330_000n },
  { code: "gap-exit", symbol: "AAPL" },
  { code: "keel-seed", usdgRaw: 20_000_000n, legs: 3 },
  { code: "keel-trim", symbol: "TSLA", overRaw: 12_400_000n },
  { code: "keel-top", symbol: "PLTR", underRaw: 9_800_000n },
  { code: "dip", symbol: "NVDA", dipBps: 240, priced: 3, usdgRaw: 25_000_000n },
];

describe("every reason is publishable prose", () => {
  it("renders a real sentence for every case", () => {
    for (const w of ALL) {
      const s = renderWhy(w);
      assert.ok(s.length > 20, `too short for ${w.code}: ${s}`);
      assert.ok(s.length < 220, `over the /why truncation point for ${w.code}: ${s.length}`);
      assert.doesNotMatch(s, /undefined|NaN|\[object/, `leaked a value in ${w.code}: ${s}`);
    }
  });

  it("never promises anything", () => {
    // The strategy proposes trades. It does not know whether one filled, at what
    // price, or what happened next — so it must not say. This is the same rule
    // the scoreboard applies to P&L: do not publish what you cannot back.
    for (const w of ALL) {
      const s = renderWhy(w);
      assert.doesNotMatch(s, /\bprofit|\bgain|\bwin|will |should |expect/i, `a claim in ${w.code}: ${s}`);
      assert.doesNotMatch(s, /!/, `an exclamation in ${w.code}: ${s}`);
    }
  });

  it("formats money the way every other surface does", () => {
    // 6dp raw in, two decimals out. Getting this wrong publishes a number that
    // is a million times off and looks entirely plausible.
    assert.match(renderWhy(ALL[0]!), /16\.66 USDG into NVDA/);
    assert.match(renderWhy({ code: "keel-seed", usdgRaw: 1_234_567_890n, legs: 2 }), /1,234\.56 USDG/);
    assert.match(renderWhy({ code: "keel-trim", symbol: "X", overRaw: 5_000_000n }), /5\.00 USDG/);
  });

  it("trims percentages instead of printing 33.0%", () => {
    assert.match(renderWhy(ALL[0]!), /33% of a 3-leg basket/);
    assert.match(renderWhy(ALL[9]!), /2\.4% off its rolling high/);
  });

  it("says something DIFFERENT when the budget clamped the sweep", () => {
    // Otherwise the agent claims it parked the idle cash when it parked part of
    // it, and the balance the reader sees will not match the sentence.
    const plain = renderWhy(ALL[1]!);
    const clamped = renderWhy(ALL[2]!);
    assert.notEqual(plain, clamped);
    assert.match(clamped, /what today's budget still allows/);
  });

  it("the gap exit makes no claim about what it made", () => {
    // The tempting sentence here is "...locking in the gap", which the strategy
    // has no way to know. It knows the feed came back; that is all.
    const s = renderWhy({ code: "gap-exit", symbol: "AAPL" });
    assert.match(s, /the market reopened/);
    assert.doesNotMatch(s, /lock|captur|profit|made/i);
  });
});
