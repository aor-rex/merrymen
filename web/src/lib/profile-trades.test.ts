import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readProfileTrades, readRoundTrips, readTopTrades, vouchedSells } from "./profile-trades";
import { averageHoldSec } from "./hold-time";
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

/**
 * The production columns a top-trades read touches, on a real sqlite ledger.
 * Every row is a sell unless it says otherwise.
 */
async function sellsLedger() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT);
    CREATE TABLE trades(id INTEGER, decision_id TEXT, agent_id TEXT, epoch INTEGER, kind TEXT, fill_side TEXT, status TEXT,
      created_at INTEGER, amount_usdg REAL, user_op_hash TEXT, fill_symbol TEXT, buy_token TEXT, sell_token TEXT,
      realized_pnl_usdg REAL, fill_cash_usdg REAL, basis_source TEXT, fill_qty_raw TEXT);`);
  return { raw, db };
}
const sellRow = (id: number, pnl: number | null, cash: number | null, over: Record<string, unknown> = {}) => ({
  id, decision_id: null, agent_id: "a", epoch: 1, kind: "swap", fill_side: "sell", status: "landed", created_at: id,
  amount_usdg: 5, user_op_hash: `0xop${id}`, fill_symbol: `C${id}`, buy_token: "0xusdg", sell_token: `0xtok${id}`,
  realized_pnl_usdg: pnl, fill_cash_usdg: cash, basis_source: "receipt", fill_qty_raw: "1", ...over,
});
async function insert(db: ReturnType<typeof wrapSqlite>, rows: Record<string, unknown>[]) {
  for (const r of rows) {
    const cols = Object.keys(r);
    await db.prepare(`INSERT INTO trades (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(r) as never[]));
  }
}

test("TOP TRADES are the best evidenced sells by RETURN, not by dollars, and only five", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      // +10 on a cost of 100 = +10%: the biggest dollar win, not the best trade.
      sellRow(1, 10, 110),
      // +5 on a cost of 10 = +50%.
      sellRow(2, 5, 15),
      sellRow(3, 1, 11), // +10% on 10
      sellRow(4, 3, 13), // +30%
      sellRow(5, -2, 8), // -20%
      sellRow(6, 2, 12), // +20%
      sellRow(7, 0.5, 10.5), // +5%
    ]);
    const { trades, read } = await readTopTrades(db, "a", 1, false, "landed");
    assert.equal(read, true);
    // 1 and 3 tie at +10%; the newer one ranks first.
    assert.deepEqual(trades.map((t) => t.id), ["2", "4", "6", "3", "1"], "ranked by bps, cut at five");
    assert.deepEqual(trades.map((t) => t.realizedPnlBps), [5000, 3000, 2000, 1000, 1000]);
    assert.ok(trades.every((t) => t.action === "sell"));
    assert.ok(trades.every((t) => t.realizedPnlUsdg === null && t.sizeUsdg === null), "a private book shows no dollars");
    const pub = await readTopTrades(db, "a", 1, true, "landed");
    assert.equal(pub.trades[0].realizedPnlUsdg, 5, "and a public one does");
  } finally { raw.close(); }
});

test("a top trade is EVIDENCED, in this book, after the dedupe", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      sellRow(1, 1, 11), // +10%, the only honest one
      sellRow(2, 9, 10, { basis_source: "quote" }), // a quote is an estimate
      sellRow(3, 9, 10, { status: "paper", basis_source: "paper" }), // the other book
      sellRow(4, 9, 10, { kind: "transfer" }), // not a trade
      sellRow(5, 9, 10, { agent_id: "b" }), // not this agent
      sellRow(6, 9, 10, { epoch: 2 }), // not this period
      sellRow(7, 9, 10, { fill_side: "buy" }), // not a sell
      sellRow(8, null, 10), // P&L never attributed
      sellRow(9, 9, 9), // no cost left to divide by
      sellRow(10, 9, null), // cash leg unread
      // A redeploy's copy of op 1, stamped later, carrying a wild figure: it
      // collapses into op 1 and never stands as a trade of its own.
      sellRow(11, 50, 60, { user_op_hash: "0xOP1", created_at: 999 }),
    ]);
    const live = await readTopTrades(db, "a", 1, false, "landed");
    assert.deepEqual(live.trades.map((t) => t.id), ["1"]);
    const paper = await readTopTrades(db, "a", 1, false, "paper");
    assert.deepEqual(paper.trades.map((t) => t.id), ["3"], "a paper agent ranks its paper sells");
    assert.equal(paper.trades[0].paper, true);
  } finally { raw.close(); }
});

