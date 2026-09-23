/**
 * THE TRADES A HOSTED AGENT MADE BEFORE ITS LAST REDEPLOY, IN ITS OWN HOME.
 *
 * A hosted child's ledger is a sqlite file in a home with no volume, so every
 * redeploy starts it from nothing. At the next arm the in-flight reconciler
 * writes back only the last few hours of operations, and writes each one as a
 * bare copy — no coin, no decision, stamped at the restart. So an owner asking
 * the Telegram merryman "what did you buy yesterday" got "no trades" or eight
 * nameless rows at one second, while the real tape sat untouched in the shared
 * Postgres the dashboard reads.
 *
 * The child cannot read that database: `DATABASE_URL` is stripped from its
 * environment on purpose (the process boundary is what keeps one tenant out of
 * another's rows). So the orchestrator reads THIS tenant's rows and writes them
 * into the child's home before spawn — the same wire research-files.ts and the
 * cost-basis seed already use — and the chat reads the file.
 *
 * WHAT IT IS FOR, AND WHAT IT MUST NEVER BE. It is for ANSWERS: /trades and the
 * chat's lookups (telegram/history-overlay.ts). Nothing that sizes, caps,
 * books or accounts reads it — the daily cap, the cost basis and the P&L the
 * breaker trips on keep coming from the child's own ledger, exactly as before.
 * A file in a tenant-writable home is good enough to tell an owner what
 * happened; it is not good enough to decide what may happen next.
 *
 * Trades and decisions only. Account-value marks and deposits are deliberately
 * NOT carried: after a wipe the child can book its opening balance again as a
 * flow at the restart, and a pre-redeploy mark set against a post-redeploy flow
 * reads as a phantom trading loss of the whole balance.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getAddress } from "viem";

import type { Db } from "./db";

export const HISTORY_FILE = "trade-history.json";
const SCHEMA = 1;

/** How far back the file reaches. */
export const HISTORY_DAYS = 30;
/** Newest operations that went out (fills, paper fills, failures). */
export const HISTORY_OPS_MAX = 400;
/** Newest refusals — kept apart so a day of refusals cannot push every fill out. */
export const HISTORY_REFUSALS_MAX = 100;
/** Newest decisions, beside every decision one of the carried trades links to. */
export const HISTORY_DECISIONS_MAX = 300;
/** A decision's reason is the model's own words; bounded so the file stays small. */
const REASON_MAX = 600;
/**
 * How much younger than its operation a re-recorded copy can be — the window
 * web/src/lib/distinct-trades.ts collapses copies over (OP_COPY_REACH_SEC). The
 * scope reaches back this much further than the file does, so a copy inside
 * the window never stands alone for want of its original just outside it.
 */
const OP_COPY_REACH_SEC = 7 * 86_400;

export interface HistoryTrade {
  kind: string;
  target: string | null;
  sell_token: string | null;
  buy_token: string | null;
  amount_usdg: number;
  user_op_hash: string | null;
  tx_hash: string | null;
  status: string;
  reject_rule: string | null;
  decision_id: string | null;
  fill_side: string | null;
  /** The coin's own symbol() read off the receipt — Postgres only, and chosen by whoever launched the coin. */
  fill_symbol: string | null;
  fill_qty_raw: string | null;
  fill_price_usd: number | null;
  realized_pnl_usdg: number | null;
  fill_cash_usdg: number | null;
  gas_usdg: number | null;
  gas_wei: string | null;
  epoch: number | null;
  created_at: number;
}

export interface HistoryDecision {
  id: string;
  source: string;
  strategy: string | null;
  symbol: string | null;
  action: string | null;
  size_usdg: number | null;
  reason: string | null;
  dropped_rule: string | null;
  provenance: string | null;
  display_name: string | null;
  at: number;
}

export interface TradeHistory {
  schema: typeof SCHEMA;
  /** The smart account every row is on. The reader refuses a file for anyone else. */
  agentId: string;
  /** Unix seconds the orchestrator wrote this. */
  writtenAt: number;
  /** Unix seconds the file reaches back to. */
  since: number;
  trades: HistoryTrade[];
  decisions: HistoryDecision[];
}

export function historyFilePath(home: string): string {
  return path.join(home, HISTORY_FILE);
}

