/**
 * THE TICK'S IDLE WRITE, EXECUTED — and the owner's notice kept current.
 *
 * The idle block in index.ts's main() held `lastIdleReason` and wrote what
 * idleNotice decided, and nothing booted it: the checker reverted the change
 * gate, published the owner's remedy sentence as the post, and put the breaker
 * back at "ok", and every test in the repo still passed. IdleChannel is that
 * block, whole, with the store's writers injected — so these run the real
 * thing into recording sinks.
 *
 * And the second half: a reason that cannot be a post is told to the owner as
 * a WARNING, once per change. But the desk notice, the rail and the Android
 * app show only the newest warn among the newest 40 events (web
 * api/feed/route.ts LIMIT 40, newest first; terminal/live.ts and Core.kt take
 * the first warn). One warning written at the moment the breaker tripped is
 * replaced by the next warn anyone writes, or aged out by the running
 * commentary, and for the rest of a long trip the owner reads a stale, false
 * reason or nothing at all. The desk here is that rule over a recorded table.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { IdleChannel, MODE_EMPTIED_REMEDY, RESTATE_AFTER_MS, type ShownNotice } from "./idle-notice";
import { makeLlmStrategist } from "./strategist/strategy";
import { renderWhy, type Why } from "./strategies/reasons";
import { steadyBasketTick, type SteadyBasketConfig } from "./strategies/steady-basket";
import { makeTrencher, TRENCHER_DEFAULTS } from "./strategies/trencher";
import { drawdownOf, takeTick, type Snapshot } from "./strategies/types";
import { publicationSourceFor } from "./thesis-policy";

const ROUTER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x3333333333333333333333333333333333333333" as const;
const QQQ = "0x4444444444444444444444444444444444444444" as const;
const NVDA = "0x5555555555555555555555555555555555555555" as const;
const AGENT = "0xagent";
const TICK_MS = 240_000;

const TRIPPED = drawdownOf({ peakUsdg: 1_000_000_000n, equityUsdg: 875_000_000n, equityKnown: true, maxDrawdownBps: 1_000 });

const basket: SteadyBasketConfig = {
  legs: [
    { symbol: "QQQ", token: QQQ, weightBps: 5000 },
    { symbol: "NVDA", token: NVDA, weightBps: 5000 },
  ],
  buyPerTickUsdg: 25_000_000n,
  idleFloorUsdg: 50_000_000n,
  swapRouter: ROUTER,
  vault: VAULT,
  usdg: USDG,
};

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
const breaker: Why = { code: "breaker-tripped", limitBps: 1_000 };

type Ev = { agentId: string; level: string; message: string; atMs: number; id: number };

/**
 * The events table and the decisions table as recording sinks, and the desk's
 * own rule over them: newest first by (created_at, id), the newest 40, the
 * first warn or err.
 */
function desk(opts: { shown?: "unreadable" | "throws" } = {}) {
  let clock = 1_800_000_000_000;
  let seq = 0;
  let ids = 0;
  const events: Ev[] = [];
  const rows: { id: string; agent_id: string; source: string; reason: string }[] = [];
  const noticeOf = (agentId: string): ShownNotice | null => {
    const newest = events
      .filter((e) => e.agentId === agentId)
      .sort((a, b) => b.atMs - a.atMs || b.id - a.id)
      .slice(0, 40);
    const hit = newest.find((e) => (e.level === "warn" || e.level === "err") && !!e.message);
    return hit ? { message: hit.message, atMs: hit.atMs } : null;
  };
  const write = (level: string, message: string, agentId = AGENT) => {
    // created_at is whole seconds, as the table stores it.
    events.push({ agentId, level, message, atMs: Math.floor(clock / 1000) * 1000, id: ++seq });
  };
  const sinks = {
    addEvent: async (agentId: string, level: "ok" | "warn", message: string) => write(level, message, agentId),
    addDecision: async (row: { id: string; agent_id: string; source: string; reason: string }) => {
      rows.push(row);
    },
    newDecisionId: () => `d${++ids}`,
    shownNotice: async (agentId: string): Promise<ShownNotice | null | undefined> => {
      if (opts.shown === "unreadable") return undefined;
      if (opts.shown === "throws") throw new Error("database is locked");
      return noticeOf(agentId);
    },
    now: () => clock,
  };
  return {
    sinks,
    events,
    rows,
    /** What the desk notice reads right now. */
    shows: () => noticeOf(AGENT)?.message ?? "(no notice)",
    /** Somebody else's line: a trenchNotice warn, a strategist note. */
    write,
    advance: (ms: number) => {
      clock += ms;
    },
    warns: (message: string) => events.filter((e) => e.level === "warn" && e.message === message).length,
  };
}

