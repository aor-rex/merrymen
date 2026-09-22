import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readProfileTrades } from "./profile-trades";
import { STOCK_TOKENS } from "../../../packages/core/src/tokens";

test("profile history reads fills beyond the social window, keeps repeats, and respects book privacy", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT);
      CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT, created_at INTEGER, amount_usdg REAL);
      INSERT INTO decisions VALUES ('d','a','buy','USAR',NULL);
      INSERT INTO trades VALUES
      (1,'d','a',1,'swap','buy','landed',1,12),
      (2,'d','a',1,'swap','buy','landed',2,12),
      (3,NULL,'a',1,'curve-trade','sell','paper',3,5),
      (4,'d','a',1,'swap','buy','rejected',4,50),
      (5,'d','a',1,'transfer','sell','landed',5,50),
      (6,'d','other',1,'swap','buy','landed',6,50),
      (7,'d','a',2,'swap','buy','landed',7,50);`);
    await db.exec("ALTER TABLE trades ADD COLUMN fill_symbol TEXT; ALTER TABLE trades ADD COLUMN buy_token TEXT; ALTER TABLE trades ADD COLUMN sell_token TEXT; ALTER TABLE trades ADD COLUMN user_op_hash TEXT;");
    await db.exec("ALTER TABLE trades ADD COLUMN realized_pnl_usdg REAL; ALTER TABLE trades ADD COLUMN fill_cash_usdg REAL; ALTER TABLE trades ADD COLUMN basis_source TEXT;");
    const privateBook = await readProfileTrades(db, "a", 1, false);
    assert.equal(privateBook.read, true);
    assert.deepEqual(privateBook.trades.map(t => t.id), ["3", "2", "1"]);
    assert.equal(privateBook.trades[0].paper, true);
    assert.equal(privateBook.trades[1].symbol, "USAR");
    assert.ok(privateBook.trades.every(t => t.sizeUsdg === null));
    assert.ok(privateBook.trades.every(t => !('agent_id' in t)));
    const published = await readProfileTrades(db, "a", 1, true);
    assert.equal(published.trades[1].sizeUsdg, 12);
    await db.exec("UPDATE decisions SET symbol = '0x0123456789abcdef0123456789abcdef01234567'");
    assert.equal((await readProfileTrades(db, "a", 1, true)).trades[1].symbol, null);
    await db.prepare("UPDATE trades SET decision_id = NULL, fill_side = NULL, buy_token = ? WHERE id = 1").run(STOCK_TOKENS[0].address);
    const legacy = (await readProfileTrades(db, "a", 1, false)).trades.find(t => t.id === "1");
    assert.equal(legacy?.action, "buy");
    assert.equal(legacy?.symbol, STOCK_TOKENS[0].symbol);
    await db.exec("UPDATE trades SET buy_token = NULL WHERE id = 1");
    assert.equal((await readProfileTrades(db, "a", 1, false)).trades.find(t => t.id === "1")?.action, "swap");
  } finally { raw.close(); }
});

test("paper and live sales publish evidenced P&L without exposing private amounts", async () => {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT);
      CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT, created_at INTEGER, amount_usdg REAL, buy_token TEXT, sell_token TEXT, realized_pnl_usdg REAL, fill_cash_usdg REAL, basis_source TEXT);
      INSERT INTO trades VALUES
        (1,NULL,'a',1,'swap','sell','paper',1,12,NULL,NULL,2,12,'paper'),
        (2,NULL,'a',1,'swap','sell','landed',2,8,NULL,NULL,-2,8,'receipt'),
        (3,NULL,'a',1,'swap','sell','paper',3,10,NULL,NULL,0,10,'paper'),
        (4,NULL,'a',1,'swap','sell','paper',4,10,NULL,NULL,NULL,10,'paper'),
        (5,NULL,'a',1,'swap','sell','landed',5,10,NULL,NULL,2,12,'quote'),
        (6,NULL,'a',1,'swap','buy','paper',6,10,NULL,NULL,2,12,'paper');`);
    await db.exec("ALTER TABLE trades ADD COLUMN fill_symbol TEXT; ALTER TABLE trades ADD COLUMN user_op_hash TEXT");
    const privateRows = (await readProfileTrades(db, 'a', 1, false)).trades;
    assert.deepEqual(privateRows.map(t => t.realizedPnlBps), [null, null, null, 0, -2000, 2000]);
    assert.ok(privateRows.every(t => t.realizedPnlUsdg === null && t.sizeUsdg === null));
    const publicRows = (await readProfileTrades(db, 'a', 1, true)).trades;
    assert.deepEqual(publicRows.map(t => t.realizedPnlUsdg), [null, null, null, 0, -2, 2]);
    await db.exec('UPDATE trades SET fill_cash_usdg = NULL WHERE id = 1');
    assert.equal((await readProfileTrades(db, 'a', 1, true)).trades.find(t => t.id === '1')?.realizedPnlBps, null);
  } finally { raw.close(); }
});

test("a redeploy's re-recorded copy of a fill never stands in for the fill", async () => {
  // The production shape: the executor's row carries the side, the decision and
  // the coin; after a redeploy the reconciler writes the same op again as a bare
  // 'swap' stamped at the restart, and the mirror carried it up beside the
  // original. Newest-first, the copy came first and read "Swapped token".
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  try {
    await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT);
      CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT,
        created_at INTEGER, amount_usdg REAL, user_op_hash TEXT, fill_symbol TEXT, buy_token TEXT, sell_token TEXT,
        realized_pnl_usdg REAL, fill_cash_usdg REAL, basis_source TEXT);
      INSERT INTO decisions VALUES ('d','a','buy','CASHCAT','Cash Cat'), ('e','a','buy','CHUMP','CHUMP');
      INSERT INTO trades (id, decision_id, agent_id, epoch, kind, fill_side, status, created_at, amount_usdg, user_op_hash) VALUES
        (1,'d','a',1,'curve-trade','buy','landed',1000,5,'0xOPHASH'),
        (2,NULL,'a',1,'swap',NULL,'landed',5000,5,'0xophash'),
        (3,NULL,'a',1,'vault-deposit',NULL,'landed',1500,5,'0xvault'),
        (4,NULL,'a',1,'swap',NULL,'landed',5000,5,'0xVAULT'),
        (5,'e','a',1,'curve-trade','buy','landed',1600,5,'0xchump');`);
    const { trades, read } = await readProfileTrades(db, "a", 1, false);
    assert.equal(read, true);
    // Row 2 is row 1 written again; row 4 is a vault deposit written again as a
    // 'swap', and it must not surface as a trade merely because the original
    // is a kind this list does not show.
    assert.deepEqual(trades.map(t => t.id), ["5", "1"]);
    assert.equal(trades[1].action, "buy");
    assert.equal(trades[1].symbol, "CASHCAT");
    assert.equal(trades[1].displayName, "Cash Cat", "the coin's own name travels with the fill");
    assert.equal(trades[0].displayName, null, "a name that only repeats the symbol adds nothing");
  } finally { raw.close(); }
});

test("a missing trades table reports unavailable rather than an empty history", async () => {
  const raw = new DatabaseSync(":memory:");
  try { assert.equal((await readProfileTrades(wrapSqlite(raw), "a", 1, false)).read, false); }
  finally { raw.close(); }
});
