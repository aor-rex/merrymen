import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import { applyLedgerSchema } from "../../../worker/src/store";
import { profileOf } from "./read-agent";

/**
 * ONE AGENT'S PUBLIC PAGE, read from a ledger built by the worker's own schema.
 *
 * The profile's new figures — the stats line, TOP TRADES, the gasless claim and
 * the full-period chart — are claims about a named agent, so they are driven
 * through the real read against real columns rather than trusted.
 */
const ACCOUNT = "0xa6e17a1b2c3d4e5f60718293a4b5c6d7e8f90123";
const H = 3_600;
const T0 = 2_000_000 * H; // an hour boundary, long after ACCOUNTING_FIXED_AT

async function ledger(): Promise<{ raw: DatabaseSync; db: Db }> {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  await db.prepare(
    `INSERT INTO agents (smart_account, name, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, mode, epoch, beat_at, contributions_known)
     VALUES (?, 'Shogun', '0x1', '0x2', 4663, '{}', 0, 0, 'live', 2, ?, 1)`,
  ).run(ACCOUNT, T0 + 40 * 24 * H);
  await db.prepare(`INSERT INTO flows (agent_id, epoch, direction, amount_usdg, tx_hash, source, at) VALUES (?, 2, 'in', 100, '0xtx', 'chain-log', ?)`).run(ACCOUNT, T0);
  return { raw, db };
}
async function mark(db: Db, at: number, equity: number) {
  await db.prepare(`INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, equity_usdg, at, epoch, mode) VALUES (?, '0', 0, 0, ?, ?, 2, 'live')`).run(ACCOUNT, equity, at);
}
let op = 0;
async function fill(db: Db, over: { side: "buy" | "sell"; coin: string; qty: string; at: number; pnl?: number; cash?: number; sponsored?: boolean }) {
  op += 1;
  await db.prepare(
    `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, created_at, epoch, fill_side, fill_symbol, fill_qty_raw,
                         fill_cash_usdg, realized_pnl_usdg, basis_source, gas_wei, gas_usdg, sponsored_gas_wei)
     VALUES (?, 'swap', 'x', 5, ?, 'landed', ?, 2, ?, ?, ?, ?, ?, 'receipt', ?, ?, ?)`,
  ).run(ACCOUNT, `0xop${op}`, over.at, over.side, over.coin, over.qty, over.cash ?? 5, over.pnl ?? null,
    over.sponsored ? null : "1000", over.sponsored ? null : 0.01, over.sponsored ? "1000" : null);
}
const identity = { slug: "shogun", accounts: [ACCOUNT], createdAt: T0 - 86_400 };

test("the profile reports the whole period: its chart, its stats line and its best trades", async () => {
  const { raw, db } = await ledger();
  try {
    // Forty days of readings, several an hour, ending at +21%.
    for (let h = 0; h <= 40 * 24; h++) {
      await mark(db, T0 + h * H + 60, 100 + (21 * h) / (40 * 24));
      await mark(db, T0 + h * H + 1_800, 100 + (21 * h) / (40 * 24));
    }
    await fill(db, { side: "buy", coin: "CASH", qty: "10", at: T0 + 100, sponsored: true });
    await fill(db, { side: "sell", coin: "CASH", qty: "10", at: T0 + 100 + 2 * H, pnl: 2, cash: 12, sponsored: true });
    await fill(db, { side: "buy", coin: "CHUMP", qty: "5", at: T0 + 10 * H, sponsored: true });
    await fill(db, { side: "sell", coin: "CHUMP", qty: "5", at: T0 + 14 * H, pnl: -1, cash: 4, sponsored: true });

    const p = await profileOf(db, identity, false);
    assert.ok(p);
    // THE CHART COVERS WHAT THE HEADLINE COVERS. The old read stopped at the
    // newest 500 rows — a little over ten days of this tape — so its left edge
    // was not the period's opening.
    assert.equal(p.growthComplete, true);
    assert.equal(p.growth[0]!.at, T0 + 60, "it opens on the period's first reading");
    assert.equal(p.growth.at(-1)!.at, T0 + 40 * 24 * H + 1_800, "and ends on the newest");
    assert.equal(p.growth.length, 40 * 24 + 2, "one close an hour, plus the opening mark");
    assert.ok(Math.abs(p.growth.at(-1)!.g - 1.21) < 1e-9, "the right-hand end is the headline's +21%");

    assert.equal(p.tradeCount, 4);
    assert.equal(p.tradeCountFloor, false);
    assert.equal(p.avgHoldSec, 3 * H, "CASH held 2h, CHUMP 4h");
    assert.equal(p.joinedAt, T0 - 86_400);

    assert.equal(p.topTradesRead, true);
    assert.deepEqual(p.topTrades.map((t) => [t.symbol, t.realizedPnlBps, t.realizedPnlUsdg]), [
      ["CASH", 2_000, null],
      ["CHUMP", -2_000, null],
    ]);
    assert.equal(p.gasless, true, "every landed operation was sponsored");
  } finally { raw.close(); }
});

