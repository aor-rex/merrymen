/**
 * WHAT THE SHELL DERIVES FROM /api/grants, and what it may say when it could
 * not read it.
 *
 * Out of App.tsx so it can be executed rather than read: App renders under
 * next/navigation and cannot be mounted by the test runner, and every mistake
 * this file exists to prevent was a coercion that looked harmless in source.
 */
import type { AccountState } from "./HostedControls";
import type { ReadState } from "./live";

/**
 * A 6dp USDG amount from the chain, in dollars — or null when nobody read it.
 *
 * `Number(null)` is 0, which is how a failed balance read used to become a
 * balance of zero here even after the route stopped inventing one. An amount
 * that does not parse is unread too: it is not evidence of an empty account.
 */
export function usdgOrNull(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n / 1e6 : null;
}

const capOrNull = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * The two signed caps, or null for each one the shell has not read.
 *
 * WAS `String(caps ?? "")`, and every surface rendered `money(Number(perTrade))`
 * — so an unread key printed "$0.00 per trade". That is a limit, and a limit
 * of zero is the most alarming thing a trading screen can show about money the
 * owner has signed away. Null reaches `money`, which draws a dash.
 */
export function capsOf(account: AccountState | null): { perTrade: number | null; perDay: number | null } {
  const caps = account?.status.grant?.caps;
  return { perTrade: capOrNull(caps?.perTradeUsdg), perDay: capOrNull(caps?.dailyUsdg) };
}

/**
 * WHERE THE OWNER'S BOOK READ STANDS, for the entry that stands in for it.
 *
 * `reads.mine` starts as the seed's "unread" and only changes when a market
 * load returns. If that load THREW, it never returns, and "unread" would draw a
 * skeleton for ever — so once the load has finished, a read that never
 * happened is a failure, not a wait.
 */
export function portfolioReadOf(mine: ReadState, liveLoaded: boolean): ReadState {
  return mine === "unread" && liveLoaded ? "unreadable" : mine;
}

/**
 * WHICH AGENT THE PROFILE SCREEN MAY DRAW, given where its own read stands.
 *
 * It was `profile ?? listed`, so for the whole of the fetch the page drew the
 * LEADERBOARD row — whose curve is raw equity, which the profile refuses to
 * chart — and told the reader "Performance history isn't available yet" about a
 * request that had not come back. Loading is not an answer; while it lasts the
 * screen draws a skeleton.
 *
 * The board row is still worth showing once the profile read has FAILED, and
 * App says so beside it. A profile that loaded once is kept through a later
 * failed refresh: stale and said to be stale beats blank.
 */
export function profileShown<A>(profile: A | null, error: string, listed: A | undefined): A | undefined {
  return profile ?? (error ? listed : undefined);
}
