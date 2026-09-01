import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

/**
 * THE HOLE THIS FILLS, and why exactly-once is the whole point.
 *
 * `childEnv` strips DATABASE_URL from every worker child, so a child writes
 * sqlite inside its own container while the web service reads a Postgres nothing
 * ever wrote to. The result was total and invisible: no tape, no positions, no
 * equity, no events and no reasoning on the hosted dashboard, for anyone,
 * whatever the agent was doing — while balances still showed, because the web
 * reads those from the chain. It looked like a working dashboard with a quiet
 * agent.
 *
 * Source ids are unique only WITHIN one child's database — two tenants both have
 * event id 1 — so the id cannot be the destination key. Rows and their watermark
 * therefore move in ONE transaction. Insert-then-save duplicates the trade tape
 * every time a deploy lands mid-copy, which on a ledger is worse than lagging.
 */

const SRC = [
  "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, level TEXT, message TEXT, created_at INTEGER);",
  "CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, target TEXT, sell_token TEXT, buy_token TEXT, amount_usdg REAL, user_op_hash TEXT, tx_hash TEXT, status TEXT, reject_rule TEXT, decision_id TEXT, fill_side TEXT, fill_qty_raw TEXT, fill_price_usd REAL, realized_pnl_usdg REAL, basis_source TEXT, gas_wei TEXT, sponsored_gas_wei TEXT, gas_usdg REAL, fill_cash_usdg REAL, epoch INTEGER DEFAULT 1, created_at INTEGER);",
  "CREATE TABLE equity (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, eth_wei TEXT, cash_usdg REAL, vault_usdg REAL, positions_usdg REAL, equity_usdg REAL, epoch INTEGER DEFAULT 1, at INTEGER);",
  "CREATE TABLE flows (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, direction TEXT, amount_usdg REAL, tx_hash TEXT, block_number INTEGER, log_index INTEGER, source TEXT, epoch INTEGER DEFAULT 1, at INTEGER);",
  "CREATE TABLE fee_accruals (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, profit_usdg REAL, fee_usdg REAL, hwm_before_usdg REAL, hwm_after_usdg REAL, epoch INTEGER DEFAULT 1, at INTEGER);",
  "CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT, model TEXT, symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT, signals_json TEXT, at INTEGER);",
  "CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, owner_address TEXT, session_key_address TEXT, chain_id INTEGER, caps TEXT, granted_at INTEGER, expires_at INTEGER, status TEXT, created_at INTEGER, mode TEXT, beat_at INTEGER, epoch INTEGER DEFAULT 1, hwm_usdg REAL DEFAULT 0, accrued_fee_usdg REAL DEFAULT 0);",
  "CREATE TABLE positions (agent_id TEXT, symbol TEXT, token TEXT, raw_balance TEXT, ui_multiplier TEXT, price_usd REAL, price_stale INTEGER, price_source TEXT DEFAULT 'chainlink', value_usdg REAL, updated_at INTEGER, PRIMARY KEY (agent_id, symbol));",
].join("\n");

/** The destination, with the same shape a Postgres ledger has. */
const DEST = SRC + MIRROR_STATE_DDL;

const mem = (ddl: string) => {
  const db = new DatabaseSync(":memory:");
  db.exec(ddl);
  return wrapSqlite(db);
};

