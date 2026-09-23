/**
 * PRE-REDEPLOY TRADES, SEEN THROUGH THE SAME QUERIES AS TODAY'S.
 *
 * A hosted agent's ledger starts empty after every redeploy; the orchestrator
 * leaves the trades and decisions from before it in `trade-history.json`
 * (history-files.ts). This lays that file over the ledger for ONE read-only
 * connection: TEMP views named `trades` and `decisions` that are the ledger's
 * own rows plus the carried ones. SQLite resolves an unqualified name to the
 * temp schema first, so every existing lookup — /trades, list_trades, the P&L
 * breakdown's closed trades, decisions, find_token, the coin-name resolver —
 * sees the whole tape without a line of its SQL changing, and the ledger file
 * itself stays untouched (the connection is read-only; temp objects live in
 * memory and die with it).
 *
 * Only the chat's own connections get the overlay. The notifier, the budgets,
 * the cost basis and everything that trades open the ledger on their own and
 * never see a carried row.
 *
 * ONE ROW PER OPERATION across the two. See planHistoryMerge.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { merrymenHome } from "../home";
import { readHistory, type HistoryDecision, type HistoryTrade, type TradeHistory } from "../history-files";
import { isRestartCopy } from "../token-label";

/** What the ledger already holds, as far as the merge needs to know. */
export interface LocalOps {
  /** Lowercased op hash → true when at least one row for it is the executor's own (not a restart copy). */
  ops: Map<string, boolean>;
  /** The ledger's earliest trade row for this agent (unix seconds), or null when it has none. */
  firstAt: number | null;
}

export interface MergePlan {
  /** Carried rows to show. */
  trades: HistoryTrade[];
  /** Op hashes whose LOCAL restart copies the carried row replaces. */
  supersede: string[];
}

/**
 * Which carried trades to show beside the ledger's, and which of the ledger's
 * rows they replace. Pure.
 *
 *  - THE LEDGER'S OWN ROW WINS. An op the ledger holds from its executor is
 *    shown from the ledger, never twice.
 *  - EXCEPT A RESTART COPY. After a redeploy the reconciler re-writes recent
 *    ops as bare copies — no coin, no decision, stamped at the restart. When
 *    the carried row for that op is the real one, it replaces the copy, which
 *    is how "8 nameless rows at 01:07:59" become the eight trades they were.
 *  - A ROW WITH NO HASH (a refusal, a practice fill) can't be matched, so it is
 *    carried only when it is older than everything the ledger holds. Newer
 *    ones are this ledger's own rows already mirrored up — a child restarted
 *    without a redeploy keeps its ledger, and the file then overlaps it.
 */
export function planHistoryMerge(trades: readonly HistoryTrade[], agentId: string, local: LocalOps): MergePlan {
  const out: HistoryTrade[] = [];
  const supersede = new Set<string>();
  const seen = new Set<string>();
  for (const t of trades) {
    const hash = t.user_op_hash?.trim().toLowerCase() || null;
    if (!hash) {
      if (local.firstAt === null || t.created_at < local.firstAt) out.push(t);
      continue;
    }
    if (seen.has(hash)) continue; // the file is untrusted: one row per op, even if it repeats one
    seen.add(hash);
    const localReal = local.ops.get(hash);
    if (localReal === true) continue;
    const copy = isRestartCopy({ ...t, agent_id: agentId });
    if (localReal === false) {
      // The ledger has only copies of this op. A carried copy adds nothing.
      if (copy) continue;
      supersede.add(hash);
    }
    out.push(t);
  }
  return { trades: out, supersede: [...supersede] };
}

/** A restart copy, in SQL, over alias `l` — isRestartCopy (token-label.ts). */
const COPY_SQL = `(l.kind = 'swap' AND l.target IS NOT NULL AND lower(l.target) = lower(l.agent_id) AND l.decision_id IS NULL AND l.fill_side IS NULL)`;

const TEMP_OBJECTS = [
  "DROP VIEW IF EXISTS temp.trades",
  "DROP VIEW IF EXISTS temp.decisions",
  "DROP TABLE IF EXISTS temp.hist_trades",
  "DROP TABLE IF EXISTS temp.hist_supersede",
  "DROP TABLE IF EXISTS temp.hist_decisions",
];

const q = (c: string) => `"${c.replace(/"/g, '""')}"`;

