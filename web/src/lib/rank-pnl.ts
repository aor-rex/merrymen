/**
 * MAY THIS AGENT'S RETURN BE PUBLISHED, AND IF NOT, WHY NOT.
 *
 * Its own module, with NO IMPORTS, for the same reason the publication gate is:
 * it is the rule the public leaderboard exists to get right, and a rule buried
 * in the middle of a database read is a rule nobody can test. Keeping it
 * dependency-free is what lets a test call it directly instead of standing up a
 * ledger.
 *
 * Three things must all hold:
 *
 *   - capital on record, or there is no denominator;
 *   - an equity reading, or there is no numerator;
 *   - AT LEAST ONE LANDED TRADE.
 *
 * That third one is not obvious and it is the one that matters. `agents.mode`
 * is only the LAST HEARTBEAT's value, and the `equity` table carries no
 * per-row mode — so an agent that wrote its equity rows while simulating and is
 * labelled live now hands this a PRETEND balance to divide by a REAL deposit.
 *
 * Production published +2643.3% exactly that way, at the top of the board: a
 * flat 1000.0000 equity curve — the paper book's opening balance — over about
 * 36 USDG of contributions, from an agent with zero landed trades and 1,225
 * refusals. Every figure was real; the arithmetic was measuring the wrong two
 * things against each other.
 *
 * The fix is a refusal rather than a smarter formula. An agent that has never
 * filled a trade has not produced a return, and the board already has a word
 * for that.
 */

export type UnrankedWhy = "no-deposit" | "never-filled";

export interface RankInputs {
  /** Capital in, less capital out. Null when nothing is on record. */
  contributed: number | null;
  /** The newest equity reading. Null when there is no history. */
  latest: number | null;
  /** Gas charged against the return, in USDG. */
  gasUsdg: number;
  /** Trades that actually filled. Zero means there is no return to measure. */
  landed: number;
}

export interface Rank {
  pnlBps: number | null;
  unrankedWhy: UnrankedWhy | null;
}

/**
 * Exactly one of `pnlBps` and `unrankedWhy` is ever set — they are the two arms
 * of one answer, and both being set would let a page render a rank alongside an
 * excuse for not having one.
 */
export function rankPnl(a: RankInputs): Rank {
  // Checked before the fill count, because "no deposit" is the more fundamental
  // fact: an agent with neither should be told to fund, not to wait.
  if (a.contributed === null || a.contributed <= 0) {
    return { pnlBps: null, unrankedWhy: "no-deposit" };
  }
  if (a.landed <= 0) return { pnlBps: null, unrankedWhy: "never-filled" };
  if (a.latest === null) return { pnlBps: null, unrankedWhy: "never-filled" };
  return {
    pnlBps: Math.round(((a.latest - a.contributed - a.gasUsdg) / a.contributed) * 10_000),
    unrankedWhy: null,
  };
}
