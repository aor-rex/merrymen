/**
 * Discovery is the one path where a THIRD PARTY's data reaches a message the
 * owner reads and may act on. So the tests care about two things: that it picks
 * the right side of a pair, and that nothing an attacker controls — a token
 * symbol, a malformed event — gets through unshaped.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH } from "../../packages/core/src/index";
import { PONS_MAX_EVALUATE, describeDiscovery, newTokenOf, ponsScanWindow, sanitizeSymbol, type Discovery } from "./discovery";

const USDG = (CASH.USDG as string).toLowerCase() as `0x${string}`;
const WETH = (CASH.WETH as string).toLowerCase() as `0x${string}`;
const CATE = "0x00000000000000000000000000000000000000c1" as const;
const DOGE = "0x00000000000000000000000000000000000000d0" as const;

const pair = (a: `0x${string}`, b: `0x${string}`) => ({
  token: a,
  quote: b,
  symbol: "",
  decimals: 18,
  protocol: "uniswap",
  createdAt: 1,
  txHash: "0x",
});

describe("newTokenOf — which side actually launched", () => {
  it("picks the non-cash side, whichever order it arrives in", () => {
    assert.equal(newTokenOf(pair(CATE, USDG)), CATE);
    assert.equal(newTokenOf(pair(USDG, CATE)), CATE);
    assert.equal(newTokenOf(pair(CATE, WETH)), CATE);
    assert.equal(newTokenOf(pair(WETH, CATE)), CATE);
  });

  it("says nothing about a cash/cash pool — USDG/WETH is not a launch", () => {
    assert.equal(newTokenOf(pair(USDG, WETH)), null);
    assert.equal(newTokenOf(pair(WETH, USDG)), null);
  });

  it("says nothing about an exotic pair with no cash leg", () => {
    // Nothing to value it against, so announcing it would be noise the owner
    // can't act on anyway.
    assert.equal(newTokenOf(pair(CATE, DOGE)), null);
  });

  it("treats native ETH as a cash side", () => {
    const NATIVE = "0x0000000000000000000000000000000000000000" as const;
    assert.equal(newTokenOf(pair(CATE, NATIVE)), CATE);
  });

  it("is case-insensitive about the cash addresses", () => {
    const upper = USDG.toUpperCase().replace("0X", "0x") as `0x${string}`;
    assert.equal(newTokenOf(pair(CATE, upper)), CATE);
  });
});

/**
 * A token's symbol is chosen by whoever deployed it and lands in a Telegram
 * message and an event line. Same reasoning as the memory sanitizers: strip
 * anything that could pass for markup or a list separator, and cap the length.
 */
describe("sanitizeSymbol", () => {
  it("keeps an ordinary ticker intact", () => {
    assert.equal(sanitizeSymbol("CATE"), "CATE");
    assert.equal(sanitizeSymbol("wstETH-1"), "wstETH-1");
  });

  it("strips markup, separators and whitespace", () => {
    assert.equal(sanitizeSymbol("<b>CATE</b>"), "bCATEb");
    assert.equal(sanitizeSymbol("CATE,NVDA"), "CATENVDA");
    assert.equal(sanitizeSymbol("CA TE"), "CATE");
    assert.equal(sanitizeSymbol("CATE\n/grant"), "CATEgrant");
  });

  it("caps the length so a symbol can't flood the message", () => {
    assert.equal(sanitizeSymbol("x".repeat(200)).length, 16);
  });

  it("never returns empty — an unnamed token still needs a label", () => {
    assert.equal(sanitizeSymbol(""), "?");
    assert.equal(sanitizeSymbol("<<<>>>"), "?");
  });
});