describe("the idle write, executed", () => {
  it("A TRIPPED BREAKER IS ONE WARNING AND NO ROW — the basket's own idle reason on a tripped book", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const idle = takeTick(steadyBasketTick(basket, snap({ drawdown: TRIPPED }))).idle;
    assert.equal(idle?.code, "breaker-tripped");
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle, modeEmptied: null });
    assert.deepEqual(
      d.events.map((e) => [e.level, e.message]),
      [["warn", renderWhy(idle!)]],
    );
    assert.deepEqual(d.rows, [], "account state stays off the public feed");
    assert.equal(d.shows(), renderWhy(idle!));
  });

  it("A REASON THAT POSTS: its event at ok, and a view row in the PUBLIC register — never the owner's remedy", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "llm-strategist(anthropic:claude-opus-4)", idle: underOne, modeEmptied: null });
    assert.deepEqual(
      d.events.map((e) => [e.level, e.message]),
      [["ok", renderWhy(underOne)]],
    );
    assert.match(d.events[0]!.message, /Add funds or lower the size per trade/, "the owner's copy keeps its remedy");
    assert.equal(d.rows.length, 1);
    const row = d.rows[0]!;
    assert.equal(row.reason, renderWhy(underOne, "public"));
    assert.doesNotMatch(row.reason, /Add funds/, "a remedy is advice to the owner, not a post");
    assert.equal(row.source, publicationSourceFor("llm-strategist(anthropic:claude-opus-4)"));
    assert.equal(row.agent_id, AGENT);
    assert.equal(row.id, "d1", "the store's own id");
    assert.deepEqual(Object.keys(row).sort(), ["agent_id", "id", "reason", "source"], "no action, no symbol, no size: a view");
  });

  it("ONCE PER CHANGE: a second identical tick writes nothing — no event, no row", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    for (let i = 0; i < 5; i++) {
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
      d.advance(TICK_MS);
    }
    assert.equal(d.events.length, 1);
    assert.equal(d.rows.length, 1);
  });

  it("a tick that traded clears it, so the same reason afterwards is said again", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null });
    assert.equal(d.events.length, 1, "a tick with intents says nothing here");
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    assert.equal(d.events.length, 2);
    assert.equal(d.rows.length, 2);
  });

  it("AN EMPTIED MODE: the remedy to the owner, the plain fact to the feed — and a strategy's own reason wins", async () => {
    const fact = "nothing in your basket is a coin, and your asset mode is Crypto only — so there is nothing to trade";
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: fact });
    assert.deepEqual(d.events.map((e) => [e.level, e.message]), [["ok", `${fact}. ${MODE_EMPTIED_REMEDY}`]]);
    assert.equal(d.rows[0]!.reason, fact);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: fact });
    assert.equal(d.events.at(-1)!.message, renderWhy(underOne));
  });
});

