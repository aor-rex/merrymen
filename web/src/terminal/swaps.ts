/**
 * ONE SWAPS TABLE, FOR A STRANGER AND FOR THE OWNER — its rules, where a test
 * can run them.
 *
 * The public profile rendered each fill as a four-line article ("Not realized
 * on a buy" under every buy, a full date, three footnotes, no coin), and the
 * owner's desk had its own list of every row of any status, so thirty ops-cap
 * refusals pushed the owner's actual fills off the screen. Both now build the
 * same rows and render them with SwapsTable.tsx:
 *
 *  - a Buy or Sell pill, the coin and its name, and a relative age with the
 *    full date on hover;
 *  - DOLLARS ONLY WHERE THEY MAY BE SHOWN: the owner's own desk, or a profile
 *    whose owner published the book. The server already withholds a private
 *    book's sizes; the table refuses to print one it was handed anyway;
 *  - a P&L chip on sells only — a buy realizes nothing, and saying so on every
 *    buy was noise;
 *  - REFUSALS COLLAPSED, per reason, into one muted "Tried" line placed where
 *    the newest of them happened: "Refused 12× today: past today's number of
 *    trades". The owner is still told every refusal and why — hiding refusals
 *    from the owner is the one thing this may not do — just not thirty times.
 */
import type { ProfileTrade } from "@/lib/profile-trades";
import { pctBps, usd } from "@/lib/format";
import type { Thesis } from "./live";

export type SwapSide = "buy" | "sell" | null;
export type SwapStatus = "filled" | "pending" | "refused" | "reverted";

export interface SwapRow {
  id: string;
  /** Null when nothing recorded which way it went — a "Swap", never a guess. */
  side: SwapSide;
  status: SwapStatus;
  symbol: string | null;
  displayName: string | null;
  /** Unix seconds. Null when unread. */
  at: number | null;
  paper: boolean;
  sizeUsdg: number | null;
  realizedBps: number | null;
  realizedUsd: number | null;
  /** The wall's reason, in words — refusals only. */
  reason: string | null;
  /** Why the agent did it, in its decision's words. The owner's desk only. */
  why: string | null;
}

/** From the public profile's fills (profile-trades.ts): every one filled. */
export function swapRowsOfProfile(trades: readonly ProfileTrade[]): SwapRow[] {
  return trades.map((t) => ({
    id: t.id,
    side: t.action === "swap" ? null : t.action,
    status: "filled",
    symbol: t.symbol,
    displayName: t.displayName,
    at: Number.isFinite(t.at) ? t.at : null,
    paper: t.paper,
    sizeUsdg: t.sizeUsdg,
    realizedBps: t.realizedPnlBps,
    realizedUsd: t.realizedPnlUsdg,
    reason: null,
    why: null,
  }));
}

/**
 * From the owner's own tape (live.ts `mine.moves`, from /api/feed).
 *
 * The tape carries no realized P&L today, so a desk sell shows no chip rather
 * than a zero; the day the tape carries it, this is the one line that maps it.
 */
export function swapRowsOfDesk(moves: readonly Thesis[]): SwapRow[] {
  return moves.map((m, i) => {
    const status: SwapStatus =
      m.outcome === "landed" ? "filled"
        : m.outcome === "refused" ? "refused"
        : m.outcome === "reverted" ? "reverted"
        : "pending";
    const at = typeof m.at === "number" && Number.isFinite(m.at) ? m.at : null;
    return {
      id: `${at ?? "t"}-${i}`,
      side: m.action === "buy" || m.action === "sell" ? m.action : null,
      status,
      symbol: m.symbol,
      displayName: null,
      at,
      paper: m.paper,
      sizeUsdg: m.sizeUsdg,
      realizedBps: null,
      realizedUsd: null,
      reason: status === "refused" || status === "reverted" ? m.outcomeText ?? null : null,
      why: m.reason ?? null,
    };
  });
}

/**
 * The P&L chip: on a SELL only, its return always, its dollars only where
 * dollars may be shown. Null when there is nothing read to put on it — a buy,
 * or a sell whose cost basis was never evidenced — and then no chip is drawn.
 */
export function pnlChip(r: SwapRow, showMoney: boolean): { text: string; tone: "up" | "down" } | null {
  if (r.side !== "sell" || r.realizedBps === null || !Number.isFinite(r.realizedBps)) return null;
  const pct = pctBps(r.realizedBps);
  const usdPart = showMoney && r.realizedUsd !== null && Number.isFinite(r.realizedUsd)
    ? ` · ${r.realizedUsd >= 0 ? "+" : "−"}${usd(Math.abs(r.realizedUsd))}`
    : "";
  return { text: `${pct}${usdPart}`, tone: r.realizedBps < 0 ? "down" : "up" };
}

