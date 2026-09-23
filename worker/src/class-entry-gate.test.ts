/**
 * THE CLASS ROUTE'S ENTRY GATE SAYS WHY IT CLOSED.
 *
 * Under a tripped breaker the tick stops asking the class route for entries —
 * every one would be a buy the wall refuses. But it said nothing, and the
 * strategy's own breaker reason is raised only by a strategy that has legs to
 * buy. So for an agent whose class route is the buyer and whose strategy has
 * no legs — Crypto only over an equities basket, with a Pons vault sealed in —
 * the one buyer went silent and the owner was told nothing at all: intents 0,
 * no idle reason, no event (the checker's probe C). The gate now hands the
 * breaker's reason to the idle channel when it is what closed a route that
 * would have looked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classEntryGate, classRouteLooks } from "./class-entry-gate";
import { IdleChannel, modeEmptiedFact, type ShownNotice } from "./idle-notice";
import { renderWhy, type Why } from "./strategies/reasons";
import { steadyBasketTick } from "./strategies/steady-basket";
import { drawdownOf, takeTick, type Snapshot } from "./strategies/types";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const CLASS_VAULT = "0x9999999999999999999999999999999999999999";

const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });
const CLEAR = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 990_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  cashUsdg: 900_000_000n,
  vaultUsdg: 0n,
  holdings: new Map(),
  prices: new Map(),
  pausedTokens: new Set(),
  staleFeeds: new Set(),
  sequencerUp: true,
  spendHeadroomUsdg: 1_000_000_000_000n,
  perTradeCapUsdg: 1_000_000_000_000n,
  ...over,
});

const underOne: Why = { code: "under-one-buy", cashRaw: 1_000_000n, needRaw: 5_000_000n, vaultRaw: 0n };

describe("a tripped breaker that closes the class route is told to the owner", () => {
  it("THE CHECKER'S CASE: no legs, the class route is the buyer — and the owner gets the breaker's warning", async () => {
    const book = snap({ drawdown: TRIPPED });
    // Crypto only over an equities basket: every leg filtered out.
    const tick = takeTick(steadyBasketTick({ legs: [], buyPerTickUsdg: 25_000_000n, idleFloorUsdg: 50_000_000n, swapRouter: ROUTER, vault: ROUTER, usdg: USDG }, book));
    assert.equal(tick.intents.length, 0);
    assert.equal(tick.idle, undefined, "the strategy has no legs, so it has no breaker to report");
    const modeEmptied = modeEmptiedFact("crypto", (mode) => (mode === "all" ? 3 : 0));
    const gate = classEntryGate({
      snap: book,
      routeLooks: classRouteLooks({ paper: false, assetMode: "crypto", vault: CLASS_VAULT }),
      idle: tick.idle,
    });
    assert.equal(gate.propose, false, "no class entry is proposed under the breaker");
    assert.deepEqual(gate.idle, { code: "breaker-tripped", limitBps: 1_000 });

    const events: { level: string; message: string }[] = [];
    const rows: unknown[] = [];
    const ch = new IdleChannel({
      addEvent: async (_a, level, message) => {
        events.push({ level, message });
      },
      addDecision: async (row) => {
        rows.push(row);
      },
      newDecisionId: () => "d",
      shownNotice: async (): Promise<ShownNotice | null> => null,
    });
    await ch.tell({ agentId: "0xagent", strategyName: "steady-basket", idle: gate.idle, modeEmptied });
    assert.deepEqual(events, [{ level: "warn", message: renderWhy(gate.idle!) }], "a warning, at a level the desk shows");
    assert.deepEqual(rows, [], "account state stays off the public feed");
  });

  it("the strategy's own reason is kept when it gave one", () => {
    const gate = classEntryGate({ snap: snap({ drawdown: TRIPPED }), routeLooks: true, idle: underOne });
    assert.equal(gate.propose, false);
    assert.equal(gate.idle, underOne);
  });

  it("A ROUTE THAT WOULD NOT HAVE LOOKED is not given a reason it did not have", () => {
    for (const routeLooks of [
      classRouteLooks({ paper: true, assetMode: "crypto", vault: CLASS_VAULT }),
      classRouteLooks({ paper: false, assetMode: "stocks", vault: CLASS_VAULT }),
      classRouteLooks({ paper: false, assetMode: "all", vault: null }),
    ]) {
      const gate = classEntryGate({ snap: snap({ drawdown: TRIPPED }), routeLooks, idle: undefined });
      assert.equal(gate.propose, false);
      assert.equal(gate.idle, undefined);
    }
  });

  it("NOT TRIPPED — or not measured — the route is asked, and the idle reason is the strategy's alone", () => {
    for (const drawdown of [CLEAR, null, undefined]) {
      const gate = classEntryGate({ snap: snap({ drawdown }), routeLooks: true, idle: underOne });
      assert.equal(gate.propose, true, JSON.stringify(drawdown));
      assert.equal(gate.idle, underOne);
      assert.equal(classEntryGate({ snap: snap({ drawdown }), routeLooks: true, idle: undefined }).idle, undefined);
    }
  });
});

describe("whether the class route would look at all — proposeClassEntries' own first gates", () => {
  it("live, a coin-admitting mode, and a vault sealed into the grant", () => {
    assert.equal(classRouteLooks({ paper: false, assetMode: "crypto", vault: CLASS_VAULT }), true);
    assert.equal(classRouteLooks({ paper: false, assetMode: "all", vault: CLASS_VAULT }), true);
  });

  it("paper cannot simulate a class fill; stocks-only excludes the route; no vault, no route", () => {
    assert.equal(classRouteLooks({ paper: true, assetMode: "all", vault: CLASS_VAULT }), false);
    assert.equal(classRouteLooks({ paper: false, assetMode: "stocks", vault: CLASS_VAULT }), false);
    assert.equal(classRouteLooks({ paper: false, assetMode: "all", vault: null }), false);
    assert.equal(classRouteLooks({ paper: false, assetMode: "all", vault: undefined }), false);
  });
});
