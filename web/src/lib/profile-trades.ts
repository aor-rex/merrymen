import type { Db } from "../../../worker/src/db";
import { STOCK_TOKENS } from "../../../packages/core/src/tokens";
import { distinctTrades } from "./distinct-trades";
import type { HoldFill } from "./hold-time";

export interface ProfileTrade {
  id: string;
  action: "buy" | "sell" | "swap";
  symbol: string | null;
  /**
   * The coin's own name, when the decision recorded one and it says more than
   * the symbol does. An autonomous Trencher symbol is address-derived
   * (`T7631DACC21B`), so without this a fill names nothing a reader knows. The
   * public feed already prints the same field beside the symbol.
   */
  displayName: string | null;
  at: number;
  paper: boolean;
  sizeUsdg: number | null;
  realizedPnlUsdg: number | null;
  realizedPnlBps: number | null;
}

/** Which of an agent's two books a figure is about. */
export type TradeBook = "landed" | "paper";

/** The columns every mapping below reads. One list, so the reads cannot drift. */
const TRADE_COLUMNS = `t.id, t.fill_side, d.action, COALESCE(t.fill_symbol,d.symbol) AS symbol, d.display_name, t.buy_token, t.sell_token, t.created_at, t.status,
             CASE WHEN ? = 1 THEN t.amount_usdg ELSE NULL END AS size_usdg,
             t.realized_pnl_usdg, t.fill_cash_usdg, t.basis_source`;
const DECISION_JOIN = "LEFT JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)";

/**
 * What a fill WAS: its side and the symbol it may be printed under.
 *
 * Older fills predate decision links and fill_side, so a registered stock
 * token is resolved from the executed pair, without publishing the addresses.
 * The symbol is admitted only in a printable, non-address shape.
 */
function resolveFill(row: Record<string, unknown>): { side: ProfileTrade["action"]; symbol: string | null } {
  const bought = STOCK_TOKENS.find(t => t.address.toLowerCase() === String(row.buy_token ?? "").toLowerCase());
  const sold = STOCK_TOKENS.find(t => t.address.toLowerCase() === String(row.sell_token ?? "").toLowerCase());
  const recordedSide = row.fill_side === "buy" || row.fill_side === "sell" ? row.fill_side : row.action;
  const side = recordedSide === "buy" || recordedSide === "sell" ? recordedSide : bought ? "buy" : sold ? "sell" : "swap";
  const candidate = side === "buy" ? bought?.symbol ?? row.symbol : sold?.symbol ?? row.symbol;
  const symbol = typeof candidate === "string" && /^[A-Za-z0-9$._-]{1,32}$/.test(candidate) && !/^0x/i.test(candidate) ? candidate : null;
  return { side, symbol };
}

/** One ledger row as the profile may publish it. */
function profileTradeOf(row: Record<string, unknown>, publicBook: boolean): ProfileTrade {
  const { side, symbol } = resolveFill(row);
  // A coin names itself on chain, so the name is admitted rather than
  // echoed: printable, short, not an address, and not the symbol again.
  const named = typeof row.display_name === "string" ? row.display_name.trim() : "";
  const displayName = symbol && named && named.length <= 64 && !/[\u0000-\u001f\u007f]/.test(named) && !/^0x/i.test(named) && named.toUpperCase() !== symbol.toUpperCase() ? named : null;
  const size = publicBook && row.size_usdg != null ? Number(row.size_usdg) : null;
  // Cash minus realized profit is the cost of the quantity sold, including
  // partial closes. Never use the proposed order amount as executed cost.
  const evidenced = row.status === "paper" ? row.basis_source === "paper" : row.basis_source === "receipt";
  const pnl = side === "sell" && evidenced && row.realized_pnl_usdg != null ? Number(row.realized_pnl_usdg) : NaN;
  const cash = row.fill_cash_usdg != null ? Number(row.fill_cash_usdg) : NaN;
  const cost = cash - pnl;
  const bps = Number.isFinite(pnl) && Number.isFinite(cash) && cash >= 0 && cost > 0 ? Math.round(pnl / cost * 10_000) : null;
  return { id: String(row.id), action: side, symbol, displayName, at: Number(row.created_at), paper: row.status === "paper", sizeUsdg: size != null && Number.isFinite(size) ? size : null,
    realizedPnlUsdg: publicBook && Number.isFinite(pnl) ? pnl : null,
    realizedPnlBps: bps != null && Number.isFinite(bps) ? bps : null };
}

/** Actual fills, independent of whether an agent published a social post.
 * No raw reasons, transaction/account addresses, caps, or owner data leave here.
 * Sizes follow the same owner opt-in as the public book. Transfers are excluded.
 * One row per operation: a redeploy's re-recorded copy of a fill collapses into
 * the fill (see distinct-trades.ts) instead of heading the list as "Swapped token".
 */
