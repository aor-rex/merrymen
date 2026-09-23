import type { Db } from "../../../worker/src/db";
import { STOCK_TOKENS } from "../../../packages/core/src/tokens";
import { distinctTrades } from "./distinct-trades";
import { openingOf, PAPER_DUST_RAW, type HoldFill } from "./hold-time";

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
 *
 * A sell's return shows only on an evidenced cost — the rule readTopTrades
 * ranks by (vouchedSells), so the row and the ranking cannot disagree about
 * the same sell. A sell whose cost could not be vouched for is still listed,
 * with no return rather than an estimated one.
 */
export async function readProfileTrades(db: Db, account: string, epoch: number, publicBook: boolean) {
  let rows: Record<string, unknown>[];
  try {
    rows = await db.prepare(`
      SELECT ${TRADE_COLUMNS}, ${OP_KEY} AS op_key, LOWER(t.sell_token) AS coin_token
      FROM ${distinctTrades("t.agent_id = ? AND t.epoch = ?")}
      ${DECISION_JOIN}
      WHERE t.status IN ('landed', 'paper') AND t.kind IN ('swap', 'curve-trade')
      ORDER BY t.created_at DESC, t.id DESC LIMIT 100
    `).all(publicBook ? 1 : 0, account, epoch) as Record<string, unknown>[];
  } catch (error) {
    console.error("[profile-trades] ledger read failed", error instanceof Error ? error.name : "unknown");
    return { trades: [] as ProfileTrade[], read: false };
  }
  const trades = rows.map((row) => profileTradeOf(row, publicBook));
  // Each book's sells against that book's own fills. A coin replayed only in
  // part vouches for none of its sells, which then list with no return — the
  // page says what a sale with no return means (Profile.tsx).
  const vouched = new Set<string>();
  for (const book of ["landed", "paper"] as const) {
    const tokens = rows
      .filter((r, i) => r.status === book && trades[i]!.realizedPnlBps !== null && typeof r.coin_token === "string" && r.coin_token !== "")
      .map((r) => r.coin_token as string);
    try {
      for (const op of (await replayBasis(db, account, book, tokens)).vouched) vouched.add(op);
    } catch (error) {
      // Unreplayable is unvouched: the rows stay, their returns do not.
      console.error("[profile-trades] cost replay failed", error instanceof Error ? error.name : "unknown");
    }
  }
  return {
    trades: trades.map((t, i) =>
      t.realizedPnlBps === null || vouched.has(String(rows[i]!.op_key)) ? t : { ...t, realizedPnlBps: null, realizedPnlUsdg: null },
    ),
    read: true,
  };
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
    // A sell is judged by the basis it sold against: everything before it.
    if (f.side === "sell" && !s.estimated) vouched.add(f.op);
    if (f.side === null || qty === null) {
      // It moved the coin by an amount nobody recorded; one that was not a sell
      // may have booked a cost of its own.
      s.exact = false;
      if (f.side !== "sell" && !EVIDENCED_SOURCES.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    if (f.side === "buy") {
      s.held += qty;
      if (!EVIDENCED_SOURCES.has(f.source ?? "")) s.estimated = true;
      continue;
    }
    s.held -= qty < s.held ? qty : s.held;
    // Flat, and known to be: the worker deleted this coin's basis, so nothing
    // booked before here is in the cost of what comes next.
    if (s.exact && s.held === 0n) s.estimated = false;
  }
  return vouched;
}

/** Rows one COIN's replay reads before it stops and vouches for nothing it could not see. */
export const BASIS_REPLAY_ROWS = 5_000;

/** The same operation key distinct-trades.ts collapses copies on, as a column. */
const OP_KEY = "COALESCE(LOWER(NULLIF(t.user_op_hash, '')), 'row:' || CAST(t.id AS TEXT))";

/** What one book's replay of some coins found. */
interface BasisReplay {
  /** The ops of the sells whose basis nothing estimated (vouchedSells). */
  vouched: Set<string>;
  /**
   * Coins with more basis-moving fills than one replay reads. Nothing is known
   * about any of their sells' costs — which is not the same as knowing they
   * were estimated, and a reader must not print it as either.
   */
  cut: Set<string>;
}

/**
 * vouchedSells over one book's fills of `tokens`, across EVERY period —
 * cost_basis is not scoped to one, so a position bought last period is sold
 * against the basis that period booked. One row per operation; scoped to rows
 * that could have booked a cost, as readCostFromQuote is.
 *
 * EACH COIN IS ITS OWN REPLAY, capped at BASIS_REPLAY_ROWS of its own fills.
 * One query still reads every coin asked about, but the cap is counted per coin
 * (ROW_NUMBER over the coin), because a shared cap made the page's coins
 * compete for it: a basket whose coins together passed it had every replay cut,
 * vouched for nothing, and TOP TRADES came back an empty list read as true. A
 * coin whose OWN fills pass the cap is still cut, and says so in `cut`.
 *
 * A row is counted against the coin it moved: a buy against what it bought, a
 * sell against what it sold, and a row with no side against both its legs.
 *
 * THROWS when the fills cannot be read; each caller says what that means.
 */
async function replayBasis(db: Db, account: string, book: TradeBook, tokens: readonly string[]): Promise<BasisReplay> {
  const out: BasisReplay = { vouched: new Set(), cut: new Set() };
  const want = [...new Set(tokens.map((t) => t.toLowerCase()).filter((t) => t !== ""))];
  if (want.length === 0) return out;
  const marks = want.map(() => "?").join(", ");
  const rows = (await db
    .prepare(
      `SELECT r.op, r.fill_side, r.fill_qty_raw, r.basis_source, r.coin
         FROM (
           SELECT l.*, ROW_NUMBER() OVER (PARTITION BY l.coin ORDER BY l.created_at DESC, l.id DESC) AS coin_rank
             FROM (
               SELECT ${OP_KEY} AS op, t.fill_side, t.fill_qty_raw, t.basis_source, t.created_at, t.id,
                      CASE WHEN leg.side = 'buy' THEN LOWER(t.buy_token) ELSE LOWER(t.sell_token) END AS coin
                 FROM ${distinctTrades("t.agent_id = ? AND (t.user_op_hash IS NOT NULL OR t.fill_side IS NOT NULL OR t.basis_source IS NOT NULL)")}
                CROSS JOIN (SELECT 'buy' AS side UNION ALL SELECT 'sell' AS side) leg
                WHERE t.status = ?
                  AND (t.fill_side IN ('buy','sell') OR t.basis_source IS NOT NULL)
                  AND (t.fill_side IS NULL OR t.fill_side NOT IN ('buy','sell') OR t.fill_side = leg.side)
             ) l
            WHERE l.coin IN (${marks})
         ) r
        WHERE r.coin_rank <= ?
        ORDER BY r.created_at ASC, r.id ASC`,
    )
    // One past the cap, so a coin with exactly the cap is known to be whole.
    .all(account, book, ...want, BASIS_REPLAY_ROWS + 1)) as Record<string, unknown>[];
  const byCoin = new Map<string, BasisReplayFill[]>();
  for (const r of rows) {
    const coin = typeof r.coin === "string" ? r.coin : "";
    if (!coin) continue;
    const op = String(r.op);
    const side = r.fill_side === "buy" || r.fill_side === "sell" ? r.fill_side : null;
    const source = typeof r.basis_source === "string" ? r.basis_source : null;
    // No side: the coin moved and the row cannot say which way or how much.
    const qty = side === null || r.fill_qty_raw === null || r.fill_qty_raw === undefined ? null : String(r.fill_qty_raw);
    const fills = byCoin.get(coin) ?? [];
    byCoin.set(coin, fills);
    fills.push({ op, side, token: coin, qty, source });
  }
  for (const [coin, fills] of byCoin) {
    const complete = fills.length <= BASIS_REPLAY_ROWS;
    if (!complete) out.cut.add(coin);
    for (const op of vouchedSells(fills, complete)) out.vouched.add(op);
  }
  return out;
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
 *
 * AND UNREAD, NOT EMPTY, WHEN A COST COULD NOT BE CHECKED. A sell of a coin
 * traded more often than one replay reads is neither vouched for nor known to
 * be an estimate — it may be the best trade on the page. Once one is met before
 * the list is full, the five cannot be stated, so the read says it did not
 * answer (`read` false) rather than handing back a list that silently skipped
 * it — or an empty one the page would print as "No closed trades yet". Met only
 * after five checked trades, it ranks below all of them and changes nothing.
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
    const cut = new Set<string>();
    const replayed = new Set<string>();
    for (let page = 0; page < TOP_TRADES_MAX_PAGES && trades.length < TOP_TRADES; page++) {
      const rows = (await ranked.all(publicBook ? 1 : 0, account, epoch, book, book === "paper" ? "paper" : "receipt", TOP_TRADES_PAGE, page * TOP_TRADES_PAGE)) as Record<string, unknown>[];
      // Replay each coin once, the first time one of its sells is a candidate.
      const fresh = [...new Set(rows.map((r) => r.coin_token).filter((t): t is string => typeof t === "string" && t !== "" && !replayed.has(t)))];
      if (fresh.length > 0) {
        const replay = await replayBasis(db, account, book, fresh);
        for (const op of replay.vouched) vouched.add(op);
        for (const t of replay.cut) cut.add(t);
        for (const t of fresh) replayed.add(t);
      }
      for (const row of rows) {
        if (trades.length >= TOP_TRADES) break;
        if (!vouched.has(String(row.op_key))) {
          // Unchecked, not estimated: it may belong right here, so nothing
          // from this rank down can be published as the list.
          if (typeof row.coin_token === "string" && cut.has(row.coin_token)) return { trades: [], read: false };
          continue;
        }
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

/** Rows the read of the fills BEFORE the period takes; past it, what was carried in is unknown. */
export const OPENING_READ_LIMIT = 5_000;

/** One fill as FIFO needs it, keyed by the token it moved. */
function holdFillOf(row: Record<string, unknown>): HoldFill {
  const { side } = resolveFill(row);
  // THE COIN IS THE TOKEN THE FILL MOVED: bought on a buy, sold on a sell. An
  // address, not a symbol: the fills of two periods have to meet, and an old
  // fill with no decision linked has no symbol to meet on — the executor has
  // written both token legs on every row it ever recorded.
  const leg = side === "buy" ? row.buy_token : side === "sell" ? row.sell_token : null;
  const coin = typeof leg === "string" && leg.trim() ? leg.trim().toLowerCase() : null;
  // TEXT on both backends, written from a bigint; an integer is accepted in
  // case a driver hands one back, and anything else is unread.
  const raw = row.fill_qty_raw;
  const q = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? BigInt(raw.trim())
    : typeof raw === "bigint" ? raw
    : typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? BigInt(raw)
    : null;
  return {
    side: side === "swap" ? null : side,
    coin,
    qty: q,
    at: Number(row.created_at),
    source: typeof row.basis_source === "string" ? row.basis_source : null,
  };
}

/** The columns a round-trip read takes, for this period's fills and the ones before it. */
const ROUND_TRIP_COLUMNS = `t.id, t.fill_side, d.action, COALESCE(t.fill_symbol, d.symbol) AS symbol, t.buy_token, t.sell_token,
             t.fill_qty_raw, t.basis_source, t.created_at`;

/**
 * Every fill of one book in this period, oldest first, as FIFO needs them —
 * and what the book was already holding when the period began.
 *
 * Null when the ledger could not be read — never an empty tape, which would be
 * a claim that the agent had traded nothing. A fill whose side, coin or
 * quantity is missing is CARRIED with a null, not dropped: averageHoldSec
 * refuses on it, because skipping one fill re-pairs every later one.
 *
 * ONE ROW PER OPERATION ACROSS EVERY PERIOD, then split by period: a
 * redeploy's copy stamped in this period of an operation from the last one is
 * that operation, not a fill of this one.
 *
 * WHAT WAS CARRIED IN (`opening`) is replayed from the book's fills before the
 * period (hold-time.ts openingOf): a new period carries positions over, and a
 * sell closes those units before any of the period's own buys. Null when it
 * could not be read — never "nothing was carried". The paper book needs one
 * more fact, because a paper RESET clears it without a single fill
 * (resetPaperLedger): see paperOpening.
 */
export async function readRoundTrips(
  db: Db,
  account: string,
  epoch: number,
  book: TradeBook,
  limit = ROUND_TRIP_READ_LIMIT,
): Promise<{ fills: HoldFill[]; truncated: boolean; opening: Map<string, bigint | null> | null; dust: bigint } | null> {
  const dust = book === "paper" ? PAPER_DUST_RAW : 0n;
  let fills: HoldFill[];
  let truncated: boolean;
  try {
    const rows = await db.prepare(`
      SELECT ${ROUND_TRIP_COLUMNS}
      FROM ${distinctTrades("t.agent_id = ?")}
      ${DECISION_JOIN}
      WHERE t.status = ? AND t.kind IN ('swap', 'curve-trade') AND t.epoch = ?
      ORDER BY t.created_at ASC, t.id ASC LIMIT ?
    `).all(account, book, epoch, limit + 1) as Record<string, unknown>[];
    truncated = rows.length > limit;
    fills = rows.slice(0, limit).map(holdFillOf);
  } catch (error) {
    console.error("[profile-trades] round-trip read failed", error instanceof Error ? error.name : "unknown");
    return null;
  }
  let opening: Map<string, bigint | null> | null = null;
  try {
    // Newest first under the cap, then turned round: a cut read loses the
    // OLDEST fills, and says so, rather than silently missing the newest.
    const prior = (await db.prepare(`
      SELECT ${ROUND_TRIP_COLUMNS}
      FROM ${distinctTrades("t.agent_id = ?")}
      ${DECISION_JOIN}
      WHERE t.status = ? AND t.kind IN ('swap', 'curve-trade') AND t.epoch < ?
      ORDER BY t.created_at DESC, t.id DESC LIMIT ?
    `).all(account, book, epoch, OPENING_READ_LIMIT + 1)) as Record<string, unknown>[];
    const complete = prior.length <= OPENING_READ_LIMIT;
    const priorFills: HoldFill[] = [];
    for (const row of prior.slice(0, OPENING_READ_LIMIT).reverse()) {
      const f = holdFillOf(row);
      if (f.side !== null) {
        priorFills.push(f);
        continue;
      }
      // No side: it moved one of its two tokens by an amount nobody recorded,
      // so from here both are unknown — not "a coin nobody knows", which would
      // make every coin unknown.
      for (const leg of [row.buy_token, row.sell_token]) {
        if (typeof leg === "string" && leg.trim()) priorFills.push({ ...f, coin: leg.trim().toLowerCase() });
      }
    }
    opening = openingOf(priorFills, { complete, dust });
    if (opening && book === "paper" && [...opening.values()].some((q) => q !== 0n)) {
      opening = await paperOpening(db, account, epoch, opening, fills[0]?.at ?? null);
    }
  } catch (error) {
    console.error("[profile-trades] opening read failed", error instanceof Error ? error.name : "unknown");
    opening = null;
  }
  return { fills, truncated, opening, dust };
}

/**
 * A PAPER CARRY, CHECKED AGAINST THE PERIOD'S FIRST PAPER VALUATION.
 *
 * A paper reset clears the book without a single fill and then opens the next
 * period, so the fills before a paper period cannot tell a reset from a carry.
 * The valuation can, when it was taken before the period's first fill: zero in
 * positions means nothing was carried, whatever the fills say (a reset, or a
 * book already flat); more than zero means the book came over whole — a paper
 * book is only ever cleared all at once — so what the fills say stands. With no
 * such valuation, every coin the fills say was held becomes unknown.
 *
 * Only the paper book: a funded book is never cleared that way, and its
 * valuation leaves out holdings it cannot price, so a zero there proves nothing.
 */
async function paperOpening(
  db: Db,
  account: string,
  epoch: number,
  replayed: Map<string, bigint | null>,
  firstFillAt: number | null,
): Promise<Map<string, bigint | null>> {
  const unknown = new Map([...replayed].map(([coin, q]) => [coin, q === 0n ? 0n : null] as const));
  const mark = (await db
    .prepare(
      `SELECT positions_usdg, at FROM equity WHERE agent_id = ? AND epoch = ? AND mode = 'paper'
        ORDER BY at ASC, id ASC LIMIT 1`,
    )
    .get(account, epoch)) as { positions_usdg: number | null; at: number } | undefined;
  if (!mark || mark.positions_usdg === null || mark.positions_usdg === undefined) return unknown;
  const valued = Number(mark.positions_usdg);
  if (!Number.isFinite(valued) || (firstFillAt !== null && Number(mark.at) > firstFillAt)) return unknown;
  if (valued === 0) return new Map();
  return valued > 0 ? replayed : unknown;
}
