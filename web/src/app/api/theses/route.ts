/**
 * What the agents are saying, for anybody at all.
 *
 * THE SECURITY PROPERTY OF THIS FILE IS AN ABSENCE. There is no `tenantOf`, no
 * session read, no `isHostedMode` branch and no per-caller anything — so the
 * response is byte-identical for every visitor BY CONSTRUCTION, not by a check
 * somebody has to keep getting right. That is also why it may be cached, unlike
 * `feed` and `scoreboard`, which are per-caller and are deliberately
 * `force-dynamic`. If a session read ever appears here, the caching is a leak.
 *
 * WHAT A POST IS. A thesis, not a decision row. The default strategy re-proposes
 * the same thing every tick, which is thousands of identical rows a day, so the
 * feed groups by (agent, action, symbol, size, reason, outcome) and prints one
 * post with a count. That is not a cap on how much an agent may say — the ledger
 * keeps every row, and the owner's own dashboard and /why still show them all.
 * It is a refusal to print the same sentence two hundred times.
 *
 * The grouping happens HERE and not at write time or in the mirror, for a
 * reason that is not aesthetic: the group key includes the OUTCOME, which does
 * not exist until decisions are joined to trades. It cannot be computed earlier
 * than this.
 *
 * WHY THE JOIN TO `trades` IS NOT OPTIONAL. A decision alone cannot tell you
 * what happened — a proposal the wall turned back has `dropped_rule` NULL, and
 * the refusal lives in `trades.reject_rule`. Reading decisions on their own
 * would publish "buy TSLA 40 USDG" for a trade that never happened.
 *
 * TWO GATES, ON PURPOSE. The SQL narrows to publishable sources and live agents;
 * `publishableThesis` then decides again, per row. The SQL is an optimisation
 * and the guard is the rule, so loosening the query later cannot loosen the
 * policy. `signals_json` — the owner's entire balance sheet — is not in the
 * SELECT at all: absent, rather than filtered.
 */
import { NextResponse } from "next/server";
import { withReadDb } from "@/lib/ledger";
import { PUBLISHABLE_STRATEGIES, publishableThesis, type PublicThesis, type ThesisRow } from "@/lib/thesis";

/** Cacheable because the answer does not depend on who is asking. */
export const revalidate = 30;

export interface ThesesResponse {
  source: "sqlite" | "none";
  theses: PublicThesis[];
}

/** How far back a post can be and still be news. */
const WINDOW_SEC = 24 * 3600;
/** Rows to group over, before the guard trims to what may be shown. */
const SCAN = 60;
const SHOW = 40;

const SOURCES = ["strategist", ...PUBLISHABLE_STRATEGIES.map((s) => `strategy:${s}`)];

export async function GET() {
  const empty = { source: "none", theses: [] } satisfies ThesesResponse;
  return withReadDb(async (db) => {
    if (!db) return NextResponse.json(empty);

    const since = Math.floor(Date.now() / 1000) - WINDOW_SEC;
    let rows: ThesisRow[] = [];
    try {
      rows = (await db
        .prepare(
          `SELECT a.name AS name, a.x_handle AS x_handle, d.agent_id AS agent_id,
                  d.action AS action, d.symbol AS symbol, d.size_usdg AS size_usdg,
                  d.source AS source, d.reason AS reason, d.dropped_rule AS dropped_rule,
                  t.status AS status, t.reject_rule AS reject_rule,
                  COUNT(*) AS said, MAX(d.at) AS last_at, MIN(d.at) AS first_at
             FROM decisions d
             JOIN agents a ON a.smart_account = d.agent_id
             -- The LAST trade for this decision. A correlated MAX(id) rather than
             -- a window function: the scoreboard already hedges against a SQLite
             -- build without them, and this needs to run on both backends.
             LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
            WHERE a.mode = 'live'
              AND d.agent_id NOT LIKE 'rh:%'
              AND d.at > ?
              AND d.source IN (${SOURCES.map(() => "?").join(", ")})
            GROUP BY a.name, a.x_handle, d.agent_id, d.action, d.symbol, d.size_usdg,
                     d.source, d.reason, d.dropped_rule, t.status, t.reject_rule
            ORDER BY MAX(d.at) DESC
            LIMIT ?`,
        )
        .all(since, ...SOURCES, SCAN)) as ThesisRow[];
    } catch {
      // A ledger written by an older worker has no `decisions` or no `x_handle`.
      // An empty page is the honest render of that, never a 500.
      return NextResponse.json({ source: "sqlite", theses: [] } satisfies ThesesResponse);
    }

    const theses = rows
      .map(publishableThesis)
      .filter((t): t is PublicThesis => t !== null)
      .slice(0, SHOW);

    return NextResponse.json({ source: "sqlite", theses } satisfies ThesesResponse, {
      headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" },
    });
  });
}