export async function readProfileTrades(db: Db, account: string, epoch: number, publicBook: boolean) {
  try {
    const rows = await db.prepare(`
      SELECT ${TRADE_COLUMNS}
      FROM ${distinctTrades("t.agent_id = ? AND t.epoch = ?")}
      ${DECISION_JOIN}
      WHERE t.status IN ('landed', 'paper') AND t.kind IN ('swap', 'curve-trade')
      ORDER BY t.created_at DESC, t.id DESC LIMIT 100
    `).all(publicBook ? 1 : 0, account, epoch) as Record<string, unknown>[];
    return { trades: rows.map(row => profileTradeOf(row, publicBook)), read: true };
  } catch (error) {
    console.error("[profile-trades] ledger read failed", error instanceof Error ? error.name : "unknown");
    return { trades: [] as ProfileTrade[], read: false };
  }
}

/** How many TOP TRADES a profile shows. */
export const TOP_TRADES = 5;

/** One basis-moving fill, as the replay below reads it. */
export interface BasisReplayFill {
  /** The operation it belongs to — the same key distinct-trades collapses on. */
  op: string;
  /** Null when the row moved the coin and did not record which way. */
  side: "buy" | "sell" | null;
  /** The coin's address, lowercased. */
  token: string;
  /** Raw units, as the ledger's decimal string. Null when not recorded. */
  qty: string | null;
  /** `trades.basis_source`. */
  source: string | null;
}

const EVIDENCED_SOURCES: ReadonlySet<string> = new Set(["receipt", "paper"]);

/**
 * WHICH SELLS REALIZED AGAINST A COST NOTHING ESTIMATED.
 *
 * A sell's realized_pnl_usdg is its proceeds minus the running cost basis, and
 * that basis is one total per coin that every buy since the position was last
 * flat added to — including a buy whose receipt could not be read, which the
 * worker books from the pre-trade quote (basis_source 'quote', an estimate). The
 * sell's own basis_source says nothing about those buys. So the fills are
 * replayed the way the worker's applyFill booked them (desk-positions.ts
 * costFromQuote does the same for a holding): a buy adds its quantity, a sell
 * removes up to what is held, a position that reaches zero leaves nothing
 * behind. A sell is vouched for when no buy still in the basis it sold against
 * was anything but a receipt or a paper fill.
 *
 * NOTHING IS FORGIVEN THAT CANNOT BE COUNTED. A row that moved the coin without
 * a recorded side or quantity means flat can no longer be told, so an estimate
 * already in stays in; and a read that was cut short (`complete` false) cannot
 * know what came before its first row, so it vouches for nothing. A cost of
 * unknown provenance (no basis_source) is not evidence either.
 *
 * `fills` oldest first. Returns the ops of the vouched sells.
 */