/** Write a child's history. Orchestrator only. Temp-then-rename, mode 0600, as research-files.ts. */
export function writeHistoryFile(home: string, file: TradeHistory): void {
  mkdirSync(home, { recursive: true });
  const tmp = path.join(home, "." + HISTORY_FILE + ".tmp");
  writeFileSync(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, historyFilePath(home));
}

/**
 * Read a child's history for `agentId`. NEVER THROWS: absent, unreadable,
 * malformed or somebody else's all mean "no history", which is what a
 * self-hosted agent (whose ledger is never wiped) always sees.
 *
 * Every row is re-validated — the file sits in a tenant-writable home.
 */
export function readHistory(home: string, agentId: string): TradeHistory | null {
  try {
    const raw = JSON.parse(readFileSync(historyFilePath(home), "utf8")) as Partial<TradeHistory> | null;
    if (!raw || typeof raw !== "object" || raw.schema !== SCHEMA) return null;
    if (typeof raw.agentId !== "string" || raw.agentId.toLowerCase() !== agentId.toLowerCase()) return null;
    return {
      schema: SCHEMA,
      agentId: raw.agentId,
      writtenAt: num(raw.writtenAt) ?? 0,
      since: num(raw.since) ?? 0,
      trades: (Array.isArray(raw.trades) ? raw.trades : []).map(asTrade).filter((t): t is HistoryTrade => t !== null),
      decisions: (Array.isArray(raw.decisions) ? raw.decisions : []).map(asDecision).filter((d): d is HistoryDecision => d !== null),
    };
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────── reading Postgres ──

const TRADE_COLS = [
  "kind",
  "target",
  "sell_token",
  "buy_token",
  "amount_usdg",
  "user_op_hash",
  "tx_hash",
  "status",
  "reject_rule",
  "decision_id",
  "fill_side",
  "fill_symbol",
  "fill_qty_raw",
  "fill_price_usd",
  "realized_pnl_usdg",
  "fill_cash_usdg",
  "gas_usdg",
  "gas_wei",
  "epoch",
  "created_at",
] as const;

const DECISION_COLS = "id, source, strategy, symbol, action, size_usdg, reason, dropped_rule, provenance, display_name, at";

/**
 * Every spelling the ledger writes this account under: as given, lowercase and
 * checksummed — each an index seek, the way ledger-mirror.ts asks. `lower()`
 * on the column would scan the whole fleet's tape.
 */
function spellings(agentId: string): [string, string, string] {
  const lower = agentId.toLowerCase();
  let sum = lower;
  try {
    sum = getAddress(lower);
  } catch {
    /* not an address: the other two spellings still apply */
  }
  return [agentId, lower, sum];
}

/**
 * This account's recent trades and decisions from the shared ledger, ONE ROW
 * PER OPERATION. The shared tape can hold an operation more than once — the
 * executor's row and the reconciler's bare copies from earlier redeploys — so
 * the copies are collapsed with the ranking distinct-trades.ts uses: the row
 * that knows the outcome, then the one with fill evidence, then the one linked
 * to its decision, then the earliest. SQL both backends run.
 */
export async function loadHistoryFromShared(shared: Db, agentId: string, nowSec: number): Promise<TradeHistory> {
  const since = nowSec - HISTORY_DAYS * 86_400;
  const who = spellings(agentId);
  const cols = TRADE_COLS.join(", ");
  const ops = (await shared
    .prepare(
      `WITH scoped AS (SELECT id, ${cols} FROM trades WHERE agent_id IN (?, ?, ?) AND created_at >= ?)
       SELECT * FROM (
         SELECT s.*, ROW_NUMBER() OVER (
           PARTITION BY lower(s.user_op_hash)
           ORDER BY (s.status = 'submitted'), (s.fill_side IS NULL), (s.decision_id IS NULL), s.created_at, s.id
         ) AS op_rank
         FROM scoped s WHERE s.user_op_hash IS NOT NULL AND s.user_op_hash <> ''
       ) ranked WHERE ranked.op_rank = 1 AND ranked.status <> 'rejected' AND ranked.created_at >= ?
       UNION ALL
       SELECT s.*, 1 AS op_rank FROM scoped s
        WHERE (s.user_op_hash IS NULL OR s.user_op_hash = '') AND s.status <> 'rejected' AND s.created_at >= ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(...who, since - OP_COPY_REACH_SEC, since, since, HISTORY_OPS_MAX)) as unknown as Record<string, unknown>[];
  const refusals = (await shared
    .prepare(
      `SELECT id, ${cols} FROM trades WHERE agent_id IN (?, ?, ?) AND created_at >= ? AND status = 'rejected'
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...who, since, HISTORY_REFUSALS_MAX)) as unknown as Record<string, unknown>[];
  const trades = [...ops, ...refusals].map(asTrade).filter((t): t is HistoryTrade => t !== null);
  trades.sort((a, b) => b.created_at - a.created_at);

  // Every decision a carried trade links to (its reason is the answer to "why
  // did you buy X"), then the newest others, one row per id.
  const decisions = new Map<string, HistoryDecision>();
  const linked = [...new Set(trades.map((t) => t.decision_id).filter((d): d is string => !!d))];
  for (let i = 0; i < linked.length; i += 100) {
    const chunk = linked.slice(i, i + 100);
    const rows = (await shared
      .prepare(`SELECT ${DECISION_COLS} FROM decisions WHERE agent_id IN (?, ?, ?) AND id IN (${chunk.map(() => "?").join(", ")})`)
      .all(...who, ...chunk)) as unknown as Record<string, unknown>[];
    for (const r of rows) {
      const d = asDecision(r);
      if (d) decisions.set(d.id, d);
    }
  }
  const recent = (await shared
    .prepare(
      `SELECT ${DECISION_COLS} FROM decisions
        WHERE agent_id IN (?, ?, ?) AND at >= ? AND source <> 'market-review-private'
        ORDER BY at DESC LIMIT ?`,
    )
    .all(...who, since, HISTORY_DECISIONS_MAX)) as unknown as Record<string, unknown>[];
  for (const r of recent) {
    const d = asDecision(r);
    if (d && !decisions.has(d.id)) decisions.set(d.id, d);
  }
  return {
    schema: SCHEMA,
    agentId,
    writtenAt: nowSec,
    since,
    trades,
    decisions: [...decisions.values()].sort((a, b) => b.at - a.at),
  };
}

// ─────────────────────────────────────────────────────────── validation ──

/** A number from Postgres (BIGINT can arrive as a string) or JSON, else null. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function text(v: unknown, max = 200): string | null {
  if (typeof v === "string") return v === "" ? null : v.slice(0, max);
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return null;
}

function asTrade(v: unknown): HistoryTrade | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const kind = text(r.kind, 40);
  const status = text(r.status, 40);
  const created = num(r.created_at);
  if (!kind || !status || created === null) return null;
  return {
    kind,
    target: text(r.target, 80),
    sell_token: text(r.sell_token, 80),
    buy_token: text(r.buy_token, 80),
    amount_usdg: num(r.amount_usdg) ?? 0,
    user_op_hash: text(r.user_op_hash, 80),
    tx_hash: text(r.tx_hash, 80),
    status,
    reject_rule: text(r.reject_rule, 120),
    decision_id: text(r.decision_id, 120),
    fill_side: text(r.fill_side, 8),
    fill_symbol: text(r.fill_symbol, 40),
    fill_qty_raw: text(r.fill_qty_raw, 80),
    fill_price_usd: num(r.fill_price_usd),
    realized_pnl_usdg: num(r.realized_pnl_usdg),
    fill_cash_usdg: num(r.fill_cash_usdg),
    gas_usdg: num(r.gas_usdg),
    gas_wei: text(r.gas_wei, 80),
    epoch: num(r.epoch),
    created_at: created,
  };
}

function asDecision(v: unknown): HistoryDecision | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const id = text(r.id, 120);
  const source = text(r.source, 80);
  const at = num(r.at);
  if (!id || !source || at === null) return null;
  return {
    id,
    source,
    strategy: text(r.strategy, 80),
    symbol: text(r.symbol, 40),
    action: text(r.action, 40),
    size_usdg: num(r.size_usdg),
    reason: text(r.reason, REASON_MAX),
    dropped_rule: text(r.dropped_rule, 120),
    provenance: text(r.provenance, 80),
    display_name: text(r.display_name, 80),
    at,
  };
}
