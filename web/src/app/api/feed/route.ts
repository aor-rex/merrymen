/**
 * Agent history for the dashboard: events + equity series, read from the
 * shared SQLite file the worker writes (.data/merrymen.db).
 */

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NextResponse } from "next/server";
import { homePaths } from "@merrymen/home";
import { TRADEABLE_SYMBOLS, type MerrymenSettings } from "@merrymen/core";

const DEFAULT_BASKET = [...TRADEABLE_SYMBOLS];

export const dynamic = "force-dynamic";

const DB_FILE = homePaths.db();

export interface FeedEvent {
  level: "ok" | "warn" | "err";
  message: string;
  created_at: string;
}
export interface EquityPoint {
  cash_usdg: number;
  vault_usdg: number;
  equity_usdg: number;
  at: string;
}
export interface PositionRow {
  symbol: string;
  raw_balance: string;
  ui_multiplier: string;
  price_usd: number;
  price_stale: number;
  /**
   * 'chainlink' or 'pool'. A pool price is a Uniswap TWAP that passed the depth
   * and divergence guards — trustworthy enough to act on, but a thinner claim
   * than an external feed, and the UI says so rather than blurring them.
   */
  price_source: string;
  value_usdg: number;
}
export interface TradeRecord {
  kind: string;
  sell_token: string | null;
  buy_token: string | null;
  amount_usdg: number;
  tx_hash: string | null;
  status: "landed" | "reverted" | "rejected" | "paper";
  reject_rule: string | null;
  sim_quote_out: string | null;
  sim_min_out: string | null;
  sim_fee_tier: number | null;
  sim_gas: string | null;
  created_at: string;
}
export interface AgentFinancials {
  hwm_usdg: number;
  accrued_fee_usdg: number;
}
/** Live identity: the user-given name (soul, mirrored into the agents table by
 * the worker) + the strategy/basket actually configured in settings.json. */
export interface AgentIdentity {
  name: string;
  strategy: string;
  basket: string[];
}
export interface FeedResponse {
  source: "sqlite" | "none";
  events: FeedEvent[];
  equity: EquityPoint[];
  positions: PositionRow[];
  trades: TradeRecord[];
  financials: AgentFinancials | null;
  agent: AgentIdentity | null;
  /**
   * Capital the owner put in, less what they took out. Subtract it from equity
   * to get P&L. Without it the dashboard's headline counts a deposit as a gain,
   * which is exactly what it did until 2026-08-26.
   *
   * NULL when nothing is on record, which is NOT zero: a ledger written before
   * flow tracking knows nothing about what was put in, and equity minus zero is
   * the bankroll presented as profit. Show no P&L rather than a wrong one.
   */
  netContributionsUsdg: number | null;
  /**
   * Gas paid in USDG, and how many landed trades' gas could NOT be priced.
   * P&L is equity − contributions − gas; the count is what says whether that is
   * the full gas cost or only the priceable part.
   */
  gasUsdg: number;
  gasUnpricedTrades: number;
}

/** The configured strategy + basket, straight from settings.json (live). */
function readIdentitySettings(): { strategy: string; basket: string[] } {
  try {
    const raw = readFileSync(homePaths.settings(), "utf8").replace(/^﻿/, "");
    const s = JSON.parse(raw) as MerrymenSettings;
    return {
      strategy: typeof s.strategy === "string" && s.strategy ? s.strategy : "steady-basket",
      basket: Array.isArray(s.basketSymbols) && s.basketSymbols.length ? s.basketSymbols : DEFAULT_BASKET,
    };
  } catch {
    return { strategy: "steady-basket", basket: DEFAULT_BASKET };
  }
}