describe("the owner's notice stays current while the breaker is tripped", () => {
  it("A LATER WARN REPLACES THE BREAKER ON THE DESK: once it has had its time, the breaker is said again", async () => {
    // The checker's probe A: a fast Trencher, one transient discovery failure
    // after the trip, then hundreds of healthy braked ticks.
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const trencher = makeTrencher({
      cfg: TRENCHER_DEFAULTS,
      brainRequired: true,
      candidates: async () => [],
      open: async () => [],
      liquidityOf: () => null,
      swapRouter: ROUTER,
      usdgToken: USDG,
    });
    const tick = async () => {
      const t = takeTick(await trencher.tick(snap({ drawdown: TRIPPED })));
      await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: t.idle, modeEmptied: null });
      d.advance(TICK_MS);
    };
    await tick();
    const sentence = renderWhy(breaker);
    assert.equal(d.shows(), sentence);
    const failure = "Trencher: Autonomous discovery could not verify its pool or custody data. Retrying; no new token authorized.";
    d.write("warn", failure);
    await tick();
    assert.equal(d.shows(), failure, "a newer notice gets its time on the desk");
    for (let i = 0; i < 500; i++) await tick();
    assert.equal(d.shows(), sentence, "and then the reason that still stands is the notice again");
    assert.equal(d.warns(sentence), 2, "said again once — not once a tick");
    assert.deepEqual(d.rows, []);
  });

  it("THE RUNNING COMMENTARY AGES IT OUT OF THE NEWEST 40: said again at once, since the desk would show nothing", async () => {
    // The checker's probe B: a strategist holding under the breaker notes
    // "N buy proposal(s) withheld" at ok every window.
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    let clock = 0;
    const strategist = makeLlmStrategist({
      driver: { name: "stub", propose: async () => ({ actions: [{ action: "buy", symbol: "NVDA", sizeUsdg: 5, reason: "dip" }] }) } as never,
      universe: { legs: new Map([["NVDA", NVDA]]), swapRouter: ROUTER, usdg: USDG, maxPerActionUsdg: 10_000_000n, maxActionsPerTick: 4 },
      decisionIntervalMs: 30 * 60_000,
      now: () => clock,
      onNote: (level, message) => d.write(level, message),
    });
    const held = snap({
      drawdown: TRIPPED,
      holdings: new Map([["NVDA", { token: NVDA, rawBalance: 10n ** 18n, valueUsdg: 50_000_000n, costUsdg: 60_000_000n, priceStale: false }]]) as never,
    });
    const sentence = renderWhy(breaker);
    for (let tick = 0; tick < 2_000; tick++) {
      clock = tick * TICK_MS;
      const t = takeTick(await strategist.tick(held));
      await ch.tell({ agentId: AGENT, strategyName: "llm-strategist", idle: t.idle, modeEmptied: null });
      assert.equal(d.shows(), sentence, `tick ${tick}: the desk shows ${d.shows()}`);
      d.advance(TICK_MS);
    }
    assert.ok(d.warns(sentence) > 1, "restated as the notes pushed it out");
    assert.ok(d.warns(sentence) <= 1 + Math.ceil(d.events.length / 40), `${d.warns(sentence)} warnings for ${d.events.length} events`);
  });

  it("A NOTICE THE DESK STILL SHOWS IS NOT REPEATED — a long trip with nothing else said is one warning", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    for (let i = 0; i < 1_000; i++) {
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null });
      d.advance(TICK_MS);
    }
    assert.equal(d.events.length, 1);
  });

  it("A WARN WRITTEN EVERY TICK IS ITSELF CURRENT: the breaker waits for it rather than alternate with it", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const sentence = renderWhy(breaker);
    await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    for (let i = 0; i < 100; i++) {
      d.advance(TICK_MS);
      d.write("warn", "Trencher: Autonomous discovery could not verify its pool or custody data. Retrying; no new token authorized.");
      await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    }
    assert.equal(d.warns(sentence), 1, "no event storm while somebody else is warning");
    // …and once the other line stops, the breaker comes back.
    for (let i = 0; i < 5; i++) {
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    }
    assert.equal(d.shows(), sentence);
  });

  it("the grace is measured from the notice that replaced it", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    const sentence = renderWhy(breaker);
    await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    d.advance(3 * 60 * 60_000);
    d.write("warn", "something newer");
    d.advance(RESTATE_AFTER_MS - 1_000);
    await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    assert.equal(d.shows(), "something newer", "not before it has had its time");
    d.advance(1_000);
    await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
    assert.equal(d.shows(), sentence);
  });

  it("A REASON THAT POSTS IS NEVER RESTATED — its view row would repeat, and the owner meets it as the post", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    for (let i = 0; i < 45; i++) d.write("ok", `note ${i}`);
    d.write("warn", "something else");
    for (let i = 0; i < 20; i++) {
      d.advance(TICK_MS);
      await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: underOne, modeEmptied: null });
    }
    assert.equal(d.events.filter((e) => e.message === renderWhy(underOne)).length, 1);
    assert.equal(d.rows.length, 1);
  });

  it("AN UNREADABLE DESK IS NO REASON TO WRITE, and never a throw into the tick", async () => {
    for (const shown of ["unreadable", "throws"] as const) {
      const d = desk({ shown });
      const ch = new IdleChannel(d.sinks);
      await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
      for (let i = 0; i < 45; i++) d.write("ok", `note ${i}`);
      for (let i = 0; i < 10; i++) {
        d.advance(TICK_MS);
        await ch.tell({ agentId: AGENT, strategyName: "trencher", idle: breaker, modeEmptied: null });
      }
      assert.equal(d.warns(renderWhy(breaker)), 1, shown);
    }
  });

  it("a breaker that clears and trips again is a new warning, as before", async () => {
    const d = desk();
    const ch = new IdleChannel(d.sinks);
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: null, modeEmptied: null });
    await ch.tell({ agentId: AGENT, strategyName: "steady-basket", idle: breaker, modeEmptied: null });
    assert.equal(d.warns(renderWhy(breaker)), 2);
  });
});
