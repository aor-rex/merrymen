/**
 * IS THIS AGENT WORTH SHADOWING? Asked from evidence, not from its balance.
 *
 * The obvious way to pick a shadow cohort is "the accounts with money in them",
 * and it is wrong in a specific way: an agent with capital but no evidenced
 * contributions makes `computePnl` refuse, which makes `may_size` false, which
 * makes every decision a forced hold. Shadowing it costs model calls and
 * produces no observation at all. The first cohort spent a day proving exactly
 * that with one agent.
 *
 * So a candidate has to clear four things, and they are checked in the order
 * they actually bite:
 *
 *   1. IS IT ALIVE            no heartbeat, no runs
 *   2. CAN ITS BOOK BE READ   evidenced contributions, no legacy rows — without
 *                             these the gate refuses and nothing can be sized
 *   3. IS THERE ANYTHING TO   a book with no position is a book with no
 *      REASON ABOUT           question in front of it
 *   4. IS THE MARKET LEGIBLE  a stale price is not a signal
 *
 * THE FOURTH ONE HAS TWO MEANINGS AND THEY MUST NOT BE CONFLATED. A tokenised
 * equity tracks a 24/5 Chainlink feed: outside US market hours its price is
 * legitimately hours old, and an agent holding one simply cannot be observed
 * until the market opens. A pool-priced token trades continuously, so a stale
 * reading there means the pool stopped being readable — a fault. Same flag,
 * opposite conclusions, and a cohort picked without that distinction would
 * either exclude every equity forever or accept a broken pool as a live market.
 *
 * PURE. It is handed rows and returns verdicts; the orchestrator does the I/O.
 * Same shape as `accounting-preview` and for the same reason — a selection tool
 * that cannot write cannot change what it is measuring.
 */

import { instrumentClassOf, tradesAroundTheClock, type InstrumentClass } from "../../packages/core/src/index";

export interface CandidatePosition {
  symbol: string;
  token: string;
  valueUsdg: number;
  priceStale: boolean;
  priceSource: string;
  updatedAt: number;
}

export interface CandidateInput {
  account: string;
  name: string;
  epoch: number;
  /** "live" | "paper" | "idle" | null, as the agent last reported. */
  mode: string | null;
  /** Unix seconds of the last heartbeat, or null. */
  beatAt: number | null;
  /** Net of flows for this epoch, micro-USDG. Null when the table could not be read. */
  netContributionsUsdg: number | null;
  /** Rows in this epoch older than the accounting cutover. */
  legacyRows: number;
  positions: CandidatePosition[];
  landedTrades: number;
  /** How many decisions this agent has ever recorded — its memory depth. */
  decisions: number;
}

/**
 * Why an agent is or is not worth shadowing.
 *
 * `READY-WHEN-MARKET-OPENS` is deliberately NOT a blocker: the agent is sound
 * and the only thing missing is trading hours. Collapsing it into "blocked"
 * would exclude every tokenised equity permanently, which is most of the fleet.
 */
export type CandidateVerdict =
  | "READY"
  | "READY-WHEN-MARKET-OPENS"
  | "BLOCKED-IDLE"
  | "BLOCKED-CONTRIBUTIONS-UNKNOWN"
  | "BLOCKED-NO-CAPITAL"
  | "BLOCKED-LEGACY-HISTORY"
  | "BLOCKED-NO-POSITION"
  | "BLOCKED-STALE-POOL";

export interface CandidateVerdictDetail {
  account: string;
  name: string;
  verdict: CandidateVerdict;
  why: string;
  /** The position a run would be about: the largest by value. */
  focus: CandidatePosition | null;
  focusClass: InstrumentClass | null;
  /** Whether the focus instrument's market is open around the clock. */
  focusIsContinuous: boolean;
  equityUsdg: number;
  netContributionsUsdg: number | null;
  landedTrades: number;
  decisions: number;
}

/** Heartbeat older than this and the agent is not running. */
const IDLE_AFTER_SEC = 900;

/**
 * Judge one candidate. PURE.
 *
 * `nowSec` is a parameter rather than a clock read so the same inputs always
 * produce the same verdict — a selection tool whose answer depends on when you
 * asked it is not a selection tool.
 */