export async function GET() {
  if (!existsSync(DB_FILE)) {
    // No ledger yet — identity still resolves live from settings + default name.
    return NextResponse.json({
      source: "none",
      events: [],
      equity: [],
      positions: [],
      trades: [],
      financials: null,
      agent: { name: "Robin", ...readIdentitySettings() },
      netContributionsUsdg: null,
      gasUsdg: 0,
      gasUnpricedTrades: 0,
    } satisfies FeedResponse);
  }

  // Read-only open so the worker stays the single writer. Tolerate a DB the
  // worker hasn't fully initialized yet — missing tables read as empty.
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    let events: FeedEvent[] = [];
    let equity: EquityPoint[] = [];
    let positions: PositionRow[] = [];
    let trades: TradeRecord[] = [];
    let financials: AgentFinancials | null = null;
    let name = "Robin";
    let netContributionsUsdg: number | null = null;
    let gasUsdg = 0;
    let gasUnpricedTrades = 0;
    // WHOSE numbers these are. Re-granting mints a new smart account and leaves
    // the old one's rows in the same tables, and every query below used to read
    // the lot — so two agents' equity curves interleaved and the dashboard's
    // P&L spanned both. Armed wins, else the newest.
    let agentId: string | null = null;
    try {
      const row = db
        .prepare(
          // rowid breaks the tie: `status` DEFAULTs to 'armed' so it
          // discriminates less than it looks, and created_at is whole seconds.
          // rowid is insertion order — the newest grant wins, deterministically.
          `SELECT smart_account FROM agents
            ORDER BY (status = 'armed') DESC, created_at DESC, rowid DESC LIMIT 1`,
        )
        .get() as { smart_account: string } | undefined;
      agentId = row?.smart_account ?? null;
    } catch {
      /* no agents table yet */
    }
    // Every query is scoped to that agent. A ledger with no agent row at all
    // (an un-armed first run) has nothing to report anyway.
    const scope = agentId ?? "";
    // …and to the current RUN of that agent. Everything written before the
    // accounting was fixed stays epoch 1: no flow records, fills booked off a
    // slippage floor rather than a receipt, and an equity curve that can hold a
    // phantom crater from a failed balance read. The first arm after the fix
    // opens epoch 2. Charting the two together draws a cliff that never
    // happened — a 200 USDG live book after a 1,000 USDG paper one reads as an
    // 80% collapse — and every derived figure inherits it. Epoch 1 is kept for
    // forensics and never mixed into a number anyone is shown.
    //
    // A CLAUSE, not a constant: this app can be running against a database an
    // older worker wrote, where `epoch` does not exist. Referencing a missing
    // column throws at prepare(), and the surrounding catch would blank the
    // whole panel — strictly worse than showing a pre-epoch ledger unfiltered,
    // since every row in one is epoch 1 by definition.
    let epochWhere = "";
    let epochArg: number[] = [];
    try {
      const erow = db
        .prepare("SELECT epoch FROM agents WHERE smart_account = ?")
        .get(scope) as { epoch: number } | undefined;
      epochWhere = " AND epoch = ?";
      epochArg = [erow?.epoch ?? 1];
    } catch {
      /* epoch arrives with a worker migration — leave every row visible */
    }
    // `events` and `positions` are deliberately NOT epoch-filtered below:
    // neither table has the column, so agent scoping is all they support.
    try {
      events = db
        .prepare(
          `SELECT level, message, datetime(created_at, 'unixepoch') AS created_at
           FROM events WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 40`,
        )
        .all(scope) as unknown as FeedEvent[];
    } catch {
      /* table not created yet */
    }
    try {
      equity = db
        .prepare(
          `SELECT cash_usdg, vault_usdg, equity_usdg, datetime(at, 'unixepoch') AS at
           FROM (SELECT * FROM equity WHERE agent_id = ?${epochWhere} ORDER BY at DESC, id DESC LIMIT 288)
           ORDER BY at ASC, id ASC`,
        )
        .all(scope, ...epochArg) as unknown as EquityPoint[];
    } catch {
      /* table not created yet */
    }
    try {
      positions = db
        .prepare(
          `SELECT symbol, raw_balance, ui_multiplier, price_usd, price_stale,
                  price_source, value_usdg
           FROM positions WHERE agent_id = ? ORDER BY value_usdg DESC`,
        )
        .all(scope) as unknown as PositionRow[];
    } catch {
      // price_source arrives with a worker migration. The dashboard can be
      // running against a database the upgraded worker hasn't opened yet, and
      // losing the whole positions panel over a label would be a worse bug than
      // the missing label — so fall back to the shape that always existed.
      try {
        const legacy = db
          .prepare(
            `SELECT symbol, raw_balance, ui_multiplier, price_usd, price_stale, value_usdg
             FROM positions WHERE agent_id = ? ORDER BY value_usdg DESC`,
          )
          .all(scope) as unknown as Omit<PositionRow, "price_source">[];
        positions = legacy.map((p) => ({ ...p, price_source: "chainlink" }));
      } catch {
        /* table not created yet */
      }
    }
    try {
      trades = db
        .prepare(
          `SELECT kind, sell_token, buy_token, amount_usdg, tx_hash, status, reject_rule,
                  sim_quote_out, sim_min_out, sim_fee_tier, sim_gas,
                  datetime(created_at, 'unixepoch') AS created_at
           FROM trades WHERE agent_id = ?${epochWhere} ORDER BY created_at DESC, id DESC LIMIT 30`,
        )
        .all(scope, ...epochArg) as unknown as TradeRecord[];
    } catch {
      /* table not created yet */
    }
    try {
      const row = db
        .prepare(
          // SCOPED, and with the SAME tie-break the agent resolution above
          // uses. This read was neither: it took the newest row by created_at
          // alone, so on a re-grant the name and high-water mark shown could
          // belong to a different agent than every other number on the page —
          // and the HWM is what the drawdown breaker and the fee accrual are
          // measured against.
          `SELECT name, hwm_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?`,
        )
        .get(scope) as ({ name: string } & AgentFinancials) | undefined;
      if (row) {
        financials = { hwm_usdg: row.hwm_usdg, accrued_fee_usdg: row.accrued_fee_usdg };
        if (typeof row.name === "string" && row.name) name = row.name;
      }
    } catch {
      /* columns not migrated yet */
    }
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
             FROM flows WHERE agent_id = ?${epochWhere}`,
        )
        .get(scope, ...epochArg) as { n: number; net: number } | undefined;
      netContributionsUsdg = !row || row.n === 0 ? null : row.net;
    } catch {
      /* flows arrives with a worker migration — null, never zero */
    }
    try {
      const row = db
        .prepare(
          `SELECT COALESCE(SUM(gas_usdg), 0) AS usdg,
                  SUM(CASE WHEN gas_wei IS NOT NULL AND gas_usdg IS NULL THEN 1 ELSE 0 END) AS unpriced
             FROM trades WHERE agent_id = ?${epochWhere} AND status = 'landed'`,
        )
        .get(scope, ...epochArg) as { usdg: number; unpriced: number | null } | undefined;
      gasUsdg = row?.usdg ?? 0;
      gasUnpricedTrades = row?.unpriced ?? 0;
    } catch {
      /* gas_usdg arrives with a worker migration */
    }
    return NextResponse.json({
      source: "sqlite",
      events,
      equity,
      positions,
      trades,
      financials,
      agent: { name, ...readIdentitySettings() },
      netContributionsUsdg,
      gasUsdg,
      gasUnpricedTrades,
    } satisfies FeedResponse);
  } finally {
    db.close();
  }
}