/** A size, only where dollars may be shown, and never a measured zero. */
export function sizeText(r: SwapRow, showMoney: boolean): string | null {
  return showMoney && r.sizeUsdg !== null && Number.isFinite(r.sizeUsdg) && r.sizeUsdg > 0 ? usd(r.sizeUsdg) : null;
}

/**
 * How many rows the owner's tape holds at most — readDeskTrades' own default
 * (desk-trades.ts). A tape that came back this full may have been cut at its
 * old end, so a count reaching back to that end is a FLOOR and says "12+×".
 */
export const DESK_TAPE_ROWS = 30;

export type SwapTab = "all" | "buys" | "sells";

export type SwapItem =
  | { kind: "row"; row: SwapRow }
  | {
      kind: "tried";
      key: string;
      status: "refused" | "reverted";
      count: number;
      reason: string | null;
      newestAt: number | null;
      oldestAt: number | null;
      /**
       * Where the tape was CUT, unix seconds — its oldest row, when it came back
       * full. Null when the tape was whole. Anything older was never read.
       */
      cutAt: number | null;
    };

/** A fill, or an order still on its way — what "Trades · N" counts. */
export const isTrade = (r: SwapRow) => r.status === "filled" || r.status === "pending";

/**
 * The rows one tab shows, newest first, with every refusal of one reason
 * folded into a single "tried" item where the newest of them sits.
 *
 * `tapeFull` says the rows came from a read that hit its limit; the cut is
 * then the oldest row of the WHOLE tape, whichever tab is showing.
 */
export function swapItems(rows: readonly SwapRow[], tab: SwapTab, opts: { tapeFull?: boolean } = {}): SwapItem[] {
  let cutAt: number | null = null;
  if (opts.tapeFull) {
    for (const r of rows) if (r.at !== null && (cutAt === null || r.at < cutAt)) cutAt = r.at;
  }
  const inTab = rows
    .filter((r) => (tab === "buys" ? r.side === "buy" : tab === "sells" ? r.side === "sell" : true))
    .slice()
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity));
  const out: SwapItem[] = [];
  const groups = new Map<string, Extract<SwapItem, { kind: "tried" }>>();
  for (const r of inTab) {
    if (r.status !== "refused" && r.status !== "reverted") {
      out.push({ kind: "row", row: r });
      continue;
    }
    const key = `${r.status}|${r.reason ?? ""}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      if (r.at !== null && (g.oldestAt === null || r.at < g.oldestAt)) g.oldestAt = r.at;
      continue;
    }
    const item = { kind: "tried" as const, key, status: r.status, count: 1, reason: r.reason, newestAt: r.at, oldestAt: r.at, cutAt };
    groups.set(key, item);
    out.push(item);
  }
  return out;
}

/**
 * "Refused 12× today: past today's number of trades".
 *
 * THE SPAN IS READ OFF THE ROWS, not assumed from the tape's window: "today"
 * only when the oldest of them fell on the reader's own calendar day, and
 * otherwise since the day it did. `dayWords` formats that day in the reader's
 * locale; it is passed in so this stays a pure function.
 *
 * AND THE COUNT IS EXACT ONLY IF THE TAPE REACHES BACK PAST THAT SPAN. "12×
 * today" from a tape cut at 10:00 this morning cannot know about 09:00, so it
 * says "12+×"; the same tape cut three days ago read every one of today's.
 */
export function triedLine(
  item: Extract<SwapItem, { kind: "tried" }>,
  nowMs: number,
  dayWords: (ms: number) => string,
): string {
  const verb = item.status === "reverted" ? "Reverted on chain" : "Refused";
  const oldest = item.oldestAt === null ? null : item.oldestAt * 1000;
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const spanStart = oldest === null ? null : oldest >= today.getTime() ? today.getTime() : new Date(oldest).setHours(0, 0, 0, 0);
  const span = oldest === null ? "" : oldest >= today.getTime() ? " today" : ` since ${dayWords(oldest)}`;
  const floor = item.cutAt !== null && (spanStart === null || item.cutAt * 1000 >= spanStart);
  return `${verb} ${item.count}${floor ? "+" : ""}×${span}${item.reason ? `: ${item.reason}` : ""}`;
}