test("the ranking sees only what the page will print, so estimates cannot crowd a real trade out of the five", async () => {
  // Filtering after the LIMIT would rank five quoted or mis-sided rows first,
  // drop them all, and publish "No closed trades yet" over a real +10%.
  const { raw, db } = await sellsLedger();
  try {
    const crowd = [1, 2, 3, 4, 5].map((i) => sellRow(i, 9, 10, { basis_source: "quote" }));
    const buys = [6, 7, 8, 9, 10].map((i) => sellRow(i, 9, 10, { fill_side: "buy" }));
    await insert(db, [...crowd, ...buys, sellRow(11, 1, 11)]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["11"]);
  } finally { raw.close(); }
});

test("no closed trades is an empty list that was READ; a broken ledger is not", async () => {
  const { raw, db } = await sellsLedger();
  try {
    assert.deepEqual(await readTopTrades(db, "a", 1, false, "landed"), { trades: [], read: true });
  } finally { raw.close(); }
  const bare = new DatabaseSync(":memory:");
  try { assert.equal((await readTopTrades(wrapSqlite(bare), "a", 1, false, "landed")).read, false); }
  finally { bare.close(); }
});

test("round trips read every fill of the book, oldest first, keyed by coin", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      sellRow(1, null, null, { fill_side: "buy", fill_symbol: "CASH", fill_qty_raw: "10", created_at: 100 }),
      sellRow(2, 1, 6, { fill_symbol: "CASH", fill_qty_raw: "10", created_at: 400 }),
      // A stock fill that predates fill_side and fill_symbol: the executed pair names it.
      sellRow(3, null, null, { fill_side: null, fill_symbol: null, buy_token: STOCK_TOKENS[0].address, fill_qty_raw: "2", created_at: 500 }),
      sellRow(4, null, null, { status: "paper", basis_source: "paper", created_at: 50 }), // the other book
      sellRow(5, null, null, { status: "rejected", created_at: 60 }), // filled nothing
      // A redeploy's copy of op 2: collapses into it rather than reading as a fill with no quantity.
      sellRow(6, null, null, { user_op_hash: "0xOP2", fill_side: null, fill_symbol: null, fill_qty_raw: null, basis_source: null, created_at: 999 }),
    ]);
    const r = await readRoundTrips(db, "a", 1, "landed");
    assert.ok(r);
    assert.equal(r.truncated, false);
    assert.deepEqual(r.fills.map((f) => [f.side, f.coin, f.qty, f.at]), [
      ["buy", "CASH", 10n, 100],
      ["sell", "CASH", 10n, 400],
      ["buy", STOCK_TOKENS[0].symbol, 2n, 500],
    ]);
    assert.equal(averageHoldSec(r.fills), 300);
    // A cap the read reaches says so: the count becomes a floor, and the hold —
    // which needs the earliest buys — is not computed from a partial tape.
    const capped = await readRoundTrips(db, "a", 1, "landed", 2);
    assert.equal(capped?.truncated, true);
    assert.equal(capped?.fills.length, 2);
  } finally { raw.close(); }
  const bare = new DatabaseSync(":memory:");
  try { assert.equal(await readRoundTrips(wrapSqlite(bare), "a", 1, "landed"), null, "unread is null, never an empty history"); }
  finally { bare.close(); }
});

test("a fill whose quantity or coin was not recorded is carried as unread", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      sellRow(1, null, null, { fill_side: "buy", fill_symbol: "CASH", fill_qty_raw: "10", created_at: 100 }),
      sellRow(2, 1, 6, { fill_symbol: "CASH", fill_qty_raw: null, created_at: 400 }),
      sellRow(3, null, null, { fill_side: "buy", fill_symbol: null, fill_qty_raw: "3", created_at: 500 }),
      // Neither the fill, its decision nor the executed pair says which way it went.
      sellRow(4, null, null, { fill_side: null, fill_symbol: "CASH", fill_qty_raw: "4", created_at: 600 }),
    ]);
    const r = await readRoundTrips(db, "a", 1, "landed");
    assert.deepEqual(r?.fills.map((f) => [f.side, f.coin, f.qty]), [["buy", "CASH", 10n], ["sell", "CASH", null], ["buy", null, 3n], [null, "CASH", 4n]]);
    assert.equal(averageHoldSec(r!.fills), null);
  } finally { raw.close(); }
});

// ── PF4: a top trade's return rests on an evidenced cost ─────────────────────
const buyRow = (id: number, token: string, qty: string, over: Record<string, unknown> = {}) =>
  sellRow(id, null, null, { fill_side: "buy", buy_token: token, sell_token: "0xusdg", fill_qty_raw: qty, ...over });

