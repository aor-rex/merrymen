import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MIN_PROBE_IN, impactBps, judgeImpact, probeAmountIn } from "./impact";

/**
 * The guard that venues/uniswap.ts claimed existed for months before it did.
 *
 * Its whole safety argument is that it can only ever REFUSE — never permit more
 * — which is what keeps it clear of the propose/dispose line that
 * venues/depth.invariant.test.ts pins. The last test in this file asserts that
 * property directly rather than leaving it as prose.
 */

const usdg = (n: number) => BigInt(Math.round(n * 1e6));

test("a deep pool prices linearly, so impact is ~0", () => {
  // 1000 in → 1000 out; probe 10 in → 10 out. Same rate at both sizes.
  const bps = impactBps({ amountIn: usdg(1000), amountOut: usdg(1000), probeIn: usdg(10), probeOut: usdg(10) });
  assert.equal(bps, 0);
});

test("the pool FEE cancels between the two quotes — that is why the cap can be tight", () => {
  // Both quotes pay 1%: probe 10 → 9.9, full 1000 → 990. Zero impact, despite
  // a 100bps fee on both legs. If the fee did not cancel the default cap would
  // have to be inflated past every fee tier and would stop meaning anything.
  const bps = impactBps({ amountIn: usdg(1000), amountOut: usdg(990), probeIn: usdg(10), probeOut: usdg(9.9) });
  assert.equal(bps, 0);
});

test("a thin pool is caught: 5% worse than marginal reads as ~500bps", () => {
  // Probe gets 1.0 out per 1 in; the full order averages 0.95.
  const bps = impactBps({ amountIn: usdg(1000), amountOut: usdg(950), probeIn: usdg(10), probeOut: usdg(10) });
  assert.equal(bps, 500);
});

test("a catastrophic fill is caught rather than floored", () => {
  // 40% through the book — the exact case minOut cannot see, because minOut is
  // derived from this very quote and would sit 1% below its own 40%.
  const bps = impactBps({ amountIn: usdg(5000), amountOut: usdg(3000), probeIn: usdg(50), probeOut: usdg(50) });
  assert.equal(bps, 4000);
});

test("a probe that finds NO liquidity is unknown, never zero", () => {
  // The most dangerous possible confusion: probeOut of 0 means the probe found
  // nothing, which is the OPPOSITE of "no impact".
  assert.equal(impactBps({ amountIn: usdg(1000), amountOut: usdg(900), probeIn: usdg(10), probeOut: 0n }), null);
  assert.equal(impactBps({ amountIn: 0n, amountOut: usdg(1), probeIn: usdg(1), probeOut: usdg(1) }), null);
  assert.equal(
    impactBps({ amountIn: usdg(10), amountOut: usdg(10), probeIn: usdg(10), probeOut: usdg(10) }),
    null,
    "a probe the same size as the order measures nothing",
  );
});

test("tick noise does not become a negative 'discount'", () => {
  const bps = impactBps({ amountIn: usdg(1000), amountOut: usdg(1000.5), probeIn: usdg(10), probeOut: usdg(10) });
  assert.equal(bps, 0);
});

test("an order too small to probe returns null, NOT the full amount", () => {
  // Returning amountIn would make probeOut === amountOut and yield exactly 0
  // impact for a trade whose impact was never measured — 'unknown as zero',
  // the one thing this codebase does not do.
  assert.equal(probeAmountIn(MIN_PROBE_IN), null);
  assert.equal(probeAmountIn(MIN_PROBE_IN - 1n), null);
  assert.equal(probeAmountIn(0n), null);
  assert.equal(probeAmountIn(-5n), null);
});

test("a normal order probes at 1%, and a small one at the floor", () => {
  assert.equal(probeAmountIn(usdg(1000)), usdg(10));
  const small = probeAmountIn(usdg(0.5));
  assert.equal(small, MIN_PROBE_IN, "floored, but still strictly smaller than the order");
  assert.ok(small! < usdg(0.5));
});

test("a buy with UNKNOWN impact is refused; an exit with unknown impact is not", () => {
  const buy = judgeImpact({ bps: null, maxBps: 300, isExit: false });
  assert.equal(buy.ok, false);
  assert.equal(buy.ok === false && buy.rule, "impact-unknown");

  const exit = judgeImpact({ bps: null, maxBps: 300, isExit: true });
  assert.equal(exit.ok, true, "money coming home is never blocked on a number we could not read");
});

