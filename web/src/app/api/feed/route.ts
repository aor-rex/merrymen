/**
 * Agent history for the dashboard: events + equity series, read from the
 * shared SQLite file the worker writes (.data/merrymen.db).
 */

import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { NextResponse } from "next/server";
import { homePaths } from "@/lib/home";
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
           FROM (SELECT * FROM equity WHERE agent_id = ? ORDER BY at DESC, id DESC LIMIT 288)
           ORDER BY at ASC, id ASC`,
        )
        .all(scope) as unknown as EquityPoint[];
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
           FROM trades WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT 30`,
        )
        .all(scope) as unknown as TradeRecord[];
    } catch {
      /* table not created yet */
    }
    try {
      const row = db
        .prepare(
          "SELECT name, hwm_usdg, accrued_fee_usdg FROM agents ORDER BY created_at DESC LIMIT 1",
        )
        .get() as ({ name: string } & AgentFinancials) | undefined;
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
             FROM flows WHERE agent_id = ?`,
        )
        .get(scope) as { n: number; net: number } | undefined;
      netContributionsUsdg = !row || row.n === 0 ? null : row.net;
    } catch {
      /* flows arrives with a worker migration — null, never zero */
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
    } satisfies FeedResponse);
  } finally {
    db.close();
  }
}
