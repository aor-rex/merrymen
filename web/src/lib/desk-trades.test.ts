/**
 * THE OWNER'S OWN DESK SHOWS THE MEMECOIN TRADES ITS AGENT MADE.
 *
 * /api/feed selected trades with no fill side, no symbol and no decision, and
 * the terminal resolved a side only through STOCK_TOKENS — so every curve and
 * class trade arrived with action null, the desk kept only buys and sells, and
 * Shogun's CASHCAT and CHUMP round trips read "Trades · 0". The chat tape sent
 * the model action null and symbol null, so "what did you just buy?" had no
 * answer in it, and spentToday never counted a memecoin fill.
 *
 * Driven end to end through the two pieces that were wrong: the ledger read the
 * route now uses, and the terminal's mapping of its rows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { STOCK_TOKENS } from "../../../packages/core/src/tokens";
import { fmtEpoch } from "./ledger";
import { countLandedOps, readDeskTrades } from "./desk-trades";
import { mineOf } from "../terminal/live";
import { positionsOf, spentToday } from "../terminal/account";

// Local noon today, so every row below falls in the same local day spentToday counts.
const NOW = Math.floor(new Date().setHours(12, 0, 0, 0) / 1000);
const WEEK = 7 * 86_400;

async function shogun() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT, reason TEXT);
    CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, sell_token TEXT, buy_token TEXT,
      amount_usdg REAL, tx_hash TEXT, status TEXT, reject_rule TEXT, sim_quote_out TEXT, sim_min_out TEXT, sim_fee_tier INTEGER,
      sim_gas TEXT, created_at INTEGER, user_op_hash TEXT, decision_id TEXT, fill_side TEXT, fill_symbol TEXT,
      realized_pnl_usdg REAL, epoch INTEGER);
    INSERT INTO decisions VALUES
      ('d1','0xA','buy','CASHCAT','Cash Cat','volume doubled on the curve'),
      ('d2','0xA','sell','CASHCAT','Cash Cat','took the move'),
      ('d3','0xA','buy','CHUMP',NULL,'fresh launch');`);
  await db
    .prepare(
      `INSERT INTO trades (agent_id, kind, sell_token, buy_token, amount_usdg, status, reject_rule, created_at, user_op_hash,
                           decision_id, fill_side, realized_pnl_usdg, epoch) VALUES
        ('0xA','curve-trade','0xUSDG','0xCASHCAT',5,'landed',NULL,?,'0xOP1','d1','buy',NULL,2),
        ('0xA','curve-trade','0xCASHCAT','0xUSDG',6,'landed',NULL,?,'0xOP2','d2','sell',1,2),
        ('0xA','swap',NULL,NULL,5,'landed',NULL,?,'0xop1',NULL,NULL,NULL,2),
        ('0xA','curve-trade','0xUSDG','0xCHUMP',50,'rejected','per-trade-cap',?,NULL,'d3',NULL,NULL,2),
        ('0xA','swap','0xUSDG',?,4,'landed',NULL,?,'0xOP3',NULL,NULL,NULL,2),
        ('0xA','swap','0xUSDG','0xCASHCAT',9,'landed',NULL,?,'0xOLD',NULL,'buy',NULL,1)`,
    )
    .run(NOW - 300, NOW - 200, NOW - 60, NOW - 100, STOCK_TOKENS[0]!.address, NOW - 50, NOW - 40);
  return { raw, db };
}

describe("the owner's desk and chat see every trade the agent made", () => {
  it("reads one row per operation, carrying the side, the coin and the decision's reason", async () => {
    const { raw, db } = await shogun();
    try {
      const rows = await readDeskTrades(db, "0xA", 2, NOW - WEEK);
      assert.equal(rows.length, 4, "the reconciler's copy of 0xOP1 and the epoch-1 row are not this run's operations");
      const buy = rows.find((r) => r.fill_side === "buy" && r.symbol === "CASHCAT");
      assert.ok(buy, "the curve buy is on the tape with its coin");
      assert.equal(buy!.display_name, "Cash Cat");
      assert.equal(buy!.reason, "volume doubled on the curve");
      const refused = rows.find((r) => r.status === "rejected");
      assert.equal(refused?.action, "buy", "a refusal carries the side the decision asked for");
      assert.equal(refused?.symbol, "CHUMP");
      assert.equal(await countLandedOps(db, "0xA", 2), 3, "three operations landed, whatever the tape holds");
    } finally {
      raw.close();
    }
  });

  it("the desk keeps the curve round trip, the chat tape names the coin, and the day's spend counts it", async () => {
    const { raw, db } = await shogun();
    try {
      const rows = await readDeskTrades(db, "0xA", 2, NOW - WEEK);
      const mine = mineOf(
        { agent: { name: "Shogun", strategy: "trencher", slug: null }, trades: rows.map((r) => ({ ...r, created_at: fmtEpoch(r.created_at) })) },
        [],
      )!;
      const trades = mine.moves.filter((m) => m.action === "buy" || m.action === "sell");
      assert.deepEqual(
        trades.map((m) => `${m.action} ${m.symbol} ${m.outcome}`).sort(),
        ["buy CASHCAT landed", "buy CHUMP refused", `buy ${STOCK_TOKENS[0]!.symbol} landed`, "sell CASHCAT landed"].sort(),
      );
      const cashcat = trades.find((m) => m.action === "buy" && m.symbol === "CASHCAT")!;
      assert.equal(cashcat.reason, "volume doubled on the curve", "the desk shows why, not 'No explanation available.'");
      const refused = trades.find((m) => m.symbol === "CHUMP")!;
      assert.equal(refused.outcomeText !== null && refused.outcomeText !== undefined, true, "and what the wall refused");
      // The ledger's figures, landed only: 5 + 6 + the stock buy's 4. The
      // refused 50 moved nothing.
      assert.equal(spentToday(mine as never, NOW * 1000), 15);
    } finally {
      raw.close();
    }
  });

  it("a row the ledger cannot name is kept with no side or symbol, never guessed", async () => {
    const mine = mineOf(
      {
        agent: { name: "Shogun", strategy: "trencher", slug: null },
        trades: [
          { kind: "swap", buy_token: null, sell_token: null, amount_usdg: 5, status: "landed", created_at: fmtEpoch(NOW - 10) },
          { kind: "curve-trade", buy_token: "0xabc", sell_token: "0xUSDG", amount_usdg: 5, status: "landed", fill_side: "buy",
            symbol: "0x0123456789abcdef0123456789abcdef01234567", created_at: fmtEpoch(NOW - 5) },
        ],
      },
      [],
    )!;
    assert.equal(mine.moves.length, 2, "nothing is dropped");
    assert.equal(mine.moves[0]!.action, null);
    assert.equal(mine.moves[0]!.symbol, null);
    assert.equal(mine.moves[1]!.action, "buy");
    assert.equal(mine.moves[1]!.symbol, null, "an address is not a symbol");
  });

  it("a copy whose original fell just outside the tape's window stays collapsed into it", async () => {
    const { raw, db } = await shogun();
    try {
      // 0xOP9 filled an hour before the window opens; the reconciler's copy of
      // it landed inside. Without its original to collapse into, the copy would
      // head the owner's tape as a fresh, sideless trade.
      await db
        .prepare(
          `INSERT INTO trades (agent_id, kind, amount_usdg, status, created_at, user_op_hash, decision_id, fill_side, epoch) VALUES
            ('0xA','curve-trade',5,'landed',?,'0xOP9','d1','buy',2), ('0xA','swap',5,'landed',?,'0xop9',NULL,NULL,2)`,
        )
        .run(NOW - WEEK - 3600, NOW - 30);
      const rows = await readDeskTrades(db, "0xA", 2, NOW - WEEK);
      assert.equal(rows.length, 4, "neither 0xOP9 row: the fill is outside the window and its copy is not an operation");
    } finally {
      raw.close();
    }
  });

  it("a ledger too old for the richer read still returns its tape", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    try {
      await db.exec(`CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT, kind TEXT, sell_token TEXT, buy_token TEXT,
        amount_usdg REAL, tx_hash TEXT, status TEXT, reject_rule TEXT, sim_quote_out TEXT, sim_min_out TEXT, sim_fee_tier INTEGER,
        sim_gas TEXT, created_at INTEGER);`);
      await db.prepare(`INSERT INTO trades (agent_id, kind, amount_usdg, status, created_at) VALUES ('0xA','swap',3,'landed',?)`).run(NOW - 10);
      const rows = await readDeskTrades(db, "0xA", null, NOW - WEEK);
      assert.equal(rows.length, 1);
    } finally {
      raw.close();
    }
  });
});

describe("the desk's positions carry the % the terminal already computed", () => {
  it("a position with a recorded cost shows its return; one without says so; a stale mark shows no %", () => {
    const mine = mineOf(
      {
        agent: { name: "Shogun", strategy: "trencher", slug: null },
        positions: [
          { symbol: "CASHCAT", value_usdg: 12, price_stale: 0, cost_usdg: 10, cost_from_quote: false },
          { symbol: "CHUMP", value_usdg: 5, price_stale: 0, cost_usdg: null },
          { symbol: "OLD", value_usdg: 5, price_stale: 1, cost_usdg: 4, cost_from_quote: false },
        ],
      },
      [],
    )!;
    const [cashcat, chump, old] = positionsOf(mine as never);
    assert.ok(cashcat!.pnl !== null && Math.abs(cashcat!.pnl - 20) < 1e-9, "12 on a cost of 10 is +20%");
    assert.equal(chump!.pnl, null, "no cost on record is not 0%");
    assert.match(chump!.detail, /cost unknown/);
    assert.equal(old!.pnl, null, "an old price's return is not printed as today's");
    assert.match(old!.detail, /last mark/);
  });
});
