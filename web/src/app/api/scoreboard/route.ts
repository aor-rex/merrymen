/**
 * The honest scoreboard — every agent that ever ran, its full P&L history,
 * drawdown, fee accruals, and trade record, straight from the worker's SQLite.
 * Transparency is the trust product: rejected and reverted trades are shown
 * with the same weight as landed ones.
 */

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NextResponse } from "next/server";
import { homePaths } from "@merrymen/home";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";

export const dynamic = "force-dynamic";

const DB_FILE = homePaths.db();

export interface ScoreboardEquityPoint {
  equity_usdg: number;
  at: string;
}

export interface ScoreboardAgent {
  smart_account: string;
  name: string;
  status: string;
  chain_id: number;
  caps: Record<string, number>;
  granted_at: number;
  expires_at: number;
  hwm_usdg: number;
  accrued_fee_usdg: number;
  equity: ScoreboardEquityPoint[];
  /** Equity − contributions − gas. Null when contributions are unknown. */
  pnl_usdg: number | null;
  /** Gas charged against that figure, and fills whose gas could not be priced. */
  gas_usdg: number;
  gas_unpriced_trades: number;
  /**
   * Deepest peak-to-trough in this epoch. NULL when there is no equity history
   * to measure — an epoch with no rows has no drawdown, and publishing 0.00%
   * would read as a flawless run rather than as an empty one.
   */
  max_drawdown_bps: number | null;
  trades: { landed: number; rejected: number; reverted: number; volume_usdg: number };
}

export interface ScoreboardResponse {
  source: "sqlite" | "none";
  agents: ScoreboardAgent[];
}