function columns(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA main.table_info(${table})`).all() as { name: string }[]).map((r) => r.name);
}

function readLocal(db: DatabaseSync, agentId: string): LocalOps {
  const ops = new Map<string, boolean>();
  const rows = db
    .prepare(
      `SELECT lower(l.user_op_hash) AS h, MAX(CASE WHEN ${COPY_SQL} THEN 0 ELSE 1 END) AS real
         FROM main.trades l WHERE l.agent_id = ? AND l.user_op_hash IS NOT NULL AND l.user_op_hash <> ''
        GROUP BY lower(l.user_op_hash)`,
    )
    .all(agentId) as { h: string; real: number }[];
  for (const r of rows) ops.set(r.h, r.real === 1);
  const first = db.prepare("SELECT MIN(created_at) AS t FROM main.trades WHERE agent_id = ?").get(agentId) as { t: number | null } | undefined;
  return { ops, firstAt: typeof first?.t === "number" ? first.t : null };
}

/** Load `rows` into a temp table and return the view half that reads it in the ledger table's own shape. */
function carry<T extends object>(db: DatabaseSync, table: string, want: readonly string[], rows: readonly T[], extra: (r: T, i: number) => Record<string, SQLInputValue>): string {
  const cols = [...new Set([...Object.keys(extra(rows[0] ?? ({} as T), 0)), ...Object.keys(rows[0] ?? {})])];
  db.exec(`CREATE TEMP TABLE ${table} (${cols.map(q).join(", ")})`);
  const ins = db.prepare(`INSERT INTO temp.${table} (${cols.map(q).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
  rows.forEach((r, i) => {
    const v = { ...(r as Record<string, unknown>), ...extra(r, i) };
    ins.run(...cols.map((c) => (v[c] ?? null) as SQLInputValue));
  });
  return want.map((c) => (cols.includes(c) ? `h.${q(c)}` : `NULL AS ${q(c)}`)).join(", ");
}

/**
 * Lay the history file over `db` for `agentId`. Returns true when carried rows
 * are now visible. NEVER THROWS, and on any failure leaves the connection
 * exactly as it was — the plain ledger — rather than half an overlay.
 *
 * `history` is for tests; by default the file in this agent's home is read.
 */
export function overlayHistory(db: DatabaseSync, agentId: string, history?: TradeHistory | null): boolean {
  const file = history === undefined ? readHistory(merrymenHome(), agentId) : history;
  if (!file || (!file.trades.length && !file.decisions.length)) return false;
  try {
    const tradeCols = columns(db, "trades");
    if (!tradeCols.length) return false;
    const plan = planHistoryMerge(file.trades, agentId, readLocal(db, agentId));
    let any = false;
    if (plan.trades.length) {
      // Negative ids: never equal to a ledger id, so `t.id = (SELECT MAX(id) …)`
      // joins still find exactly one row, and the ledger's own sorts first on a tie.
      const fromHist = carry(db, "hist_trades", tradeCols, plan.trades, (_r, i) => ({ id: -(i + 1), agent_id: agentId }));
      db.exec("CREATE TEMP TABLE hist_supersede (h TEXT PRIMARY KEY)");
      const sup = db.prepare("INSERT OR IGNORE INTO temp.hist_supersede (h) VALUES (?)");
      for (const h of plan.supersede) sup.run(h);
      db.exec(
        `CREATE TEMP VIEW trades AS
           SELECT ${tradeCols.map((c) => `l.${q(c)}`).join(", ")} FROM main.trades l
            WHERE NOT (${COPY_SQL} AND l.user_op_hash IS NOT NULL AND lower(l.user_op_hash) IN (SELECT h FROM temp.hist_supersede))
           UNION ALL
           SELECT ${fromHist} FROM temp.hist_trades h`,
      );
      any = true;
    }
    const decisionCols = file.decisions.length ? columns(db, "decisions") : [];
    if (decisionCols.length) {
      const fromHist = carry<HistoryDecision>(db, "hist_decisions", decisionCols, file.decisions, () => ({ agent_id: agentId }));
      db.exec(
        `CREATE TEMP VIEW decisions AS
           SELECT ${decisionCols.map((c) => `d.${q(c)}`).join(", ")} FROM main.decisions d
           UNION ALL
           SELECT ${fromHist} FROM temp.hist_decisions h WHERE NOT EXISTS (SELECT 1 FROM main.decisions x WHERE x.id = h.id)`,
      );
      any = true;
    }
    return any;
  } catch {
    for (const s of TEMP_OBJECTS) {
      try {
        db.exec(s);
      } catch {
        /* already gone */
      }
    }
    return false;
  }
}
