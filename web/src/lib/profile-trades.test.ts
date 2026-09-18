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
    await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT);
      CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT, created_at INTEGER, amount_usdg REAL);
      INSERT INTO decisions VALUES ('d','a','buy','USAR');
      INSERT INTO trades VALUES
      (1,'d','a',1,'swap','buy','landed',1,12),
      (2,'d','a',1,'swap','buy','landed',2,12),
      (3,NULL,'a',1,'curve-trade','sell','paper',3,5),
      (4,'d','a',1,'swap','buy','rejected',4,50),
      (5,'d','a',1,'transfer','sell','landed',5,50),
      (6,'d','other',1,'swap','buy','landed',6,50),
      (7,'d','a',2,'swap','buy','landed',7,50);`);
    await db.exec("ALTER TABLE trades ADD COLUMN buy_token TEXT; ALTER TABLE trades ADD COLUMN sell_token TEXT;");
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

test("a missing trades table reports unavailable rather than an empty history", async () => {
  const raw = new DatabaseSync(":memory:");
  try { assert.equal((await readProfileTrades(wrapSqlite(raw), "a", 1, false)).read, false); }
  finally { raw.close(); }
});
