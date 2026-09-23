/**
 * AN AGENT'S LANDED TRADES REACH ITS OWN MEMORY, WHATEVER IT SAID SINCE.
 *
 * The orchestrator materialises an agent's own published theses into its peer
 * file through `readPeerTheses`, and the Brain's memory is rendered from that.
 * It returned the newest twenty-four posts, full stop — twelve minutes of a
 * Trencher reviewing every thirty seconds — so a buy that landed an hour ago
 * was never in the file, and memory could not remember a single trade.
 *
 * So the read keeps a few LANDED trades beside the newest posts, through the
 * same gate, and carries the trade's own figures so a closed trade can be
 * remembered with its result. These run the real query on a real SQLite.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite } from "./db";
import { PEER_THESIS_LIMIT, readPeerTheses } from "./peer-theses";

const AGENT = "0x1111111111111111111111111111111111111111" as const;
const NOW = Math.floor(Date.now() / 1000);

async function ledger(fills: boolean) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await db.exec(`
    CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT, x_handle TEXT, mode TEXT);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, at INTEGER, action TEXT, symbol TEXT, size_usdg REAL,
      source TEXT, reason TEXT, dropped_rule TEXT, hold_kind TEXT);
    CREATE TABLE trades (id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT
      ${fills ? ", fill_price_usd REAL, fill_cash_usdg REAL, realized_pnl_usdg REAL, basis_source TEXT" : ""});
    CREATE TABLE posts (decision_id TEXT, body TEXT);
    INSERT INTO agents VALUES ('${AGENT}', 'Shogun', NULL, 'paper');`);
  const decide = db.prepare("INSERT INTO decisions VALUES (?, ?, ?, ?, 'TA151B4A9E1B', ?, 'brain', ?, NULL, ?)");
  await decide.run("buy", AGENT, NOW - 7200, "buy", 5, "Flow turned net positive; a small entry.", null);
  await decide.run("sell", AGENT, NOW - 3600, "sell", 6.5, "Sellers returned; taking it off.", null);
  for (let i = 0; i < 40; i++) {
    await decide.run(`hold-${i}`, AGENT, NOW - 30 * i, "hold", 0, `Review ${i}: edge unclear, so hold.`, "MODEL_HOLD");
  }
  if (fills) {
    await db.exec(`INSERT INTO trades (decision_id, status, fill_price_usd, fill_cash_usdg, realized_pnl_usdg, basis_source)
      VALUES ('buy', 'paper', 0.0004, 5, NULL, 'paper'), ('sell', 'paper', 0.00052, 6.5, 1.5, 'paper')`);
  } else {
    await db.exec(`INSERT INTO trades (decision_id, status) VALUES ('buy', 'paper'), ('sell', 'paper')`);
  }
  return { raw, db };
}

describe("an agent's own landed trades are in the file its memory reads", () => {
  it("TWO LANDED TRADES SURVIVE FORTY NEWER HOLDS", async () => {
    const { raw, db } = await ledger(true);
    try {
      const own = await readPeerTheses(db, [AGENT]);
      assert.ok(own.length <= PEER_THESIS_LIMIT, "still one prompt's budget");
      assert.ok(own.some((t) => t.action === "buy" && t.outcome === "landed"), "the buy is remembered");
      assert.ok(own.some((t) => t.action === "sell" && t.outcome === "landed"), "the sell is remembered");
      assert.ok(own.some((t) => t.action === "hold"), "and the newest words are still there");
      assert.deepEqual(own.map((t) => t.at), [...own.map((t) => t.at)].sort((a, b) => b - a), "newest first");
    } finally {
      raw.close();
    }
  });

  it("A CLOSED TRADE ARRIVES WITH ITS RESULT", async () => {
    const { raw, db } = await ledger(true);
    try {
      const sell = (await readPeerTheses(db, [AGENT])).find((t) => t.action === "sell")!;
      assert.equal(sell.realizedPct, 30);
      assert.equal(sell.realizedUsd, null, "dollars never travel to another agent's prompt");
      const buy = (await readPeerTheses(db, [AGENT])).find((t) => t.action === "buy")!;
      assert.equal(buy.entryPriceUsd, 0.0004);
    } finally {
      raw.close();
    }
  });

  it("a ledger without the fill columns still yields the trades, with no figures", async () => {
    const { raw, db } = await ledger(false);
    try {
      const own = await readPeerTheses(db, [AGENT]);
      const sell = own.find((t) => t.action === "sell");
      assert.ok(sell, "the trade is still remembered");
      assert.equal(sell!.realizedPct, null);
    } finally {
      raw.close();
    }
  });

  it("each landed trade appears once, not once per lane", async () => {
    const { raw, db } = await ledger(true);
    try {
      // Only the two trades and three holds: everything fits in one page, so
      // both reads return the trades and the merge must not double them.
      await db.exec("DELETE FROM decisions WHERE id LIKE 'hold-%' AND at < " + (NOW - 60));
      const own = await readPeerTheses(db, [AGENT]);
      assert.equal(own.filter((t) => t.action === "sell").length, 1);
      assert.equal(own.filter((t) => t.action === "buy").length, 1);
    } finally {
      raw.close();
    }
  });
});
