/**
 * The orchestrator's read of one tenant's history out of the shared ledger,
 * and the merge rule the chat applies to it.
 *
 * The loader runs on a sqlite ledger with the shared schema, holding what the
 * shared tape really holds after a few redeploys: an operation's evidenced
 * original beside bare restart copies of it (hash lowercased, account in
 * another spelling), refusals, another tenant's rows, and rows too old to
 * carry. The SQL is written once for both backends.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { getAddress } from "viem";

import { wrapSqlite } from "./db";
import { HISTORY_REFUSALS_MAX, loadHistoryFromShared, readHistory, writeHistoryFile, type HistoryTrade } from "./history-files";
import { applyLedgerSchema } from "./store";
import { planHistoryMerge } from "./telegram/history-overlay";

const A = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const OTHER = "0x0000000000000000000000000000000000000b0b";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const COIN = "0x7a11ce0000000000000000000000000000000001";
const NOW = 1_800_000_000;
const DAY = 86_400;
const H1 = "0xAAAA000000000000000000000000000000000000000000000000000000000001";

async function ledger() {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  await applyLedgerSchema(db);
  const t = (agent: string, p: Record<string, unknown>) => {
    const row = { kind: "swap", target: agent, amount_usdg: 5, status: "landed", ...p, agent_id: agent };
    const cols = Object.keys(row);
    raw.prepare(`INSERT INTO trades (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
  };
  return { raw, db, t };
}

describe("loadHistoryFromShared", () => {
  it("one row per operation — the evidenced original, never the restart copies beside it", async () => {
    const { raw, db, t } = await ledger();
    // The executor's row, then two restart copies from later redeploys.
    t(A, { target: "0xvault", sell_token: USDG, buy_token: COIN, user_op_hash: H1, tx_hash: "0xt1", fill_side: "buy", decision_id: "d1", fill_symbol: "MUSE", created_at: NOW - 2 * DAY });
    t(A, { user_op_hash: H1.toLowerCase(), tx_hash: "0xt1", created_at: NOW - DAY });
    t(getAddress(A), { target: getAddress(A), user_op_hash: H1.toLowerCase(), tx_hash: "0xt1", created_at: NOW - 3600 });
    // A copy whose original is older than the window: still collapsed into it, and then left out with it.
    t(A, { target: "0xvault", sell_token: USDG, buy_token: COIN, user_op_hash: "0xold", fill_side: "buy", created_at: NOW - 31 * DAY });
    t(A, { user_op_hash: "0xOLD", created_at: NOW - 29 * DAY });
    // A practice fill, a refusal, and rows that must never come along.
    t(A, { status: "paper", sell_token: USDG, buy_token: COIN, fill_side: "buy", created_at: NOW - 3 * DAY });
    t(A, { status: "rejected", reject_rule: "DAILY_CAP", created_at: NOW - 100 });
    t(A, { status: "landed", user_op_hash: "0xancient", created_at: NOW - 40 * DAY });
    t(OTHER, { status: "landed", user_op_hash: "0xother", created_at: NOW - 10 });
    raw.prepare("INSERT INTO decisions (id, agent_id, source, symbol, action, reason, at) VALUES ('d1', ?, 'brain', 'MUSE', 'buy', 'why', ?)").run(A, NOW - 40 * DAY);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, at) VALUES ('d2', ?, 'market-review-private', 'hold', ?)").run(A, NOW - 10);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, reason, at) VALUES ('d3', ?, 'brain', 'hold', ?, ?)").run(A, "x".repeat(5000), NOW - 20);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, at) VALUES ('d4', ?, 'brain', 'buy', ?)").run(OTHER, NOW - 5);
    raw.prepare("INSERT INTO decisions (id, agent_id, source, action, hold_kind, at) VALUES ('d5', ?, 'brain', 'hold', 'GATE_FORCED_HOLD', ?)").run(A, NOW - 30);

    const h = await loadHistoryFromShared(db, getAddress(A), NOW);
    const ops = h.trades.filter((r) => r.user_op_hash?.toLowerCase() === H1.toLowerCase());
    assert.equal(ops.length, 1, "three rows of one op are one op");
    assert.equal(ops[0]!.fill_side, "buy", "and it is the executor's evidenced row");
    assert.equal(ops[0]!.fill_symbol, "MUSE");
    assert.equal(h.trades.filter((r) => r.user_op_hash?.toLowerCase() === "0xold").length, 0, "a copy never stands alone for want of its original");
    assert.ok(h.trades.some((r) => r.status === "paper"));
    assert.ok(h.trades.some((r) => r.status === "rejected" && r.reject_rule === "DAILY_CAP"));
    assert.ok(!h.trades.some((r) => r.user_op_hash === "0xancient"), "older than the window");
    assert.ok(!h.trades.some((r) => r.user_op_hash === "0xother"), "another tenant's row");
    assert.deepEqual(
      h.trades.map((r) => r.created_at),
      [...h.trades.map((r) => r.created_at)].sort((a, b) => b - a),
      "newest first",
    );
    const ids = h.decisions.map((d) => d.id).sort();
    assert.deepEqual(ids, ["d1", "d3"], "the linked decision even when old, the recent one — never the private review, a forced hold, or another tenant's");
    assert.equal(h.decisions.find((d) => d.id === "d3")!.reason!.length, 600, "a reason is bounded");
    assert.equal(typeof h.trades[0]!.created_at, "number");
    raw.close();
  });

  it("a day of refusals cannot push the fills out", async () => {
    const { raw, db, t } = await ledger();
    t(A, { sell_token: USDG, buy_token: COIN, user_op_hash: "0xfill", fill_side: "buy", created_at: NOW - 5 * DAY });
    for (let i = 0; i < HISTORY_REFUSALS_MAX + 50; i++) t(A, { status: "rejected", reject_rule: "WALL", created_at: NOW - i });
    const h = await loadHistoryFromShared(db, A, NOW);
    assert.ok(h.trades.some((r) => r.user_op_hash === "0xfill"));
    assert.equal(h.trades.filter((r) => r.status === "rejected").length, HISTORY_REFUSALS_MAX);
    raw.close();
  });

  it("the file round-trips, and is only ever read for the agent it was written for", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "merrymen-histfile-"));
    try {
      const { raw, db, t } = await ledger();
      t(A, { sell_token: USDG, buy_token: COIN, user_op_hash: "0xf", fill_side: "buy", created_at: NOW - DAY });
      const h = await loadHistoryFromShared(db, A, NOW);
      raw.close();
      writeHistoryFile(home, h);
      assert.equal(readHistory(home, getAddress(A))?.trades.length, 1);
      assert.equal(readHistory(home, OTHER), null);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function row(p: Partial<HistoryTrade> & Pick<HistoryTrade, "created_at">): HistoryTrade {
  return {
    kind: "swap", target: "0xvault", sell_token: USDG, buy_token: COIN, amount_usdg: 5, user_op_hash: null, tx_hash: null,
    status: "landed", reject_rule: null, decision_id: null, fill_side: "buy", fill_symbol: null, fill_qty_raw: null,
    fill_price_usd: null, realized_pnl_usdg: null, fill_cash_usdg: 5, gas_usdg: null, gas_wei: null, epoch: 1, ...p,
  };
}

describe("planHistoryMerge", () => {
  const copy = (p: Partial<HistoryTrade> & Pick<HistoryTrade, "created_at">) =>
    row({ target: A, sell_token: null, buy_token: null, fill_side: null, ...p });

  it("the ledger's own row wins; a carried original replaces only a restart copy", () => {
    const local = { ops: new Map([["0x1", true], ["0x2", false], ["0x3", false]]), firstAt: NOW - 3600 };
    const plan = planHistoryMerge(
      [
        row({ user_op_hash: "0x1", created_at: NOW - DAY }), // ledger has the executor's row
        row({ user_op_hash: "0X2", created_at: NOW - DAY }), // ledger has only a copy → replace it
        copy({ user_op_hash: "0x3", created_at: NOW - DAY }), // both copies → keep the ledger's
        row({ user_op_hash: "0x4", created_at: NOW - DAY }), // ledger has nothing → carry
        row({ user_op_hash: "0x4", created_at: NOW - DAY }), // the file repeats itself → once
      ],
      A,
      local,
    );
    assert.deepEqual(plan.trades.map((t) => t.user_op_hash), ["0X2", "0x4"]);
    assert.deepEqual(plan.supersede, ["0x2"]);
  });

  it("a row with no hash is carried only when it is older than everything on the ledger", () => {
    const plan = planHistoryMerge(
      [row({ status: "paper", created_at: NOW - 7200 }), row({ status: "rejected", created_at: NOW - 60 })],
      A,
      { ops: new Map(), firstAt: NOW - 3600 },
    );
    assert.deepEqual(plan.trades.map((t) => t.status), ["paper"]);
    const empty = planHistoryMerge([row({ status: "rejected", created_at: NOW - 60 })], A, { ops: new Map(), firstAt: null });
    assert.equal(empty.trades.length, 1, "an empty ledger holds nothing to overlap");
  });
});
