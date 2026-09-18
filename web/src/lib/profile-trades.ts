import type { Db } from "../../../worker/src/db";

export interface ProfileTrade {
  id: string;
  action: "buy" | "sell";
  symbol: string | null;
  at: number;
  paper: boolean;
  sizeUsdg: number | null;
}

/** Actual fills, independent of whether an agent published a social post.
 * No raw reasons, transaction/account addresses, caps, or owner data leave here.
 * Sizes follow the same owner opt-in as the public book. Transfers are excluded.
 */
export async function readProfileTrades(db: Db, account: string, epoch: number, publicBook: boolean) {
  try {
    const rows = await db.prepare(`
      SELECT t.id, t.fill_side, d.action, d.symbol, t.created_at, t.status,
             CASE WHEN ? = 1 THEN t.amount_usdg ELSE NULL END AS size_usdg
      FROM trades t
      LEFT JOIN decisions d ON d.id = t.decision_id AND d.agent_id = t.agent_id
      WHERE t.agent_id = ? AND t.epoch = ? AND t.status IN ('landed', 'paper')
        AND t.kind IN ('swap', 'curve-trade')
      ORDER BY t.created_at DESC, t.id DESC LIMIT 100
    `).all(publicBook ? 1 : 0, account, epoch) as Record<string, unknown>[];
    const trades: ProfileTrade[] = [];
    for (const row of rows) {
      const side = row.fill_side === "buy" || row.fill_side === "sell" ? row.fill_side : row.action;
      if (side !== "buy" && side !== "sell") continue;
      const symbol = typeof row.symbol === "string" && /^[A-Za-z0-9$._-]{1,32}$/.test(row.symbol) && !/^0x/i.test(row.symbol) ? row.symbol : null;
      const size = publicBook && row.size_usdg != null ? Number(row.size_usdg) : null;
      trades.push({ id: String(row.id), action: side, symbol, at: Number(row.created_at), paper: row.status === "paper", sizeUsdg: size != null && Number.isFinite(size) ? size : null });
    }
    return { trades, read: true };
  } catch (error) {
    console.error("[profile-trades] ledger read failed", error instanceof Error ? error.name : "unknown");
    return { trades: [] as ProfileTrade[], read: false };
  }
}
