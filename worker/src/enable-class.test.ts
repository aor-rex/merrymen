/**
 * A WRITE THAT ERASES WHAT THE OWNER CHOSE IS WORSE THAN NO WRITE.
 *
 * `put` replaces the whole settings blob, so enabling eight fields by writing
 * eight fields would silently delete everything else — including settings an
 * owner deliberately tuned. Dave is the live example: `maxImpactBps: 500` and
 * `slippageBps: 200`, both looser than the defaults, both his.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CANARY, describeCanaryChange, mergeCanary, MUST_PRESERVE } from "./enable-class";

describe("enabling the class route preserves everything else", () => {
  it("KEEPS EVERY FIELD IT DOES NOT SET", () => {
    const owner: Record<string, unknown> = {
      maxImpactBps: 500,
      slippageBps: 200,
      liveTradingEnabled: true,
      paperTradingEnabled: true,
      strategy: "steady-basket",
      basketSymbols: ["NVDA"],
      telegramBotToken: "secret",
      assetMode: "all",
    };
    const next = mergeCanary(owner);
    for (const k of MUST_PRESERVE) {
      if (owner[k] === undefined) continue;
      assert.deepEqual(next[k], owner[k], `${k} must survive the write`);
    }
  });

  it("and sets exactly the canary fields", () => {
    const next = mergeCanary({ maxImpactBps: 500 });
    for (const [k, v] of Object.entries(CANARY)) assert.equal(next[k], v, `${k} must be set`);
  });

  it("never touches a field outside its own key set", () => {
    // Structural rather than filtered: the merge spreads CANARY's keys and no
    // others, so a field can only change if it is one of them.
    const owner = { maxImpactBps: 500, slippageBps: 200 };
    const next = mergeCanary(owner);
    const changed = Object.keys(next).filter(
      (k) => (owner as Record<string, unknown>)[k] !== undefined && next[k] !== (owner as Record<string, unknown>)[k],
    );
    assert.deepEqual(changed, []);
  });

  it("works on a tenant with no settings row at all", () => {
    const next = mergeCanary(null);
    assert.equal(next.classSnipeEnabled, true);
  });
});

describe("the canary runs the NORMAL exit rules", () => {
  it("keeps the six-hour hold", () => {
    // Shortening this to finish the demo sooner would prove nothing about the
    // exit that matters.
    assert.equal(CANARY.classMaxHoldSec, 21_600);
  });

  it("and the 85% graduation exit", () => {
    assert.equal(CANARY.classExitAtGraduationPct, 85);
  });

  it("and the 250 USDG depth floor", () => {
    assert.equal(CANARY.classMinDepthUsdg, 250);
  });

  it("and a scout budget that actually admits the position count it claims", () => {
    /**
     * `scoutAllows` refuses outright at 0, so scoutEnabled with no budget makes
     * the whole route inert while looking configured. And a budget below
     * positions x entry silently caps the count below what classMaxPositions
     * says — the third entry would be refused with scout-budget, which reads as
     * a market condition and is not one.
     */
    assert.ok(CANARY.scoutBudgetUsdg > 0, "0 refuses every unpriceable buy");
    assert.ok(
      CANARY.scoutBudgetUsdg >= CANARY.classMaxPositions * CANARY.classPerEntryUsdg,
      `${CANARY.scoutBudgetUsdg} cannot hold ${CANARY.classMaxPositions} x ${CANARY.classPerEntryUsdg}`,
    );
  });
});

describe("the operator sees what changed", () => {
  it("names a field that was unset", () => {
    const lines = describeCanaryChange(null).join("\n");
    assert.match(lines, /classSnipeEnabled\s+\(unset\) -> true/);
  });

  it("and distinguishes an unchanged field from a changed one", () => {
    const lines = describeCanaryChange({ classMinDepthUsdg: 250, classPerEntryUsdg: 0 }).join("\n");
    assert.match(lines, /classMinDepthUsdg\s+250 \(unchanged\)/);
    assert.match(lines, /classPerEntryUsdg\s+0 -> 5/);
  });
});
