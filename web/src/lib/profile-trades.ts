import type { Db } from "../../../worker/src/db";
import { STOCK_TOKENS } from "../../../packages/core/src/tokens";

export interface ProfileTrade {
  id: string;
  action: "buy" | "sell" | "swap";
  symbol: string | null;
  at: number;
  paper: boolean;
  sizeUsdg: number | null;
  realizedPnlUsdg: number | null;
  realizedPnlBps: number | null;
}

/** Actual fills, independent of whether an agent published a social post.
 * No raw reasons, transaction/account addresses, caps, or owner data leave here.
 * Sizes follow the same owner opt-in as the public book. Transfers are excluded.
 */
export async function readProfileTrades(db: Db, account: string, epoch: number, publicBook: boolean) {
  try {
    const rows = await db.prepare(`
      SELECT t.id, t.fill_side, d.action, COALESCE(t.fill_symbol,d.symbol) AS symbol, t.buy_token, t.sell_token, t.created_at, t.status,
             CASE WHEN ? = 1 THEN t.amount_usdg ELSE NULL END AS size_usdg,
             t.realized_pnl_usdg, t.fill_cash_usdg, t.basis_source
      FROM trades t
      LEFT JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)
      WHERE t.agent_id = ? AND t.epoch = ? AND t.status IN ('landed', 'paper')
        AND t.kind IN ('swap', 'curve-trade')
      ORDER BY t.created_at DESC, t.id DESC LIMIT 100
    `).all(publicBook ? 1 : 0, account, epoch) as Record<string, unknown>[];
    const trades: ProfileTrade[] = [];
    for (const row of rows) {
      const bought = STOCK_TOKENS.find(t => t.address.toLowerCase() === String(row.buy_token ?? "").toLowerCase());
      const sold = STOCK_TOKENS.find(t => t.address.toLowerCase() === String(row.sell_token ?? "").toLowerCase());
      const recordedSide = row.fill_side === "buy" || row.fill_side === "sell" ? row.fill_side : row.action;
      // Older fills predate decision links and fill_side. Resolve registered
      // stock tokens from the executed pair, without publishing the addresses.
      const side = recordedSide === "buy" || recordedSide === "sell" ? recordedSide : bought ? "buy" : sold ? "sell" : "swap";
      const candidate = side === "buy" ? bought?.symbol ?? row.symbol : sold?.symbol ?? row.symbol;
      const symbol = typeof candidate === "string" && /^[A-Za-z0-9$._-]{1,32}$/.test(candidate) && !/^0x/i.test(candidate) ? candidate : null;
      const size = publicBook && row.size_usdg != null ? Number(row.size_usdg) : null;
      // Cash minus realized profit is the cost of the quantity sold, including
      // partial closes. Never use the proposed order amount as executed cost.
      const evidenced = row.status === "paper" ? row.basis_source === "paper" : row.basis_source === "receipt";
      const pnl = side === "sell" && evidenced && row.realized_pnl_usdg != null ? Number(row.realized_pnl_usdg) : NaN;
      const cash = row.fill_cash_usdg != null ? Number(row.fill_cash_usdg) : NaN;
      const cost = cash - pnl;
      const bps = Number.isFinite(pnl) && Number.isFinite(cash) && cash >= 0 && cost > 0 ? Math.round(pnl / cost * 10_000) : null;
      trades.push({ id: String(row.id), action: side, symbol, at: Number(row.created_at), paper: row.status === "paper", sizeUsdg: size != null && Number.isFinite(size) ? size : null,
        realizedPnlUsdg: publicBook && Number.isFinite(pnl) ? pnl : null,
        realizedPnlBps: bps != null && Number.isFinite(bps) ? bps : null });
    }
    return { trades, read: true };
  } catch (error) {
    console.error("[profile-trades] ledger read failed", error instanceof Error ? error.name : "unknown");
    return { trades: [] as ProfileTrade[], read: false };
  }
}
