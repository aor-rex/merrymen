/**
 * THE SHELL'S READS, EACH ON ITS OWN CLOCK — executed with a fake clock and a
 * fake network, because the property is who waits for whom.
 *
 * Before this, one 60s pass read quotes, then six reads in one Promise.all,
 * then the account, and applied nothing until the slowest was back: the
 * launchpad sweep, at 10-12s cold. A trade that landed could wait a minute to
 * be asked for and twelve seconds more to be drawn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { liveOf, seedSources, type LiveReadKey, type LiveSources, type RawRead } from "./live";
import { liveClocks } from "./live-clocks";
import { bannerOf, startClocks, type ClockView } from "./refresh-loop";

function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    timers: {
      setTimeout(fn: () => void, ms: number) {
        const id = ++seq;
        pending.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout(h: unknown) {
        pending.delete(h as number);
      },
      now: () => now,
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await settle();
      }
      now = until;
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
};

const ok = (body: unknown): RawRead => ({ text: JSON.stringify(body), answered: true });
const BODIES: Record<LiveReadKey, unknown> = {
  theses: { source: "sqlite", theses: [{ name: "Shogun", slug: "shogun", handle: null, action: "buy", symbol: "TSLA", sizeUsdg: 5, reason: "r", paper: false, head: "bought TSLA", outcome: "landed", at: 1 }] },
  market: { source: "chain", tokens: [] },
  board: { source: "sqlite", agents: [] },
  discoveries: { source: "index", rows: [], fresh: [] },
  feed: { source: "sqlite", agent: { name: "Shogun", slug: "shogun" }, equity: [{ equity_usdg: 20 }] },
};

/** A shell with a network whose answers the test decides, read by key. */
function shell(opts: {
  answer?: (key: LiveReadKey) => Promise<RawRead> | RawRead;
  account?: () => Promise<void>;
  hidden?: () => boolean;
} = {}) {
  const clock = fakeClock();
  let sources: LiveSources = seedSources();
  let views: ClockView[] = [];
  const asked: string[] = [];
  const specs = liveClocks({
    fetchRead: async (key) => {
      asked.push(key);
      return opts.answer ? opts.answer(key) : ok(BODIES[key]);
    },
    loadQuotes: async () => {
      asked.push("quotes");
      return new Map();
    },
    loadChanges: async () => new Map(),
    update: (change) => {
      sources = change(sources);
    },
    readAccount: opts.account ?? (async () => {}),
    hidden: opts.hidden ?? (() => false),
  });
  const clocks = startClocks(specs, (v) => (views = v), clock.timers);
  return {
    clock,
    clocks,
    live: () => liveOf(sources),
    banner: () => bannerOf(views),
    count: (key: string) => asked.filter((k) => k === key).length,
  };
}

describe("the shell's reads", () => {
  it("THE FEED IS DRAWN WHILE THE LAUNCHPAD SWEEP IS STILL OUT", async () => {
    const s = shell({ answer: (key) => (key === "discoveries" ? new Promise<RawRead>(() => {}) : ok(BODIES[key])) });
    await settle();
    assert.equal(s.live().reads.theses, "ok");
    assert.equal(s.live().theses.length, 1);
    assert.equal(s.live().reads.discoveries, "unread", "and the sweep says it is still out, not that it failed");
    s.clocks.stop();
  });

  it("each read keeps its own cadence: feed 10s, market 30s, board 60s, sweep 120s", async () => {
    const s = shell();
    await settle();
    await s.clock.advance(120_000);
    assert.equal(s.count("theses"), 13);
    assert.equal(s.count("market"), 5);
    assert.equal(s.count("board"), 3);
    assert.equal(s.count("discoveries"), 2);
    assert.equal(s.count("feed"), 3);
    s.clocks.stop();
  });

  it("the quotes are read once per market read, and by nothing else", async () => {
    const s = shell();
    await settle();
    await s.clock.advance(60_000);
    assert.equal(s.count("quotes"), s.count("market"));
    s.clocks.stop();
  });

  it("a hidden tab keeps only the feed, once a minute — so the title can count what arrived", async () => {
    let hidden = false;
    const s = shell({ hidden: () => hidden });
    await settle();
    hidden = true;
    const before = { theses: s.count("theses"), market: s.count("market") };
    await s.clock.advance(180_000);
    assert.equal(s.count("market"), before.market, "nothing else is asked for from a hidden tab");
    assert.ok(s.count("theses") - before.theses <= 4, "and the feed slows to a minute");
    assert.ok(s.count("theses") - before.theses >= 2, "but keeps reading");
    hidden = false;
    s.clocks.wake();
    await settle();
    assert.equal(s.count("market"), before.market + 1, "coming back reads what went stale at once");
    s.clocks.stop();
  });
});

describe("the outage line over them", () => {
  it("a failed feed read is on the line, and the feed stays on screen dated", async () => {
    let fail = false;
    const s = shell({ answer: (key) => (key === "theses" && fail ? { text: null, answered: true } : ok(BODIES[key])) });
    await settle();
    fail = true;
    await s.clock.advance(10_000);
    const b = s.banner()!;
    assert.deepEqual(b.failed, { account: false, market: true });
    assert.equal(b.unreachable, false, "a route answered");
    assert.equal(b.lastOkAt, 1_000_000, "dated from the read still on screen");
    assert.equal(s.live().theses.length, 1);
    s.clocks.stop();
  });

  it("the owner's book failing is not an outage — a signed-out visitor reads it that way by design", async () => {
    const s = shell({ answer: (key) => (key === "feed" ? ok({ source: "none" }) : ok(BODIES[key])) });
    await settle();
    assert.equal(s.banner(), null);
    assert.equal(s.live().reads.mine, "unreadable", "it says so on its own surface");
    s.clocks.stop();
  });

  it("'Can't reach merrymen' when nothing answered anywhere, and not when the book alone did", async () => {
    const offline = Object.assign(new Error("offline"), { status: 0 });
    const s = shell({
      answer: (key) => (key === "feed" ? ok(BODIES.feed) : { text: null, answered: false }),
      account: async () => {
        throw offline;
      },
    });
    await settle();
    assert.equal(s.banner()!.unreachable, true);
    assert.deepEqual(s.banner()!.failed, { account: true, market: true });
    s.clocks.stop();
  });
});
