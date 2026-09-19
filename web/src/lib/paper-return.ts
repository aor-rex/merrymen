import type { Db } from "../../../worker/src/db";

/** Change in the recorded paper book, never divided by real deposits.
 * Start at the first valuation of the latest uninterrupted paper period,
 * not the beginning of a sliding chart window or a guessed starting bankroll.
 */
export async function readPaperReturn(db: Db, account: string, epoch: number): Promise<number | null> {
  try {
    const latest = await db.prepare(`SELECT id, equity_usdg, mode FROM equity
      WHERE agent_id = ? AND epoch = ? ORDER BY at DESC, id DESC LIMIT 1`).get(account, epoch) as {id:number; equity_usdg:number; mode:string} | undefined;
    if (!latest || latest.mode !== "paper") return null;
    const first = await db.prepare(`SELECT equity_usdg FROM equity
      WHERE agent_id = ? AND epoch = ? AND mode = 'paper'
      AND id > COALESCE((SELECT MAX(id) FROM equity WHERE agent_id = ? AND epoch = ? AND (mode IS NULL OR mode <> 'paper')), 0)
      ORDER BY at ASC, id ASC LIMIT 1`).get(account, epoch, account, epoch) as {equity_usdg:number} | undefined;
    const start = Number(first?.equity_usdg);
    const end = Number(latest.equity_usdg);
    const bps = (end / start - 1) * 10_000;
    return start > 0 && end >= 0 && Number.isFinite(bps) ? Math.round(bps) : null;
  } catch { return null; }
}
