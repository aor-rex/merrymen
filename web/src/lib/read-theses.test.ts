/**
 * A TRADE IS NOT PUSHED OFF THE FEED BY A CLOCK.
 *
 * Measured on production: 37 of the 40 posts the reader returned were holds,
 * covering the last ten minutes. The producers are timers — a Trencher reviews
 * a coin every 30 seconds and every quiet agent files a market review every
 * five minutes — and the reader had ONE budget, ordered by the newest row in
 * each group, so a re-proposed hold jumped back to the top on every tick and a
 * buy that landed three hours ago fell off the end of the scan.
 *
 * These run the real query against a real SQLite ledger, because the defect was
 * the query: a LIMIT shared between two kinds of row that arrive at rates three
 * orders of magnitude apart.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { translateQuery, wrapSqlite } from "../../../worker/src/db";
import { readTheses } from "./read-theses";

const SLUG = "ems76d3cncwbt3dz";
const OTHER = "hr5k2m9q4w7x3z8n";
const NOW = Math.floor(Date.now() / 1000);

type Row = {
  id: string;
  agent?: string;
  action: string | null;
  symbol: string | null;
  size?: number | null;
  source?: string;
  reason: string;
  at: number;
  display?: string | null;
};

async function ledger(rows: Row[], trades: { decision: string; status: string }[] = []) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, mode TEXT);
    CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT, size_usdg REAL, source TEXT, reason TEXT, dropped_rule TEXT, hold_kind TEXT, at INTEGER);
    CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT);
    CREATE TABLE posts(decision_id TEXT, body TEXT);
    INSERT INTO agents VALUES ('0xabc','Shogun',NULL,'live');
    INSERT INTO agents VALUES ('0xdef','SirSendIt',NULL,'live');`);
  const insert = db.prepare("INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,NULL,NULL,?)");
  for (const r of rows) {
    await insert.run(r.id, r.agent ?? "0xabc", r.action, r.symbol, r.display ?? null, r.size ?? null, r.source ?? "brain", r.reason, r.at);
  }
  for (const t of trades) {
    await db.prepare("INSERT INTO trades (decision_id, status, reject_rule) VALUES (?,?,NULL)").run(t.decision, t.status);
  }
  return { raw, db };
}

const identities = async () => [
  { tenant: "0x1" as const, slug: SLUG, accounts: ["0xabc" as const], createdAt: 1, updatedAt: 1 },
  { tenant: "0x2" as const, slug: OTHER, accounts: ["0xdef" as const], createdAt: 1, updatedAt: 1 },
];
const settings = async () => ({ strategy: "trencher" as const });

/** A Trencher's review cadence: a fresh hold every 30 seconds, rotating coins. */
function holds(n: number, agent = "0xabc", symbols = 10): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `hold-${agent}-${i}`,
    agent,
    action: "hold",
    symbol: `T${(i % symbols).toString(16).toUpperCase().padStart(11, "0")}`,
    // Model prose: every review is worded differently, so none of them group.
    reason: `Flow is two-sided but thin on review ${i}; nothing worth taking yet.`,
    at: NOW - i * 30,
  }));
}

describe("actions and views have separate budgets", () => {
  it("A LANDED BUY THREE HOURS OLD SURVIVES A HUNDRED FRESH HOLDS", async () => {
    const buy: Row = {
      id: "buy-1",
      action: "buy",
      symbol: "TSLA",
      size: 5,
      source: "strategy:steady-basket",
      reason: "Adding to the basket while it trades under its average.",
      at: NOW - 3 * 3600,
    };
    const { raw, db } = await ledger([...holds(100), buy], [{ decision: "buy-1", status: "landed" }]);
    try {
      const read = await readTheses({}, (fn) => fn(db), identities, settings);
      assert.equal(read.source, "sqlite");
      const bought = read.theses.filter((t) => t.action === "buy");
      assert.equal(bought.length, 1, "the trade must be on the feed");
      assert.equal(bought[0]!.outcome, "landed");
      assert.equal(bought[0]!.symbol, "TSLA");
    } finally {
      raw.close();
    }
  });

  it("and it survives on the agent's own profile too", async () => {
    // The profile used the same one-budget reader, so a Trencher's history was
    // about twenty minutes of holds and none of its trades.
    const buy: Row = { id: "buy-2", action: "sell", symbol: "TABC", size: 4, reason: "Took the exit; depth fell away.", at: NOW - 6 * 3600 };
    const { raw, db } = await ledger([...holds(300), buy], [{ decision: "buy-2", status: "landed" }]);
    try {
      const read = await readTheses({ agentSlug: SLUG, limit: 40 }, (fn) => fn(db), identities, settings);
      assert.ok(read.theses.some((t) => t.action === "sell" && t.outcome === "landed"));
    } finally {
      raw.close();
    }
  });

  it("A REFUSED TRADE STILL COUNTS AS AN ACTION — the owner is told what the wall did", async () => {
    const buy: Row = { id: "buy-3", action: "buy", symbol: "NVDA", size: 40, source: "strategy:steady-basket", reason: "Adding while it trades under its average.", at: NOW - 7200 };
    const { raw, db } = await ledger([...holds(100), buy], [{ decision: "buy-3", status: "rejected" }]);
    try {
      const read = await readTheses({}, (fn) => fn(db), identities, settings);
      const refused = read.theses.find((t) => t.symbol === "NVDA");
      assert.ok(refused, "a refusal is not hidden to make room");
      assert.equal(refused.outcome, "refused");
    } finally {
      raw.close();
    }
  });
});

