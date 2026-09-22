/**
 * THE MIRROR NEVER CARRIES AN OPERATION UP TWICE.
 *
 * A child home has no volume, so a redeploy rebuilds its ledger empty. At the
 * next arm the in-flight reconciler finds every successful op of the last 26
 * hours missing from that empty ledger and writes each one again — kind
 * 'swap', no decision, no fill side, stamped at the restart. The mirror sees a
 * rebuilt ledger, rewinds to id 0 (correctly: that is how the lost trade tape
 * came back) and copies the lot. `trades` has no unique key on user_op_hash, so
 * `ON CONFLICT DO NOTHING` had nothing to bite on, and every recent op landed
 * in the shared ledger a second time beside its evidenced original — first in
 * every newest-first list, and counted twice by everything that counts.
 *
 * The child is not touched: its own row is what seeds its cap, and spend must
 * over-count rather than under-count. Only the shared copy is skipped, and the
 * shared ledger seeds no cap.
 *
 * Run against sqlite AND against the Postgres translation of the mirror's own
 * SQL, because production's destination is Postgres and the sqlite fixture
 * alone has already let one statement through that Postgres refused
 * (ledger-mirror-pg-ambiguity.test.ts).
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { translateQuery, wrapSqlite, type Db, type RunResult } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

const TRADES =
  "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT," +
  " sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT," +
  " reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_price_usd REAL," +
  " realized_pnl_usdg REAL, basis_source TEXT, gas_wei TEXT, sponsored_gas_wei TEXT, gas_usdg REAL," +
  " gas_units TEXT, fill_cash_usdg REAL, epoch INTEGER DEFAULT 1, created_at INTEGER);";
const EVENTS =
  "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, level TEXT," +
  " message TEXT, created_at INTEGER);";
const EQUITY =
  "CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, eth_wei TEXT, cash_usdg REAL," +
  " vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, epoch INTEGER DEFAULT 1, mode TEXT, at INTEGER);";
const FLOWS =
  "CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, direction TEXT," +
  " amount_usdg REAL, tx_hash TEXT, block_number INTEGER, log_index INTEGER, source TEXT," +
  " epoch INTEGER DEFAULT 1, chain_id INTEGER, at INTEGER);";
const FEES =
  "CREATE TABLE fee_accruals (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, profit_usdg REAL," +
  " fee_usdg REAL, hwm_before_usdg REAL, hwm_after_usdg REAL, epoch INTEGER DEFAULT 1, at INTEGER);";
const LOGS = [TRADES, EVENTS, EQUITY, FLOWS, FEES].join("\n");

interface Row {
  agent?: string;
  hash: string | null;
  kind?: string;
  status?: string;
  side?: string | null;
  decision?: string | null;
  at: number;
}

const ledger = (rows: Row[]) => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(LOGS);
  const ins = raw.prepare(
    `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, tx_hash, status, fill_side,
                         decision_id, basis_source, epoch, created_at)
     VALUES (?, ?, '0xvault', 5.0, ?, ?, ?, ?, ?, 'receipt', 1, ?)`,
  );
  for (const r of rows) {
    ins.run(r.agent ?? "0xAgent", r.kind ?? "curve-trade", r.hash, r.hash ? `tx${r.hash}` : null,
      r.status ?? "landed", r.side ?? null, r.decision ?? null, r.at);
  }
  return { raw, db: wrapSqlite(raw) };
};

/** The mirror's SQL, run the way PgDb sends it: translated, then bound as $1..$n. */
function pgTranslated(raw: DatabaseSync): Db {
  const bind = (params: unknown[]) => Object.fromEntries(params.map((p, i) => [`$${i + 1}`, p])) as never;
  const db: Db = {
    prepare(sql: string) {
      const text = translateQuery(sql);
      return {
        run: async (...p: unknown[]) => raw.prepare(text).run(bind(p)) as RunResult,
        get: async (...p: unknown[]) => raw.prepare(text).get(bind(p)),
        all: async (...p: unknown[]) => raw.prepare(text).all(bind(p)),
      };
    },
    exec: async (sql: string) => raw.exec(sql),
    tx: async (fn) => {
      raw.exec("BEGIN");
      try {
        const out = await fn(db);
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return db;
}

const tape = async (shared: Db) =>
  (await shared
    .prepare(`SELECT agent_id, user_op_hash, kind, status, fill_side, decision_id FROM trades ORDER BY id`)
    .all()) as { agent_id: string; user_op_hash: string | null; kind: string; status: string; fill_side: string | null; decision_id: string | null }[];

for (const [label, destination] of [
  ["sqlite", (raw: DatabaseSync) => wrapSqlite(raw)],
  ["the Postgres translation", pgTranslated],
] as const) {
  describe(`a redeploy's re-recorded ops — ${label}`, () => {
    const dest = () => {
      const raw = new DatabaseSync(":memory:");
      raw.exec(LOGS + MIRROR_STATE_DDL);
      return destination(raw);
    };

    it("keeps the evidenced original and does not copy the reconciler's row beside it", async () => {
      const shared = dest();
      const first = ledger([
        { hash: "0xOP1", side: "buy", decision: "d1", at: 1000 },
        { hash: null, status: "rejected", decision: "d2", at: 1100 },
      ]);
      await mirrorTenant({ tenant: "t1", child: first.db, shared, nowSec: 2000 });
      assert.equal((await tape(shared)).length, 2);

      // The redeploy. The reconciler re-records 0xOP1 lowercased, as it writes
      // every hash; a new op and a new refusal follow.
      const rebuilt = ledger([
        { hash: "0xop1", kind: "swap", at: 5000 },
        { hash: "0xOP2", side: "sell", decision: "d3", at: 5100 },
        { hash: null, status: "rejected", decision: "d4", at: 5200 },
      ]);
      const report = await mirrorTenant({ tenant: "t1", child: rebuilt.db, shared, nowSec: 6000 });
      assert.ok(report.restarted?.trades, "the rebuild is still noticed and the cursor still rewinds");
      assert.equal(report.failed?.trades, undefined);
      assert.equal(report.copied.trades, 2, "the new op and the new refusal");
      assert.equal(report.copied.trades_already_mirrored, 1, "and the skip is reported, not silent");

      const rows = await tape(shared);
      assert.equal(rows.length, 4);
      const op1 = rows.filter((r) => r.user_op_hash?.toLowerCase() === "0xop1");
      assert.equal(op1.length, 1, "ONE row for one operation");
      assert.equal(op1[0]!.fill_side, "buy", "and it is the evidenced one");
      assert.equal(op1[0]!.decision_id, "d1");
      assert.equal(rows.filter((r) => r.status === "rejected").length, 2, "refusals carry no hash and are never collapsed");

      // The watermark still moved past the skipped row: the next pass is idle.
      const again = await mirrorTenant({ tenant: "t1", child: rebuilt.db, shared, nowSec: 6100 });
      assert.equal(again.copied.trades, 0);
      assert.equal((await tape(shared)).length, 4);

      // And the CHILD is untouched — its own row is what its cap is seeded from.
      assert.equal((rebuilt.raw.prepare("SELECT COUNT(*) AS n FROM trades").get() as { n: number }).n, 3);
      first.raw.close();
      rebuilt.raw.close();
    });

    it("matches across a difference in how the account was spelt", async () => {
      const shared = dest();
      const first = ledger([{ agent: "0xAgent", hash: "0xOP1", side: "buy", decision: "d1", at: 1000 }]);
      await mirrorTenant({ tenant: "t1", child: first.db, shared, nowSec: 2000 });
      const rebuilt = ledger([{ agent: "0xagent", hash: "0xop1", kind: "swap", at: 5000 }]);
      await mirrorTenant({ tenant: "t1", child: rebuilt.db, shared, nowSec: 6000 });
      assert.equal((await tape(shared)).length, 1);
      first.raw.close();
      rebuilt.raw.close();
    });

    it("a child that holds one op twice puts it here once", async () => {
      const shared = dest();
      const c = ledger([
        { hash: "0xOP1", side: "buy", decision: "d1", at: 1000 },
        { hash: "0xop1", kind: "swap", at: 1001 },
      ]);
      const report = await mirrorTenant({ tenant: "t1", child: c.db, shared, nowSec: 2000 });
      const rows = await tape(shared);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.fill_side, "buy", "the first, evidenced row is the one kept");
      assert.equal(report.copied.trades_already_mirrored, 1);
      c.raw.close();
    });

    it("never collapses one agent's op into another agent's row with the same hash", async () => {
      const shared = dest();
      const a = ledger([{ agent: "0xA", hash: "0xOP1", side: "buy", at: 1000 }]);
      const b = ledger([{ agent: "0xB", hash: "0xOP1", side: "buy", at: 1000 }]);
      await mirrorTenant({ tenant: "a", child: a.db, shared, nowSec: 2000 });
      await mirrorTenant({ tenant: "b", child: b.db, shared, nowSec: 2000 });
      assert.equal((await tape(shared)).length, 2);
      a.raw.close();
      b.raw.close();
    });

    it("a copy skipped beside a 'submitted' original still settles it", async () => {
      // The pass that makes skipping safe: the outcome travels by UPDATE on the
      // hash, not by inserting a second row, so the shared row still learns
      // that the op landed.
      const shared = dest();
      const first = ledger([{ hash: "0xOP1", status: "submitted", decision: "d1", at: 1000 }]);
      await mirrorTenant({ tenant: "t1", child: first.db, shared, nowSec: 2000 });
      const rebuilt = ledger([{ hash: "0xOP1", kind: "swap", at: 5000 }]);
      await mirrorTenant({ tenant: "t1", child: rebuilt.db, shared, nowSec: 6000 });
      const rows = await tape(shared);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "landed");
      first.raw.close();
      rebuilt.raw.close();
    });

    it("a rebuild bigger than one batch is deduped on the passes AFTER the rewind too", async () => {
      // Only the first pass after a rebuild is a rewind. A child that re-records
      // more ops than one batch holds finishes the catch-up on ordinary passes,
      // where the lower() scan does not run, and those are where the exact
      // (agent_id, user_op_hash) probe has to catch the copy by itself.
      const shared = dest();
      const first = ledger([
        { hash: "0xop1", side: "buy", decision: "d1", at: 1000 },
        { hash: "0xop2", side: "buy", decision: "d2", at: 1001 },
      ]);
      await mirrorTenant({ tenant: "t1", child: first.db, shared, nowSec: 2000 });
      const rebuilt = ledger([
        { hash: "0xop1", kind: "swap", at: 5000 },
        { hash: "0xop2", kind: "swap", at: 5001 },
        { hash: "0xop3", side: "sell", decision: "d3", at: 5002 },
      ]);
      const a = await mirrorTenant({ tenant: "t1", child: rebuilt.db, shared, batch: 1, nowSec: 6000 });
      assert.ok(a.restarted?.trades, "the first pass rewinds");
      assert.equal(a.copied.trades_already_mirrored, 1);
      const b = await mirrorTenant({ tenant: "t1", child: rebuilt.db, shared, batch: 1, nowSec: 6015 });
      assert.equal(b.restarted, undefined, "the second pass is an ordinary one");
      assert.equal(b.copied.trades, 0);
      assert.equal(b.copied.trades_already_mirrored, 1, "and still skips the copy");
      const c = await mirrorTenant({ tenant: "t1", child: rebuilt.db, shared, batch: 1, nowSec: 6030 });
      assert.equal(c.copied.trades, 1, "the genuinely new op arrives");
      const rows = await tape(shared);
      assert.deepEqual(
        rows.map((r) => [r.user_op_hash, r.fill_side]),
        [["0xop1", "buy"], ["0xop2", "buy"], ["0xop3", "sell"]],
        "one row per op, and the evidenced ones",
      );
      first.raw.close();
      rebuilt.raw.close();
    });

    it("an ordinary pass skips an op the account already holds, and inserts a new one", async () => {
      const shared = dest();
      const c = ledger([{ hash: "0xop1", side: "buy", decision: "d1", at: 1000 }]);
      await mirrorTenant({ tenant: "t1", child: c.db, shared, nowSec: 2000 });
      c.raw
        .prepare(
          `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, epoch, created_at)
           VALUES ('0xAgent', 'swap', '0xvault', 5.0, ?, 'landed', 1, ?)`,
        )
        .run("0xop1", 3000);
      c.raw
        .prepare(
          `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, fill_side, epoch, created_at)
           VALUES ('0xAgent', 'curve-trade', '0xvault', 5.0, ?, 'landed', 'sell', 1, ?)`,
        )
        .run("0xop2", 3001);
      const r = await mirrorTenant({ tenant: "t1", child: c.db, shared, nowSec: 4000 });
      assert.equal(r.restarted, undefined);
      assert.equal(r.copied.trades, 1);
      assert.equal(r.copied.trades_already_mirrored, 1);
      assert.deepEqual((await tape(shared)).map((x) => x.user_op_hash), ["0xop1", "0xop2"]);
      c.raw.close();
    });
  });
}

/**
 * AN ORDINARY PASS READS THE SHARED TAPE ONLY THROUGH ITS INDEX.
 *
 * The held-hash read was `lower(agent_id) = ?`, which trades_agent_userop (on
 * the raw column) cannot serve, so it scanned the whole fleet's trades inside
 * the mirror transaction on every batch that carried a hashed trade: every new
 * live fill, on a fifteen-second clock. The plan is asked of SQLite for every
 * statement the pass actually sent to the destination, with the parameters it
 * actually bound, so this is the query that ran and not the one somebody meant.
 */
describe("the duplicate check costs an index seek on an ordinary pass", () => {
  type Sent = { sql: string; params: unknown[] };
  /** The destination, recording every statement and its parameters as run. */
  const recording = (db: Db, sent: Sent[]): Db => {
    const wrap = (inner: Db): Db => ({
      prepare(sql: string) {
        const st = inner.prepare(sql);
        return {
          run: async (...p: unknown[]) => (sent.push({ sql, params: p }), st.run(...p)),
          get: async (...p: unknown[]) => (sent.push({ sql, params: p }), st.get(...p)),
          all: async (...p: unknown[]) => (sent.push({ sql, params: p }), st.all(...p)),
        };
      },
      exec: (sql: string) => inner.exec(sql),
      tx: (fn) => inner.tx((d) => fn(wrap(d))),
    });
    return wrap(db);
  };
  const scansOfTrades = (raw: DatabaseSync, sent: Sent[]) =>
    sent
      .filter((s) => /^\s*(SELECT|UPDATE)\b/i.test(s.sql) && /\btrades\b/.test(s.sql))
      .flatMap((s) =>
        (raw.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...(s.params as never[])) as { detail: string }[])
          .map((p) => p.detail)
          .filter((d) => /^SCAN trades\b/.test(d))
          .map((d) => `${d} <- ${s.sql.replace(/\s+/g, " ").trim()}`),
      );

  it("a new live fill beside a fleet's tape is checked by (agent_id, user_op_hash), not by a scan", async () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec(LOGS + MIRROR_STATE_DDL);
    // The index the shared database carries (store.ts), and nothing else.
    raw.exec("CREATE INDEX trades_agent_userop ON trades (agent_id, user_op_hash)");
    const shared = wrapSqlite(raw);
    const c = ledger([{ hash: "0xop1", side: "buy", decision: "d1", at: 1000 }]);
    await mirrorTenant({ tenant: "t1", child: c.db, shared, nowSec: 2000 });
    c.raw
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, fill_side, epoch, created_at)
         VALUES ('0xAgent', 'curve-trade', '0xvault', 5.0, '0xop2', 'landed', 'buy', 1, 3000)`,
      )
      .run();
    const sent: Sent[] = [];
    const r = await mirrorTenant({ tenant: "t1", child: c.db, shared: recording(shared, sent), nowSec: 4000 });
    assert.equal(r.restarted, undefined, "an ordinary pass");
    assert.equal(r.copied.trades, 1);
    assert.ok(sent.some((s) => /FROM trades/.test(s.sql)), "sanity: the pass did ask the destination about the op");
    assert.deepEqual(scansOfTrades(raw, sent), []);
    c.raw.close();
    raw.close();
  });
});