export function vouchedSells(fills: readonly BasisReplayFill[], complete: boolean): Set<string> {
  const vouched = new Set<string>();
  if (!complete) return vouched;
  const state = new Map<string, { held: bigint; estimated: boolean; exact: boolean }>();
  for (const f of fills) {
    const s = state.get(f.token) ?? { held: 0n, estimated: false, exact: true };
    state.set(f.token, s);
    const qty = f.qty !== null && /^\d+$/.test(f.qty.trim()) ? BigInt(f.qty.trim()) : null;
    if (f.side === null || qty === null) {
      // It moved the coin by an amount nobody recorded, and may have booked a
      // cost of its own.
      s.exact = false;
      if (!EVIDENCED_SOURCES.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    if (f.side === "buy") {
      s.held += qty;
      if (!EVIDENCED_SOURCES.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    if (!s.estimated) vouched.add(f.op);
    s.held -= qty < s.held ? qty : s.held;
    // Flat, and known to be: the worker deleted this coin's basis, so nothing
    // booked before here is in the cost of what comes next.
    if (s.exact && s.held === 0n) s.estimated = false;
  }
  return vouched;
}

/** Rows one replay reads before it stops and vouches for nothing it could not see. */
export const BASIS_REPLAY_ROWS = 5_000;

/** The same operation key distinct-trades.ts collapses copies on, as a column. */
const OP_KEY = "COALESCE(LOWER(NULLIF(t.user_op_hash, '')), 'row:' || CAST(t.id AS TEXT))";

/**
 * vouchedSells over one book's fills of `tokens`, across EVERY period —
 * cost_basis is not scoped to one, so a position bought last period is sold
 * against the basis that period booked. One row per operation; scoped to rows
 * that could have booked a cost, as readCostFromQuote is.
 */
async function readVouchedSells(db: Db, account: string, book: TradeBook, tokens: readonly string[]): Promise<Set<string>> {
  const want = [...new Set(tokens.map((t) => t.toLowerCase()))];
  if (want.length === 0) return new Set();
  const marks = want.map(() => "?").join(", ");
  const rows = (await db
    .prepare(
      `SELECT ${OP_KEY} AS op, t.fill_side, t.fill_qty_raw, t.basis_source,
              LOWER(t.buy_token) AS buy_token, LOWER(t.sell_token) AS sell_token
         FROM ${distinctTrades("t.agent_id = ? AND (t.user_op_hash IS NOT NULL OR t.fill_side IS NOT NULL OR t.basis_source IS NOT NULL)")}
        WHERE t.status = ?
          AND (t.fill_side IN ('buy','sell') OR t.basis_source IS NOT NULL)
          AND (LOWER(t.buy_token) IN (${marks}) OR LOWER(t.sell_token) IN (${marks}))
        ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
    )
    .all(account, book, ...want, ...want, BASIS_REPLAY_ROWS)) as Record<string, unknown>[];
  const complete = rows.length < BASIS_REPLAY_ROWS;
  const fills: BasisReplayFill[] = [];
  for (const r of [...rows].reverse()) {
    const qty = r.fill_qty_raw === null || r.fill_qty_raw === undefined ? null : String(r.fill_qty_raw);
    const source = typeof r.basis_source === "string" ? r.basis_source : null;
    const op = String(r.op);
    if (r.fill_side === "buy" || r.fill_side === "sell") {
      const token = r.fill_side === "buy" ? r.buy_token : r.sell_token;
      if (typeof token === "string" && token) fills.push({ op, side: r.fill_side, token, qty, source });
      continue;
    }
    // No side: the coin moved and the row cannot say which way or how much.
    for (const token of [r.buy_token, r.sell_token]) {
      if (typeof token === "string" && token) fills.push({ op, side: null, token, qty: null, source });
    }
  }
  return vouchedSells(fills, complete);
}

/** Ranked candidates read per page, and how many pages before the list settles for what it found. */
const TOP_TRADES_PAGE = TOP_TRADES * 4;
const TOP_TRADES_MAX_PAGES = 50;

/**
 * TOP TRADES: this period's best closed trades, by RETURN.
 *
 * Ranked by realized bps, never by dollars. A dollar ranking is a ranking of
 * position size, and sizes are private unless the owner opted in — so it would
 * both reward the biggest ticket rather than the best call and leak the sizes
 * the percentages were chosen to hide.
 *
 * RANKED IN SQL, over the whole period, so the list is the top of every sell
 * rather than the top of the newest hundred: a LIMIT before the ranking would
 * make "best trade" mean "best recent trade" and say nothing. The WHERE clause
 * is the same test profileTradeOf applies before it will compute a bps figure
 * at all — evidenced, a sell, a cash leg and a positive cost — so every row
 * that survives the SQL is a row the mapping prices, and the five are exact.
 *
 * ONE BOOK, the agent's current one, the same choice read-agent makes for
 * tokensTouched: a live agent's +300% practice trade ranked above its real ones
 * is mixing nobody asked for, chip or no chip.
 *
 * After the op dedupe (distinct-trades.ts), like every trade list here: a
 * redeploy's copy of a sell is not a second best trade.
 *
 * AND ONLY ON AN EVIDENCED COST. The sell's own basis_source is a receipt, but
 * its return is measured against the running basis every buy since the coin
 * was last flat built — and a buy whose receipt was unreadable booked that from
 * the quote. A top-five-by-return is exactly where such an estimate floats to
 * #1, so a sell is ranked only when vouchedSells can replay its coin and finds
 * no estimate under it (the rule FD5 applies to the feed's realized %). The
 * ranking is read a page at a time and filtered, so estimates ranked above a
 * real trade cannot crowd it out of the five.
 */
export async function readTopTrades(
  db: Db,
  account: string,
  epoch: number,
  publicBook: boolean,
  book: TradeBook,
): Promise<{ trades: ProfileTrade[]; read: boolean }> {
  try {
    const ranked = db.prepare(`
      SELECT ${TRADE_COLUMNS}, ${OP_KEY} AS op_key, LOWER(t.sell_token) AS coin_token
      FROM ${distinctTrades("t.agent_id = ? AND t.epoch = ?")}
      ${DECISION_JOIN}
      WHERE t.status = ? AND t.basis_source = ? AND t.kind IN ('swap', 'curve-trade')
        AND (t.fill_side = 'sell' OR ((t.fill_side IS NULL OR t.fill_side NOT IN ('buy', 'sell')) AND d.action = 'sell'))
        AND t.realized_pnl_usdg IS NOT NULL AND t.fill_cash_usdg IS NOT NULL AND t.fill_cash_usdg >= 0
        AND t.fill_cash_usdg - t.realized_pnl_usdg > 0
      ORDER BY t.realized_pnl_usdg / (t.fill_cash_usdg - t.realized_pnl_usdg) DESC, t.created_at DESC, t.id DESC
      LIMIT ? OFFSET ?
    `);
    const trades: ProfileTrade[] = [];
    const vouched = new Set<string>();
    const replayed = new Set<string>();
    for (let page = 0; page < TOP_TRADES_MAX_PAGES && trades.length < TOP_TRADES; page++) {
      const rows = (await ranked.all(publicBook ? 1 : 0, account, epoch, book, book === "paper" ? "paper" : "receipt", TOP_TRADES_PAGE, page * TOP_TRADES_PAGE)) as Record<string, unknown>[];
      // Replay each coin once, the first time one of its sells is a candidate.
      const fresh = [...new Set(rows.map((r) => r.coin_token).filter((t): t is string => typeof t === "string" && t !== "" && !replayed.has(t)))];
      if (fresh.length > 0) {
        for (const op of await readVouchedSells(db, account, book, fresh)) vouched.add(op);
        for (const t of fresh) replayed.add(t);
      }
      for (const row of rows) {
        if (trades.length >= TOP_TRADES) break;
        if (!vouched.has(String(row.op_key))) continue;
        const t = profileTradeOf(row, publicBook);
        // The mapping's own test, again: the SQL is meant to be exactly as
        // strict, and a row it prices differently must not reach a ranked list
        // unpriced.
        if (t.action === "sell" && t.realizedPnlBps !== null) trades.push(t);
      }
      if (rows.length < TOP_TRADES_PAGE) break;
    }
    return { trades, read: true };
  } catch (error) {
    console.error("[profile-trades] top trades read failed", error instanceof Error ? error.name : "unknown");
    return { trades: [], read: false };
  }
}

/**
 * How many fills a round-trip read will take before it stops and says so.
 *
 * A year of a busy basket is a few thousand fills. Past the cap the count is a
 * floor and the hold is not computed: FIFO needs the EARLIEST buys, and a tape
 * cut short at either end pairs the wrong ones.
 */
export const ROUND_TRIP_READ_LIMIT = 5_000;

/**
 * Every fill of one book in this period, oldest first, as FIFO needs them.
 *
 * Null when the ledger could not be read — never an empty tape, which would be
 * a claim that the agent had traded nothing. A fill whose side, coin or
 * quantity is missing is CARRIED with a null, not dropped: averageHoldSec
 * refuses on it, because skipping one fill re-pairs every later one.
 *
 * The coin key is the symbol the basis ledger itself keys positions on: the
 * registry's for a stock token, else the one the fill recorded. Never an
 * address fallback — a buy keyed by symbol and its sell keyed by address would
 * never meet, and the pair would silently vanish rather than refuse.
 */
export async function readRoundTrips(
  db: Db,
  account: string,
  epoch: number,
  book: TradeBook,
  limit = ROUND_TRIP_READ_LIMIT,
): Promise<{ fills: HoldFill[]; truncated: boolean } | null> {
  try {
    const rows = await db.prepare(`
      SELECT t.id, t.fill_side, d.action, COALESCE(t.fill_symbol, d.symbol) AS symbol, t.buy_token, t.sell_token,
             t.fill_qty_raw, t.created_at
      FROM ${distinctTrades("t.agent_id = ? AND t.epoch = ?")}
      ${DECISION_JOIN}
      WHERE t.status = ? AND t.kind IN ('swap', 'curve-trade')
      ORDER BY t.created_at ASC, t.id ASC LIMIT ?
    `).all(account, epoch, book, limit + 1) as Record<string, unknown>[];
    const truncated = rows.length > limit;
    const fills = rows.slice(0, limit).map((row): HoldFill => {
      const { side, symbol } = resolveFill(row);
      // TEXT on both backends, written from a bigint; an integer is accepted in
      // case a driver hands one back, and anything else is unread.
      const raw = row.fill_qty_raw;
      const q = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? BigInt(raw.trim())
        : typeof raw === "bigint" ? raw
        : typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw)
        : null;
      return { side: side === "swap" ? null : side, coin: symbol, qty: q, at: Number(row.created_at) };
    });
    return { fills, truncated };
  } catch (error) {
    console.error("[profile-trades] round-trip read failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