test("gasless is claimed only when EVERY landed operation was sponsored", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    assert.equal((await profileOf(db, identity, false))!.gasless, false, "nothing landed is not 'every trade sponsored'");
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1, sponsored: true });
    assert.equal((await profileOf(db, identity, false))!.gasless, true);
    // A redeploy re-records that op as a bare copy with no gas on it. It is the
    // same operation, so it cannot end the claim.
    await db.prepare(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, created_at, epoch) VALUES (?, 'swap', 'x', 5, ?, 'landed', ?, 2)`,
    ).run(ACCOUNT, `0xOP${op}`, T0 + 9_999);
    assert.equal((await profileOf(db, identity, false))!.gasless, true, "a copy is not a self-paid op");
    // An empty sponsor figure is no sponsor — gas-audit.ts reads it the same way.
    await db.prepare("UPDATE trades SET sponsored_gas_wei = '' WHERE user_op_hash = ?").run(`0xop${op}`);
    assert.equal((await profileOf(db, identity, false))!.gasless, false, "an empty figure is not a sponsor");
    await db.prepare("UPDATE trades SET sponsored_gas_wei = '1000' WHERE user_op_hash = ?").run(`0xop${op}`);
    await fill(db, { side: "sell", coin: "CASH", qty: "1", at: T0 + 2, sponsored: false });
    assert.equal((await profileOf(db, identity, false))!.gasless, false, "one self-paid fill ends the claim");
  } finally { raw.close(); }
});

test("an unread join date, hold or trade count is left out, never invented", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    // One buy, never sold: a trade, but no round trip.
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1 });
    const p = await profileOf(db, { slug: "shogun", accounts: [ACCOUNT], createdAt: undefined }, false);
    assert.equal(p!.joinedAt, null);
    assert.equal(p!.tradeCount, 1);
    assert.equal(p!.avgHoldSec, null, "no round trip, no average");
    assert.deepEqual(p!.topTrades, [], "no closed trade is an empty list…");
    assert.equal(p!.topTradesRead, true, "…that was read");
    for (const bad of [0, -5, Number.NaN, "yesterday", 1e13]) {
      const q = await profileOf(db, { slug: "shogun", accounts: [ACCOUNT], createdAt: bad }, false);
      assert.equal(q!.joinedAt, null, `createdAt ${String(bad)}`);
    }
  } finally { raw.close(); }
});

test("a paper agent's stats are its paper book's, and a live agent's are not its practice", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1 });
    await fill(db, { side: "sell", coin: "CASH", qty: "1", at: T0 + 61, pnl: 1, cash: 11 });
    await db.prepare(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, status, created_at, epoch, fill_side, fill_symbol, fill_qty_raw, fill_cash_usdg, realized_pnl_usdg, basis_source)
       VALUES (?, 'swap', 'x', 5, 'paper', ?, 2, 'buy', 'TSLA', '2', 5, NULL, 'paper'), (?, 'swap', 'x', 5, 'paper', ?, 2, 'sell', 'TSLA', '2', 6, 1, 'paper'),
              (?, 'swap', 'x', 5, 'paper', ?, 2, 'buy', 'TSLA', '3', 5, NULL, 'paper')`,
    ).run(ACCOUNT, T0 + 100, ACCOUNT, T0 + 400, ACCOUNT, T0 + 500);
    const live = (await profileOf(db, identity, false))!;
    assert.deepEqual([live.tradeCount, live.avgHoldSec, live.topTrades.map((t) => t.symbol)], [2, 60, ["CASH"]]);
    await db.prepare("UPDATE agents SET mode = 'paper'").run();
    const paper = (await profileOf(db, identity, false))!;
    assert.deepEqual([paper.tradeCount, paper.avgHoldSec, paper.topTrades.map((t) => t.symbol)], [3, 300, ["TSLA"]]);
  } finally { raw.close(); }
});

test("a trade count from a capped read is a floor, and no hold is computed from a partial tape", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    raw.exec("BEGIN");
    const ins = raw.prepare(
      `INSERT INTO trades (agent_id, kind, target, amount_usdg, user_op_hash, status, created_at, epoch, fill_side, fill_symbol, fill_qty_raw, basis_source)
       VALUES (?, 'swap', 'x', 5, ?, 'landed', ?, 2, ?, 'CASH', '1', 'receipt')`,
    );
    for (let i = 0; i < 5_001; i++) ins.run(ACCOUNT, `0xbulk${i}`, T0 + i, i % 2 === 0 ? "buy" : "sell");
    raw.exec("COMMIT");
    const p = (await profileOf(db, identity, false))!;
    assert.equal(p.tradeCount, 5_000);
    assert.equal(p.tradeCountFloor, true);
    assert.equal(p.avgHoldSec, null);
  } finally { raw.close(); }
});

test("a public book shows the best trade's dollars; a private one does not", async () => {
  const { raw, db } = await ledger();
  try {
    await mark(db, T0, 100);
    await fill(db, { side: "buy", coin: "CASH", qty: "1", at: T0 + 1 });
    await fill(db, { side: "sell", coin: "CASH", qty: "1", at: T0 + 2, pnl: 3, cash: 13 });
    assert.equal((await profileOf(db, identity, false))!.topTrades[0]!.realizedPnlUsdg, null);
    assert.equal((await profileOf(db, identity, true))!.topTrades[0]!.realizedPnlUsdg, 3);
  } finally { raw.close(); }
});