export function vetCandidate(c: CandidateInput, nowSec: number): CandidateVerdictDetail {
  const sorted = [...c.positions].sort((a, b) => b.valueUsdg - a.valueUsdg);
  const focus = sorted[0] ?? null;
  const focusClass = focus ? instrumentClassOf(focus.token) : null;
  const focusIsContinuous = focus ? tradesAroundTheClock(focus.token) : false;
  const equityUsdg = c.positions.reduce((n, p) => n + p.valueUsdg, 0);

  const base = {
    account: c.account,
    name: c.name,
    focus,
    focusClass,
    focusIsContinuous,
    equityUsdg,
    netContributionsUsdg: c.netContributionsUsdg,
    landedTrades: c.landedTrades,
    decisions: c.decisions,
  };
  const verdict = (v: CandidateVerdict, why: string): CandidateVerdictDetail => ({ ...base, verdict: v, why });

  // ── 1. ALIVE ──────────────────────────────────────────────────────────────
  if (c.beatAt === null || nowSec - c.beatAt > IDLE_AFTER_SEC) {
    const age = c.beatAt === null ? "never" : `${Math.round((nowSec - c.beatAt) / 60)}m ago`;
    return verdict("BLOCKED-IDLE", `last heartbeat ${age} — nothing would run`);
  }

  // ── 2. THE BOOK CAN BE READ ───────────────────────────────────────────────
  // These are the gate's own conditions, checked here so a candidate is not
  // chosen and then found to be unsizeable on its first run. Same order core
  // uses, so the two cannot disagree about which reason bites first.
  if (c.netContributionsUsdg === null) {
    return verdict("BLOCKED-CONTRIBUTIONS-UNKNOWN", "the flows table could not be read for this epoch");
  }
  if (c.netContributionsUsdg <= 0) {
    // KNOWN, and zero. Real knowledge — no capital is at stake — but not a
    // denominator, so `computePnl` refuses and every decision is a forced hold.
    return verdict("BLOCKED-NO-CAPITAL", "no contributed capital on record, so nothing can be sized against it");
  }
  if (c.legacyRows > 0) {
    return verdict(
      "BLOCKED-LEGACY-HISTORY",
      `${c.legacyRows} row(s) in epoch ${c.epoch} predate the accounting fix`,
    );
  }

  // ── 3. SOMETHING TO REASON ABOUT ──────────────────────────────────────────
  if (!focus || focus.valueUsdg <= 0) {
    return verdict("BLOCKED-NO-POSITION", "holds nothing, so there is no question in front of it");
  }

  // ── 4. THE MARKET IS LEGIBLE ──────────────────────────────────────────────
  if (focus.priceStale) {
    if (focusIsContinuous) {
      // A pool-priced token trades around the clock. Stale here is a FAULT.
      return verdict(
        "BLOCKED-STALE-POOL",
        `${focus.symbol} is pool-priced and trades continuously, so a stale mark means the pool stopped being readable`,
      );
    }
    return verdict(
      "READY-WHEN-MARKET-OPENS",
      `${focus.symbol} is a tokenised equity on a 24/5 feed and the market is shut — sound agent, wrong hour`,
    );
  }

  return verdict(
    "READY",
    `${focus.symbol} priced fresh from ${focus.priceSource}` +
      (focusIsContinuous ? ", and it trades around the clock" : ", and its market is open"),
  );
}

const usd = (micro: number): string => (micro / 1e6).toFixed(2);

/** One line per candidate, plus a summary. Sized for a 503-line log window. */
export function cohortLines(all: readonly CandidateVerdictDetail[]): string[] {
  const out: string[] = [];
  for (const c of all) {
    out.push(
      `${c.account.slice(0, 10)}… ${(c.name || "—").slice(0, 14).padEnd(14)} ${c.verdict.padEnd(29)} ` +
        `equity ${usd(c.equityUsdg).padStart(9)} contrib ${c.netContributionsUsdg === null ? "?" : usd(c.netContributionsUsdg).padStart(9)} ` +
        `· ${c.landedTrades} fill(s) ${c.decisions} decision(s)`,
    );
    if (c.focus) {
      out.push(
        `    focus ${c.focus.symbol.padEnd(8)} ${String(c.focusClass).padEnd(13)} ` +
          `${c.focusIsContinuous ? "24/7" : "24/5"} · ${usd(c.focus.valueUsdg)} USDG · ` +
          `${c.focus.priceSource}${c.focus.priceStale ? " STALE" : " fresh"}`,
      );
    }
    out.push(`    ${c.why}`);
  }

  const ready = all.filter((c) => c.verdict === "READY");
  const continuous = ready.filter((c) => c.focusIsContinuous);
  out.push(
    `SUMMARY ${all.length} examined · ${ready.length} READY · ${continuous.length} of those trade 24/7 · ` +
      `${all.filter((c) => c.verdict === "READY-WHEN-MARKET-OPENS").length} sound but waiting on market hours`,
  );
  if (continuous.length === 0) {
    // Said out loud because it is the difference between a cohort that can be
    // observed at any hour and one that goes silent every evening.
    out.push("SUMMARY no candidate holds a continuously-traded instrument — the cohort will be idle outside market hours");
  }
  return out;
}