test("a sell whose cost a QUOTED buy built is not a top trade, however good it looks", async () => {
  // realized_pnl_usdg is proceeds minus the running cost basis, and a buy whose
  // receipt could not be read books that basis from the quote — an estimate.
  // Checking only the sell's own basis_source let such a sell rank first.
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote" }),
      sellRow(2, 9, 10, { sell_token: "0xmeme", fill_qty_raw: "10" }), // +900% on an estimated cost
      sellRow(3, 1, 11), // +10%, on no estimate at all
    ]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["3"]);
  } finally { raw.close(); }
});

test("an estimate stops counting once the position it built was sold out", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote" }),
      sellRow(2, 9, 10, { sell_token: "0xmeme", fill_qty_raw: "10" }), // closes the estimated lot: not vouched
      buyRow(3, "0xmeme", "5"), // a fresh position, from a receipt
      sellRow(4, 2, 6, { sell_token: "0xmeme", fill_qty_raw: "5" }), // +50%, on that receipt alone
    ]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["4"]);
    // A PARTIAL sell leaves the estimate in what is still held.
    await insert(db, [buyRow(5, "0xcat", "10", { basis_source: "quote" }), sellRow(6, 1, 2, { sell_token: "0xcat", fill_qty_raw: "4" }), sellRow(7, 1, 2, { sell_token: "0xcat", fill_qty_raw: "6" })]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["4"]);
  } finally { raw.close(); }
});

test("a cost carried in from an earlier period is still that cost", async () => {
  // cost_basis is not epoch-scoped: a position bought last period is sold
  // against the basis that period booked.
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote", epoch: 0 }),
      sellRow(2, 9, 10, { sell_token: "0xmeme", fill_qty_raw: "10" }),
    ]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades, []);
  } finally { raw.close(); }
});

test("a movement the ledger cannot size keeps an estimate in, because flat can no longer be told", async () => {
  const { raw, db } = await sellsLedger();
  try {
    await insert(db, [
      buyRow(1, "0xmeme", "10", { basis_source: "quote" }),
      // The reconciler booked a cost for an op it recovered, and wrote no side.
      sellRow(2, null, null, { fill_side: null, buy_token: "0xmeme", sell_token: "0xusdg", fill_qty_raw: null, basis_source: "receipt" }),
      sellRow(3, 1, 2, { sell_token: "0xmeme", fill_qty_raw: "10" }),
      buyRow(4, "0xmeme", "5"),
      sellRow(5, 1, 2, { sell_token: "0xmeme", fill_qty_raw: "5" }),
    ]);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades, []);
  } finally { raw.close(); }
});

test("estimates ranked above a real trade cannot push it out of the list, past the first page too", async () => {
  const { raw, db } = await sellsLedger();
  try {
    const rows: Record<string, unknown>[] = [];
    for (let i = 1; i <= 30; i++) {
      rows.push(buyRow(100 + i, `0xq${i}`, "1", { basis_source: "quote", created_at: i }));
      rows.push(sellRow(200 + i, 9, 10, { sell_token: `0xq${i}`, created_at: 1_000 + i }));
    }
    rows.push(sellRow(300, 1, 11, { created_at: 2_000 }));
    await insert(db, rows);
    assert.deepEqual((await readTopTrades(db, "a", 1, false, "landed")).trades.map((t) => t.id), ["300"]);
  } finally { raw.close(); }
});

test("the replay that vouches for a cost vouches for nothing it could not read whole", () => {
  const fills = [
    { op: "b", side: "buy" as const, token: "0xm", qty: "10", source: "receipt" },
    { op: "s", side: "sell" as const, token: "0xm", qty: "10", source: "receipt" },
  ];
  assert.deepEqual([...vouchedSells(fills, true)], ["s"]);
  assert.deepEqual([...vouchedSells(fills, false)], [], "a truncated read cannot know what came before its first row");
  assert.deepEqual([...vouchedSells([{ ...fills[0]!, source: null }, fills[1]!], true)], [], "a cost of unknown provenance is not evidence");
  assert.deepEqual([...vouchedSells([{ ...fills[0]!, source: "paper" }, { ...fills[1]!, source: "paper" }], true)], ["s"], "a paper fill is exact");
  // A row with no side that booked a cost from a quote put that estimate in.
  assert.deepEqual([...vouchedSells([{ op: "r", side: null, token: "0xm", qty: null, source: "quote" }, fills[1]!], true)], []);
});