const seedChild = () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SRC);
  // Columns named rather than positional: this row grew three fields and a
  // positional INSERT would have to be rewritten for each one.
  //
  // EPOCH 2 ON PURPOSE. The agent is on its second run, so a mirror that drops
  // the column leaves the shared row at its DEFAULT 1 — which is exactly the
  // failure this fixture has to be able to see.
  raw.exec(
    `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps,
                         granted_at, expires_at, status, created_at, mode, beat_at,
                         epoch, hwm_usdg, accrued_fee_usdg)
     VALUES ('0xagent','Robin','0xowner','0xsk',4663,'{}',1,2,'armed',3,'live',99,2,150.5,7.25)`,
  );
  for (let i = 1; i <= 5; i++) {
    raw.exec(
      `INSERT INTO events (agent_id, level, message, created_at) VALUES ('0xagent','ok','e${i}',${100 + i})`,
    );
    raw.exec(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, gas_usdg, epoch, created_at)
       VALUES ('0xagent','swap','0xt',${i},'landed',0.25,2,${100 + i})`,
    );
  }
  raw.exec("INSERT INTO positions VALUES ('0xagent','PEPE','0xp','1','1',2.0,0,'curve',10.0,9)");
  raw.exec(
    "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch, at)" +
      " VALUES ('0xagent','1000',90.0,0.0,10.0,100.0,2,120)",
  );
  // A deposit and a withdrawal. Without these the shared ledger has no flow
  // term at all, contributions read as UNKNOWN, and P&L is null forever.
  raw.exec(
    "INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, log_index, source, epoch, at)" +
      " VALUES ('0xagent','in',80.0,'0xdeadbeef',555,4,'chain-log',2,110)",
  );
  raw.exec(
    "INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, source, epoch, at)" +
      " VALUES ('0xagent','out',5.0,'0xfeedface',556,'transfer-intent',2,111)",
  );
  raw.exec(
    "INSERT INTO fee_accruals (agent_id, profit_usdg, fee_usdg, hwm_before_usdg, hwm_after_usdg, epoch, at)" +
      " VALUES ('0xagent',20.0,2.0,130.5,150.5,2,115)",
  );
  raw.exec(
    "INSERT INTO decisions VALUES ('d1','0xagent','strategist',null,null,null,'PEPE','buy',5,'looked cheap',null,'{}',9)",
  );
  return wrapSqlite(raw);
};

const count = async (db: ReturnType<typeof mem>, table: string): Promise<number> => {
  const r = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()) as { n: number };
  return Number(r.n);
};

describe("the ledger mirror", () => {
  it("carries price_source across — a curve mark must not arrive as an oracle", async () => {
    // The positions SELECT omitted price_source, and the destination schema
    // defaults it to 'chainlink'. So the weakest mark this system produces — a
    // bonding-curve price — arrived in the shared ledger wearing an oracle's
    // name and rendered on the dashboard as oracle-grade. The whole point of the
    // column is that the three sources are NOT equally good evidence.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const row = (await shared.prepare("SELECT price_source FROM positions").get()) as {
      price_source: string;
    };
    assert.equal(row.price_source, "curve");
  });

  it("copies a child's ledger up", async () => {
    const shared = mem(DEST);
    const r = await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    assert.equal(r.copied.events, 5);
    assert.equal(r.copied.trades, 5);
    assert.equal(r.copied.decisions, 1);
    assert.equal(r.copied.positions, 1);
    assert.equal(await count(shared, "events"), 5);
  });

  it("IS EXACTLY-ONCE — running twice does not duplicate the tape", async () => {
    // The property the whole design turns on. A trade shown twice is worse than
    // a trade shown late, and the orchestrator runs this every 15 seconds.
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    const second = await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(second.copied.events, undefined, "nothing new to copy");
    assert.equal(await count(shared, "events"), 5, "events must not double");
    assert.equal(await count(shared, "trades"), 5, "trades must not double");
  });

  it("picks up only what is NEW on the next pass", async () => {
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child
      .prepare("INSERT INTO events (agent_id, level, message, created_at) VALUES (?,?,?,?)")
      .run("0xagent", "warn", "e6", 200);
    const r = await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(r.copied.events, 1);
    assert.equal(await count(shared, "events"), 6);
  });

  it("keeps two tenants' ledgers apart despite colliding source ids", async () => {
    // Both children have event id 1. If the source id were the destination key
    // the second tenant's tape would collide with the first's — which is why
    // the watermark is keyed by (tenant, table) and the id is not carried over.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xaaa", child: seedChild(), shared });
    await mirrorTenant({ tenant: "0xbbb", child: seedChild(), shared });
    assert.equal(await count(shared, "events"), 10, "both tenants' events must survive");
  });

  it("REPLACES positions rather than merging — a closed position is gone", async () => {
    // An upsert alone would leave a sold coin on the dashboard forever, because
    // the source DELETES the row rather than zeroing it.
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child.prepare("DELETE FROM positions WHERE symbol = ?").run("PEPE");
    await mirrorTenant({ tenant: "0xten", child, shared });
    assert.equal(await count(shared, "positions"), 0, "a closed position must disappear too");
  });

  it("carries a renamed agent forward", async () => {
    const child = seedChild();
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child, shared });
    await child.prepare("UPDATE agents SET name = ? WHERE smart_account = ?").run("Little John", "0xagent");
    await mirrorTenant({ tenant: "0xten", child, shared });
    const row = (await shared
      .prepare("SELECT name FROM agents WHERE smart_account = ?")
      .get("0xagent")) as { name: string };
    assert.equal(row.name, "Little John");
  });

  it("survives a table that is missing at the source", async () => {
    // A child mid-migration, or an older worker. One table's worth of lag is
    // not a reason to abandon the rest of that tenant's ledger.
    const raw = new DatabaseSync(":memory:");
    raw.exec(
      "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, level TEXT, message TEXT, created_at INTEGER);",
    );
    raw.exec("INSERT INTO events (agent_id, level, message, created_at) VALUES ('0xa','ok','only',1)");
    const r = await mirrorTenant({ tenant: "0xten", child: wrapSqlite(raw), shared: mem(DEST) });
    assert.equal(r.copied.events, 1);
    assert.equal(r.copied.trades, undefined);
  });

  it("CARRIES THE FLOW TERM — without it a deposit reads as a gain", async () => {
    // `flows` was never in LOG_TABLES, and the shared database HAS the table
    // because applyLedgerSchema creates it. So the contributions query succeeded,
    // returned zero rows, and equity.ts — which refuses to publish a number it
    // cannot back — returned null. Every hosted agent's P&L was a dash, forever,
    // and no error was raised anywhere to say so.
    const shared = mem(DEST);
    const r = await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    assert.equal(r.copied.flows, 2, "both the deposit and the withdrawal must travel");

    const net = (await shared
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
           FROM flows WHERE agent_id = ?`,
      )
      .get("0xagent")) as { n: number; net: number };
    // n > 0 is the whole point: it is what turns contributions from UNKNOWN into
    // a figure, which is what turns P&L from null into a number.
    assert.equal(Number(net.n), 2);
    assert.equal(Number(net.net), 75);

    // The tx hash is what makes a flow evidence rather than an inference.
    const dep = (await shared
      .prepare("SELECT tx_hash, block_number, log_index, source FROM flows WHERE direction = 'in'")
      .get()) as { tx_hash: string; block_number: number; log_index: number; source: string };
    assert.equal(dep.tx_hash, "0xdeadbeef");
    assert.equal(Number(dep.block_number), 555);
    // Without the index a re-read of the final block cannot tell this transfer
    // from another in the same transaction.
    assert.equal(Number(dep.log_index), 4);
    assert.equal(dep.source, "chain-log");
  });

  it("carries the agent's epoch, high-water mark and accrued fee", async () => {
    // All three were dropped. `epoch` is the dangerous one: both web routes
    // filter every query on it, and while nothing carried it the shared row sat
    // at DEFAULT 1 and so did every mirrored trade — so the filter matched
    // everything and two separate runs were spliced into one book. The other two
    // are read with COALESCE(..., 0), so an absent high-water mark and accrued
    // fee did not render as unknown; they rendered as a confident zero.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const a = (await shared
      .prepare("SELECT epoch, hwm_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?")
      .get("0xagent")) as { epoch: number; hwm_usdg: number; accrued_fee_usdg: number };
    assert.equal(Number(a.epoch), 2, "the agent is on its SECOND run — 1 here is the default, not the truth");
    assert.equal(Number(a.hwm_usdg), 150.5);
    assert.equal(Number(a.accrued_fee_usdg), 7.25);

    // And the rows must agree with it, or the epoch filter finds nothing.
    const t = (await shared
      .prepare("SELECT COUNT(*) AS n FROM trades WHERE agent_id = ? AND epoch = ?")
      .get("0xagent", 2)) as { n: number };
    assert.equal(Number(t.n), 5);
    const e = (await shared
      .prepare("SELECT COUNT(*) AS n FROM equity WHERE agent_id = ? AND epoch = ?")
      .get("0xagent", 2)) as { n: number };
    assert.equal(Number(e.n), 1);
  });

  it("carries gas priced in USDG, so 'net of gas' is a claim we can back", async () => {
    // gas_wei travelled and gas_usdg did not, so hosted summed 0.00 of gas AND
    // counted every landed fill as unpriceable — a warning stamped on every book
    // that was really about our own missing column.
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const g = (await shared
      .prepare(
        `SELECT COALESCE(SUM(gas_usdg), 0) AS usdg,
                SUM(CASE WHEN gas_wei IS NOT NULL AND gas_usdg IS NULL THEN 1 ELSE 0 END) AS unpriced
           FROM trades WHERE agent_id = ? AND status = 'landed'`,
      )
      .get("0xagent")) as { usdg: number; unpriced: number };
    assert.equal(Number(g.usdg), 1.25, "5 fills at 0.25");
    assert.equal(Number(g.unpriced), 0);
  });

  it("carries the positions leg of the equity identity", async () => {
    const shared = mem(DEST);
    await mirrorTenant({ tenant: "0xten", child: seedChild(), shared });
    const e = (await shared
      .prepare("SELECT cash_usdg, vault_usdg, positions_usdg, equity_usdg FROM equity")
      .get()) as { cash_usdg: number; vault_usdg: number; positions_usdg: number; equity_usdg: number };
    assert.equal(Number(e.positions_usdg), 10);
    // The mirrored row must still decompose into the numbers that made it.
    assert.equal(
      Number(e.cash_usdg) + Number(e.vault_usdg) + Number(e.positions_usdg),
      Number(e.equity_usdg),
    );
  });
});
