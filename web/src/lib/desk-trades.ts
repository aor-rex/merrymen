/**
 * THE OWNER'S TAPE, as /api/feed serves it to their own desk and chat.
 *
 * It selected the bare trade row and nothing the ledger knows about what the
 * trade WAS: no fill side, no symbol, no decision. The terminal could then only
 * resolve a side by matching the executed pair against STOCK_TOKENS, so every
 * curve and class trade arrived with no side at all, the desk kept only buys
 * and sells, and an agent that had bought and sold CASHCAT and CHUMP showed its
 * owner "Trades · 0" — while the chat model was handed action null and symbol
 * null and could not say what it had just bought.
 *
 * The join is the one profile-trades.ts already uses, and the rows are
 * collapsed to one per operation for the same reason as there: a redeploy's
 * re-recorded copies must not head the owner's tape either.
 *
 * Kept out of the route so it can be driven against a real ledger in a test.
 */
import type { Db } from "../../../worker/src/db";
import { distinctTrades, OP_COPY_REACH_SEC, tradeOpKey } from "./distinct-trades";

export interface DeskTradeRow {
  kind: string;
  sell_token: string | null;
  buy_token: string | null;
  amount_usdg: number;
  tx_hash: string | null;
  status: string;
  reject_rule: string | null;
  sim_quote_out: string | null;
  sim_min_out: string | null;
  sim_fee_tier: number | null;
  sim_gas: string | null;
  created_at: number;
  /** What the fill did, as the executor recorded it. Absent on a ledger too old to say. */
  fill_side?: string | null;
  /** The fill's own symbol, else the decision's. Unsanitised: the terminal decides what it will print. */
  symbol?: string | null;
  /** The coin's own name, from the decision. Display only. */
  display_name?: string | null;
  /** The side the decision asked for — how a refusal, which filled nothing, still has one. */
  action?: string | null;
  /** Why the agent did it, in its decision's words. The owner's own desk only. */
  reason?: string | null;
  realized_pnl_usdg?: number | null;
}

/**
 * The newest `limit` operations since `sinceSec`, for one account and, when the
 * ledger has the column, one run.
 *
 * THE RICHER READ FALLS BACK, IT DOES NOT FAIL. The decision join and the fill
 * columns arrive with worker migrations, and this app can be reading a ledger
 * an older worker wrote. A missing column must cost the tape its labels, not
 * the tape — an empty one is a claim that nothing happened.
 */
export async function readDeskTrades(
  db: Db,
  account: string,
  epoch: number | null,
  sinceSec: number,
  limit = 30,
): Promise<DeskTradeRow[]> {
  const run = epoch === null ? "" : " AND t.epoch = ?";
  const runArg = epoch === null ? [] : [epoch];
  try {
    return (await db
      .prepare(
        `SELECT t.kind, t.sell_token, t.buy_token, t.amount_usdg, t.tx_hash, t.status, t.reject_rule,
                t.sim_quote_out, t.sim_min_out, t.sim_fee_tier, t.sim_gas, t.created_at,
                t.fill_side, COALESCE(t.fill_symbol, d.symbol) AS symbol, d.display_name, d.action, d.reason,
                t.realized_pnl_usdg
           FROM ${distinctTrades(`t.agent_id = ?${run} AND t.created_at > ?`)}
           LEFT JOIN decisions d ON d.id = t.decision_id AND LOWER(d.agent_id) = LOWER(t.agent_id)
          WHERE t.created_at > ?
          ORDER BY t.created_at DESC, t.id DESC LIMIT ?`,
      )
      // The collapse reaches further back than the tape: a copy is stamped at
      // the restart, up to a day after the op it repeats, and must still find
      // that op to collapse into when the op itself is just outside the window.
      .all(account, ...runArg, sinceSec - OP_COPY_REACH_SEC, sinceSec, limit)) as unknown as DeskTradeRow[];
  } catch {
    return (await db
      .prepare(
        `SELECT kind, sell_token, buy_token, amount_usdg, tx_hash, status, reject_rule,
                sim_quote_out, sim_min_out, sim_fee_tier, sim_gas, created_at
           FROM trades WHERE agent_id = ?${run.replace("t.", "")} AND created_at > ?
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(account, ...runArg, sinceSec, limit)) as unknown as DeskTradeRow[];
  }
}

/**
 * Operations that landed in this run. The count the P&L gate reads, and it
 * counted rows: a redeploy's re-recorded copies doubled it.
 */
export async function countLandedOps(db: Db, account: string, epoch: number | null): Promise<number> {
  const row = (await db
    .prepare(
      `SELECT COUNT(DISTINCT CASE WHEN t.status = 'landed' THEN ${tradeOpKey("t")} END) AS landed
         FROM trades t WHERE t.agent_id = ?${epoch === null ? "" : " AND t.epoch = ?"}`,
    )
    .get(account, ...(epoch === null ? [] : [epoch]))) as { landed: number | null } | undefined;
  return Number(row?.landed ?? 0);
}

/**
 * HOW FAR BACK THE OWNER'S TAPE REACHES.
 *
 * The trades select was `LIMIT 30` with no window at all, so for an agent that
 * has done nothing lately the newest thirty rows are simply its last thirty
 * refusals — however old. The chat sends this tape to a model, the system
 * prompt tells the model to ground itself in it, and the rows carry no
 * timestamp the model can reason about. A tester's agent therefore narrated
 * months-old `no-gas` and `per-trade-cap` refusals in the present tense, and
 * was believed, because it was reading its own ledger faithfully.
 *
 * The window bounds RECENCY and the limit bounds SIZE. Neither substitutes for
 * the other, so both stay.
 */
export const TAPE_WINDOW_SEC = 7 * 24 * 3600;

/**
 * The account's current RUN, or null when this ledger predates runs.
 *
 * Null, not 1: an older worker's database has no `epoch` column, and naming a
 * missing column throws at query time — so every read scoped by it would blank
 * its panel. With null the caller leaves the rows unfiltered, which on such a
 * ledger is the same thing, since every row in it is epoch 1 by definition. An
 * account with no agents row yet is on its first run.
 */
export async function readRunEpoch(db: Db, account: string): Promise<number | null> {
  try {
    const row = (await db.prepare("SELECT epoch FROM agents WHERE smart_account = ?").get(account)) as
      | { epoch: number }
      | undefined;
    return row?.epoch ?? 1;
  } catch {
    return null;
  }
}

/**
 * The owner's tape and the count of what landed, for one account and run, as
 * /api/feed serves them. `nowSec` is passed in so the window is a fact a test
 * can move rather than whatever the clock said.
 *
 * Each half fails on its own and says so with null: an unreadable tape is not
 * a reason to lose the landed count, nor the other way round.
 */
export async function readOwnerTape(
  db: Db,
  account: string,
  epoch: number | null,
  nowSec: number,
): Promise<{ trades: DeskTradeRow[] | null; landed: number | null }> {
  let trades: DeskTradeRow[] | null = null;
  let landed: number | null = null;
  try {
    trades = await readDeskTrades(db, account, epoch, nowSec - TAPE_WINDOW_SEC);
  } catch {
    trades = null;
  }
  try {
    // Operations, not rows: a redeploy's re-recorded copies doubled this.
    landed = await countLandedOps(db, account, epoch);
  } catch {
    landed = null;
  }
  return { trades, landed };
}