describe("a view is the latest word per agent and name", () => {
  it("one row per agent and coin, not one per tick", async () => {
    const { raw, db } = await ledger(holds(100));
    try {
      const read = await readTheses({}, (fn) => fn(db), identities, settings);
      const views = read.theses.filter((t) => t.action === "hold");
      assert.equal(views.length, 10, "ten coins reviewed, ten posts");
      assert.equal(new Set(views.map((v) => v.symbol)).size, 10);
      // And it is the NEWEST review of each coin, not an arbitrary one.
      const first = views.find((v) => v.symbol === "T00000000000")!;
      assert.match(first.reason!, /review 0;/);
    } finally {
      raw.close();
    }
  });

  it("another agent's quieter view is not crowded out by a busy one", async () => {
    const quiet: Row = {
      id: "quiet-1",
      agent: "0xdef",
      action: "hold",
      symbol: "AAPL",
      source: "strategy:even-keel",
      reason: "Depth remains thin; I am holding until liquidity recovers.",
      at: NOW - 5 * 3600,
    };
    const { raw, db } = await ledger([...holds(400), quiet]);
    try {
      const read = await readTheses({}, (fn) => fn(db), identities, settings);
      assert.ok(read.theses.some((t) => t.slug === OTHER && t.symbol === "AAPL"));
    } finally {
      raw.close();
    }
  });

  it("an unchanged view keeps the time it was FIRST said, and how often", async () => {
    // The same sentence re-proposed every five minutes for two hours is one
    // view that has stood for two hours, not a new post every five minutes.
    const same = Array.from({ length: 24 }, (_, i): Row => ({
      id: `same-${i}`,
      action: "hold",
      symbol: "TSLA",
      source: "strategy:even-keel",
      reason: "Depth remains thin; I am holding until liquidity recovers.",
      at: NOW - i * 300,
    }));
    const { raw, db } = await ledger(same);
    try {
      const read = await readTheses({}, (fn) => fn(db), identities, settings);
      assert.equal(read.theses.length, 1);
      const [view] = read.theses;
      assert.equal(view!.said, 24);
      assert.equal(view!.firstAt, NOW - 23 * 300);
      assert.equal(view!.at, NOW);
    } finally {
      raw.close();
    }
  });
});

describe("what the gate refuses stays refused", () => {
  it("the split re-ranks rows and publishes nothing new", async () => {
    // An operational notice was never a post. Two queries must not make it one.
    const notice: Row = { id: "n-1", action: "hold", symbol: "TSLA", source: "brain", reason: "error: provider unavailable", at: NOW };
    const chat: Row = { id: "c-1", action: "buy", symbol: "TSLA", size: 5, source: "chat", reason: "owner asked in chat", at: NOW };
    const { raw, db } = await ledger([notice, chat]);
    try {
      const read = await readTheses({}, (fn) => fn(db), identities, settings);
      assert.deepEqual(read.theses, []);
    } finally {
      raw.close();
    }
  });

  it("an unreadable ledger is reported as one, not as a quiet fleet", async () => {
    const read = await readTheses({}, (fn) => fn(null), identities, settings);
    assert.equal(read.source, "none");
  });
});

describe("the same queries run on the hosted backend", () => {
  it("every placeholder is renumbered for Postgres, and each has an argument", async () => {
    // Hosted reads go through db.ts's translator, which numbers `?` by walking
    // the text and SKIPS anything it believes is inside a quoted string — so a
    // stray apostrophe in an SQL comment silently shifts every placeholder
    // after it. SQLite never notices; Postgres gets the wrong arguments.
    const issued: { sql: string; args: unknown[] }[] = [];
    const fake = {
      prepare: (sql: string) => ({
        all: async (...args: unknown[]) => {
          issued.push({ sql, args });
          return [];
        },
      }),
    };
    for (const opts of [{}, { agentSlug: SLUG }, { symbol: "TSLA" }]) {
      issued.length = 0;
      await readTheses(opts, (fn) => fn(fake as never), identities, settings);
      assert.equal(issued.length, 2, "one query per lane");
      for (const q of issued) {
        const pg = translateQuery(q.sql);
        assert.ok(!pg.includes("?"), "a placeholder was left unrenumbered");
        const numbers = [...pg.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
        assert.deepEqual(numbers, q.args.map((_, i) => i + 1), "placeholders and arguments must line up one to one");
      }
    }
  });
});