describe("describeDiscovery — what the owner is told", () => {
  const base: Discovery = {
    token: CATE,
    symbol: "CATE",
    decimals: 18,
    createdAt: 0,
    liquidityUsdg: 120_000_000_000n, // $120k
    priceable: true,
    price8: 100_000n,
    fdvUsd: 800_000,
  };

  it("names the token, its depth and whether it can be priced", () => {
    const s = describeDiscovery(base);
    assert.match(s, /CATE/);
    assert.match(s, /120,000/);
    assert.match(s, /deep enough/);
  });

  it("gives the guard's own reason when it can't be priced", () => {
    const s = describeDiscovery({ ...base, priceable: false, reason: "pool too thin: 300 USDG" });
    assert.match(s, /can't price it yet/);
    assert.match(s, /too thin/);
  });

  it("handles an unpriceable pool with no depth reading at all", () => {
    const s = describeDiscovery({ ...base, liquidityUsdg: null, priceable: false, reason: "no route to USDG yet" });
    assert.match(s, /depth unknown/);
    assert.match(s, /no route/);
  });

  it("shows a truncated address so the owner can look it up", () => {
    assert.match(describeDiscovery(base), /0x00000000…/);
  });
});

/**
 * The launchpad half of discovery.
 *
 * A Pons launch is a different KIND of sighting from a Uniswap pool, and the
 * tests that matter are the ones where saying so is load-bearing: the owner's
 * price guards did not run, there is no pool to route through, and the depth
 * figure means something else. Getting any of those wrong reports a confidence
 * nothing established.
 */
describe("describeDiscovery — a Pons launch", () => {
  const launch: Discovery = {
    token: CATE,
    symbol: "PONSY",
    decimals: 18,
    createdAt: 0,
    liquidityUsdg: 640_000_000n, // $640
    priceable: false,
    reason: "trades on a Pons curve at 8.0% of graduation",
    price8: null,
    fdvUsd: null,
    curve: {
      curve: "0x00000000000000000000000000000000000000e1",
      quoteToken: `0x${"0".repeat(40)}`,
      graduationThresholdRaw: 4_200_000_000_000_000_000n,
      depthFraction: 0.08,
    },
  };

  it("does not call it a new PAIR — there is neither a pair nor a pool", () => {
    const s = describeDiscovery(launch);
    assert.ok(!/new pair/.test(s), "a pre-graduation token has no pool at all");
    assert.match(s, /pons launch/);
    assert.match(s, /trades on its curve/);
  });

  it("leads with progress toward graduation, the comparable measure", () => {
    // Depth in USD is not comparable across this launchpad: 42.8% of launches
    // are quoted in stock tokens and 2.3% in cbBTC, and the thresholds are not
    // a constant dollar value either. Progress along a curve's own threshold is.
    assert.match(describeDiscovery(launch), /8\.0% to graduation/);
  });

  it("still names the token and its depth", () => {
    const s = describeDiscovery(launch);
    assert.match(s, /PONSY/);
    assert.match(s, /\$640 deep/);
  });

  it("says depth unknown for a curve quoted in something we cannot price", () => {
    // Roughly half of launches are. Null must read as unknown, never as $0 —
    // those are different claims and only one of them is true.
    const s = describeDiscovery({ ...launch, liquidityUsdg: null });
    assert.match(s, /depth unknown/);
    assert.ok(!/\$0 deep/.test(s));
  });

  it("never claims the price guards passed", () => {
    // `priceable` means the owner's depth and divergence guards ran and were
    // satisfied. On a curve they cannot run at all — poolPriceUsable refuses
    // with no-twap before it even looks at depth.
    assert.equal(launch.priceable, false);
    assert.ok(!/deep enough for me to price/.test(describeDiscovery(launch)));
  });

  it("leaves the ORDINARY pool line untouched", () => {
    // The two shapes share one function; the pool wording is asserted above and
    // by four other tests in this file.
    assert.match(describeDiscovery({ ...launch, curve: undefined, priceable: true }), /new pair/);
  });
});

/**
 * The scan clock, which is where a silent hole would open.
 *
 * The window is measured from the last SUCCESSFUL pass. An earlier version
 * advanced it before the RPC call and returned early on failure, so the ~40
 * launches inside a failed window were read by no pass ever — and one transient
 * 429 from the RPC was enough to open one. These tests exist because that
 * failure produces no error and no log anyone would notice.
 */
describe("ponsScanWindow", () => {
  const base = { intervalSec: 300, blocksPerSec: 10n };

  it("is not due before the interval, and is due after", () => {
    assert.equal(ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1200 }).due, false);
    assert.equal(ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1300 }).due, true);
  });

  it("runs immediately on a cold start, looking back one interval", () => {
    const w = ponsScanWindow({ ...base, lastSuccessAt: 0, nowSec: 50_000 });
    assert.equal(w.due, true);
    assert.equal(w.lookbackBlocks, BigInt(300 + 60) * 10n);
  });

  it("WIDENS after a failure instead of skipping the window", () => {
    // The whole point. The caller does not advance lastSuccessAt on failure, so
    // the next pass must cover the failed window too.
    const first = ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1300 });
    const afterFailure = ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1600 });
    assert.ok(afterFailure.lookbackBlocks > first.lookbackBlocks, "the retry must reach further back");
    assert.equal(afterFailure.elapsedSec, 600, "two intervals of ground to make up");
  });

  it("covers the whole gap with no hole, across consecutive failures", () => {
    // Walk five passes where every one fails, then one succeeds, and check the
    // final window reaches back to the last success.
    const lastSuccess = 1000;
    for (let n = 1; n <= 5; n++) {
      const now = lastSuccess + 300 * n;
      const w = ponsScanWindow({ ...base, lastSuccessAt: lastSuccess, nowSec: now });
      const reachesBackTo = now - Number(w.lookbackBlocks / 10n);
      assert.ok(reachesBackTo <= lastSuccess, `pass ${n} left a hole: reaches ${reachesBackTo}, needs ${lastSuccess}`);
    }
  });

  it("overlaps rather than abutting — re-reading is free, missing is permanent", () => {
    const w = ponsScanWindow({ ...base, lastSuccessAt: 1000, nowSec: 1300 });
    const reachesBackTo = 1300 - Number(w.lookbackBlocks / 10n);
    assert.ok(reachesBackTo < 1000, "the window must extend past the last success, not stop at it");
  });

  it("never produces a negative lookback from a clock that went backwards", () => {
    // NTP correction, or a restored snapshot. A negative here would throw on
    // the BigInt conversion and take the pass down.
    const w = ponsScanWindow({ ...base, lastSuccessAt: 9_999, nowSec: 1_000 });
    assert.equal(w.elapsedSec, 0);
    assert.ok(w.lookbackBlocks >= 0n);
    assert.equal(w.due, false);
  });
});

/**
 * The per-pass evaluation cap.
 *
 * A normal pass sees ~40 launches. After an outage the lookback widens until it
 * clamps at ~8.4 hours — roughly 4,000 launches, and one sequential eth_call
 * each against a public RPC that already returns 429s under much less. The cap
 * exists so a catch-up pass cannot rate-limit the agent out of its own chain,
 * and the shortfall is reported rather than absorbed.
 */
describe("PONS_MAX_EVALUATE", () => {
  it("is large enough for an ordinary pass and small enough for a catch-up", () => {
    // ~40 launches per 5-minute pass at the measured 475/hour.
    assert.ok(PONS_MAX_EVALUATE >= 200, "an ordinary pass must never be truncated");
    assert.ok(PONS_MAX_EVALUATE <= 1000, "a clamped catch-up must not fire thousands of sequential calls");
  });
});