test("an expensive EXIT goes through, loudly — refusing one is how you hold a rug forever", () => {
  const v = judgeImpact({ bps: 4000, maxBps: 300, isExit: true });
  assert.equal(v.ok, true);
  assert.match(v.ok === true ? (v.note ?? "") : "", /costly exit/i, "but the tape must show what it cost");
});

test("an expensive BUY is refused, with the number in the message", () => {
  const v = judgeImpact({ bps: 4000, maxBps: 300, isExit: false });
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.rule, "impact-cap");
  assert.match(v.ok === false ? v.detail : "", /40\.00%/);
  assert.match(v.ok === false ? v.detail : "", /3\.00%/);
});

test("a cap of 0 disables the guard entirely, including for unknowns", () => {
  // The owner who wants 'any amount' must have a way to say so.
  assert.equal(judgeImpact({ bps: 9999, maxBps: 0, isExit: false }).ok, true);
  assert.equal(judgeImpact({ bps: null, maxBps: 0, isExit: false }).ok, true);
});

test("the boundary is inclusive — exactly at the cap passes", () => {
  assert.equal(judgeImpact({ bps: 300, maxBps: 300, isExit: false }).ok, true);
  assert.equal(judgeImpact({ bps: 301, maxBps: 300, isExit: false }).ok, false);
});

test("THE SAFETY PROPERTY: this guard can only ever refuse, never permit more", () => {
  // The reason a post-quote impact check does not violate the propose/dispose
  // line pinned by venues/depth.invariant.test.ts. That invariant's fear is an
  // attacker flooding a pool so the agent SIZES UP; a cap that moves with
  // liquidity is a cap an attacker can manufacture.
  //
  // Here, more liquidity means a better probe ratio means LOWER measured
  // impact means the trade passes — i.e. the agent gets exactly the fill it
  // would have got with no guard at all. There is no input to judgeImpact that
  // makes it approve something a bare execution would not have done, because
  // its only two outcomes are "proceed unchanged" and "refuse".
  const sizes = [null, 0, 1, 300, 301, 5000, 10_000];
  for (const bps of sizes) {
    for (const isExit of [true, false]) {
      const v = judgeImpact({ bps, maxBps: 300, isExit });
      // There is no third outcome, and nothing here can enlarge a trade.
      assert.ok(v.ok === true || v.ok === false);
      assert.equal("size" in v, false, "the verdict must never carry a size — it may refuse, not resize");
      assert.equal("amountIn" in v, false);
    }
  }
});

test("the module consumes no depth data — the propose/dispose line, checked as source", () => {
  // The same shape venues/depth.invariant.test.ts uses on policy.ts. If someone
  // later 'improves' this by reading the depth cache, the guard stops being
  // measured from the executor's own simulation and becomes something an
  // outsider can move.
  const src = readFileSync(fileURLToPath(new URL("impact.ts", import.meta.url)), "utf8");
  for (const symbol of ["readPoolDepth", "cashWithinBps", "deriveZones", "PoolDepth", "DepthZone", "TokenDepth", "createDepthReader", "depthReader"]) {
    assert.equal(src.includes(symbol), false, `impact.ts must not reference ${symbol}`);
  }
  assert.equal(/from\s+["'].*venues\/depth["']/.test(src), false, "and must not import the depth reader");
});

test("the formula tracks closed-form constant-product impact, and understates it by ~1%", () => {
  // Validated against arithmetic rather than against the reasoning that
  // produced it. For a CPMM, out(a) = y·a/(x+a), so impact against a marginal
  // price at zero is exactly dx/(x+dx).
  //
  // This measures against a probe at 1% of the order rather than at zero, which
  // gives (dx−probe)/(x+dx) — a known 1% UNDERSTATEMENT. It is named here
  // rather than hidden: at a 300bps cap the guard really admits up to ~303bps.
  // Probing smaller would narrow the gap and lose precision to rounding on a
  // 6dp token, which is the worse trade.
  const X = 1_000_000n * 10n ** 6n;
  const Y = 1_000_000n * 10n ** 6n;
  const out = (a: bigint) => (Y * a) / (X + a);
  for (const pct of [1, 5, 10, 25]) {
    const dx = (X * BigInt(pct * 100)) / 10_000n;
    const probe = probeAmountIn(dx)!;
    const measured = impactBps({ amountIn: dx, amountOut: out(dx), probeIn: probe, probeOut: out(probe) })!;
    const closedForm = Number((dx * 10_000n) / (X + dx));
    const ratio = measured / closedForm;
    assert.ok(
      ratio > 0.985 && ratio <= 1.0,
      `order at ${pct}% of reserve: measured ${measured}bps vs closed-form ${closedForm}bps (ratio ${ratio})`,
    );
  }
});