export async function GET(req: Request) {
  // Self-hosted, this board is a transparency product: EVERY agent, publicly.
  // Hosted, that same query is a customer-list dump — every tenant's smart
  // account, caps, equity curve, P&L and fees. So hosted scopes to the caller's
  // OWN agents (owner_address = the SIWE tenant); no session → nothing.
  let tenant: `0x${string}` | null = null;
  if (isHostedMode()) {
    tenant = tenantOf(req);
    if (!tenant) return NextResponse.json({ source: "none", agents: [] } satisfies ScoreboardResponse);
  }

  if (!existsSync(DB_FILE)) {
    return NextResponse.json({ source: "none", agents: [] } satisfies ScoreboardResponse);
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(DB_FILE, { readOnly: true });
  } catch {
    return NextResponse.json({ source: "none", agents: [] } satisfies ScoreboardResponse);
  }
  try {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = db
        .prepare(
          `SELECT smart_account, name, status, chain_id, caps, granted_at, expires_at,
                  COALESCE(hwm_usdg, 0) AS hwm_usdg, COALESCE(accrued_fee_usdg, 0) AS accrued_fee_usdg
           FROM agents ${tenant ? "WHERE LOWER(owner_address) = ?" : ""} ORDER BY created_at DESC`,
        )
        .all(...(tenant ? [tenant] : [])) as Record<string, unknown>[];
    } catch {
      return NextResponse.json({ source: "sqlite", agents: [] } satisfies ScoreboardResponse);
    }

    const agents: ScoreboardAgent[] = rows.map((row) => {
      const account = row.smart_account as string;

      // WHICH RUN. Everything before the accounting fix stays epoch 1 — no flow
      // records, fills booked off a slippage floor, and an equity curve that can
      // hold a phantom crater from a failed balance read. The first arm after
      // the fix opens epoch 2, and splicing a 200 USDG live book onto a 1,000
      // USDG paper one publishes an 80% collapse that never happened. On a
      // PUBLIC scoreboard.
      //
      // A clause, not a constant: a database written by an older worker has no
      // epoch column, and referencing it would throw at prepare() and empty the
      // whole board. Every row in such a ledger is epoch 1 anyway.
      let epochWhere = "";
      let epochArg: number[] = [];
      try {
        const e = db
          .prepare("SELECT epoch FROM agents WHERE smart_account = ?")
          .get(account) as { epoch: number } | undefined;
        epochWhere = " AND epoch = ?";
        epochArg = [e?.epoch ?? 1];
      } catch {
        /* pre-epoch ledger */
      }

      let equity: ScoreboardEquityPoint[] = [];
      try {
        equity = db
          .prepare(
            `SELECT equity_usdg, datetime(at, 'unixepoch') AS at
             FROM (SELECT * FROM equity WHERE agent_id = ?${epochWhere} ORDER BY at DESC, id DESC LIMIT 500)
             ORDER BY at ASC, id ASC`,
          )
          .all(account, ...epochArg) as unknown as ScoreboardEquityPoint[];
      } catch {
        /* table not created yet */
      }

      // Capital the owner put in, less what they took out — P&L is equity minus
      // this. The chart above is windowed to 500 points; the ARITHMETIC must
      // never be, which is the other half of the old bug: last-minus-first over
      // a sliding window has a "first" that drifts forward, so the published
      // number silently changed meaning once an agent passed 500 snapshots.
      // NULL, not zero, when nothing is on record: this is a PUBLIC scoreboard,
      // and "equity minus nothing" published as P&L is the bankroll dressed up
      // as performance.
      let contributed: number | null = null;
      try {
        const row = db
          .prepare(
            `SELECT COUNT(*) AS n,
                    COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
               FROM flows WHERE agent_id = ?${epochWhere}`,
          )
          .get(account, ...epochArg) as { n: number; net: number } | undefined;
        contributed = !row || row.n === 0 ? null : row.net;
      } catch {
        /* flows arrives with a worker migration */
      }
      // Gas priced in USDG when it was burned, and how much could not be
      // priced — the count is what stops "net of gas" being a claim we can't
      // back on a public page.
      let gasUsdg = 0;
      let gasUnpriced = 0;
      try {
        const row = db
          .prepare(
            `SELECT COALESCE(SUM(gas_usdg), 0) AS usdg,
                    SUM(CASE WHEN gas_wei IS NOT NULL AND gas_usdg IS NULL THEN 1 ELSE 0 END) AS unpriced
               FROM trades WHERE agent_id = ?${epochWhere} AND status = 'landed'`,
          )
          .get(account, ...epochArg) as { usdg: number; unpriced: number | null } | undefined;
        gasUsdg = row?.usdg ?? 0;
        gasUnpriced = row?.unpriced ?? 0;
      } catch {
        /* gas_usdg arrives with a worker migration */
      }

      let latestEquity: number | null = null;
      try {
        const row = db
          .prepare(`SELECT equity_usdg FROM equity WHERE agent_id = ?${epochWhere} ORDER BY at DESC, id DESC LIMIT 1`)
          .get(account, ...epochArg) as { equity_usdg: number } | undefined;
        latestEquity = row?.equity_usdg ?? null;
      } catch {
        /* table not created yet */
      }

      // THE DRAWDOWN, COMPUTED OVER THE WHOLE EPOCH — not over `equity`, which
      // is the 500-point display window. This loop used to run on that array,
      // which is precisely the thing the comment forty lines above forbids: a
      // sliding window has a peak that drifts forward, so a published number
      // silently changed meaning once an agent passed 500 snapshots, and the
      // deepest drawdown of a long run simply fell off the back and vanished.
      // Windowing the chart is fine. Windowing the arithmetic is the bug.
      //
      // The running peak is a SQL window function so the full series never has
      // to be read into memory. NULL when there are no rows — an epoch with no
      // equity history has no drawdown to report, and 0.00% would read as
      // "flawless" rather than "nothing happened yet".
      let maxDdBps: number | null = null;
      try {
        const dd = db
          .prepare(
            `SELECT MAX(CASE WHEN peak > 0 AND equity_usdg < peak
                             THEN CAST(((peak - equity_usdg) / peak) * 10000 AS INTEGER)
                             ELSE 0 END) AS bps
               FROM (SELECT equity_usdg,
                            MAX(equity_usdg) OVER (
                              ORDER BY at ASC, id ASC
                              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                            ) AS peak
                       FROM equity WHERE agent_id = ?${epochWhere})`,
          )
          .get(account, ...epochArg) as { bps: number | null } | undefined;
        maxDdBps = dd?.bps ?? null;
      } catch {
        /* pre-migration ledger, or a SQLite without window functions */
      }

      let trades = { landed: 0, rejected: 0, reverted: 0, volume_usdg: 0 };
      try {
        const t = db
          .prepare(
            `SELECT
               SUM(CASE WHEN status = 'landed' THEN 1 ELSE 0 END) AS landed,
               SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
               SUM(CASE WHEN status = 'reverted' THEN 1 ELSE 0 END) AS reverted,
               COALESCE(SUM(CASE WHEN status = 'landed' AND kind != 'vault-withdraw' THEN amount_usdg ELSE 0 END), 0) AS volume
             FROM trades WHERE agent_id = ?${epochWhere}`,
          )
          .get(account, ...epochArg) as { landed: number; rejected: number; reverted: number; volume: number };
        trades = {
          landed: t.landed ?? 0,
          rejected: t.rejected ?? 0,
          reverted: t.reverted ?? 0,
          volume_usdg: t.volume ?? 0,
        };
      } catch {
        /* table not created yet */
      }

      let caps: Record<string, number> = {};
      try {
        caps = JSON.parse(row.caps as string) as Record<string, number>;
      } catch {
        /* legacy row */
      }

      return {
        smart_account: account,
        name: (row.name as string) ?? "Robin",
        status: row.status as string,
        chain_id: row.chain_id as number,
        caps,
        granted_at: row.granted_at as number,
        expires_at: row.expires_at as number,
        hwm_usdg: row.hwm_usdg as number,
        accrued_fee_usdg: row.accrued_fee_usdg as number,
        equity,
        // Net of gas, like every other surface. Gas leaves in ETH and never
        // touched equity, so without subtracting it a published figure
        // overstates performance by the whole trading cost.
        pnl_usdg:
          latestEquity === null || contributed === null ? null : latestEquity - contributed - gasUsdg,
        gas_usdg: gasUsdg,
        gas_unpriced_trades: gasUnpriced,
        max_drawdown_bps: maxDdBps,
        trades,
      };
    });

    return NextResponse.json({ source: "sqlite", agents } satisfies ScoreboardResponse);
  } finally {
    db.close();
  }
}
