/**
 * WHICH READ RUNS ON WHICH CLOCK, AND WHAT EACH ONE'S ANSWER DOES.
 *
 * The shell used to run one pass a minute: quotes, then six reads in one
 * Promise.all, then the account — and nothing rendered until the slowest of
 * them came back. Each read is now a clock of its own (refresh-loop.ts) that
 * applies its answer the moment it arrives, through `update`, as a change to
 * the latest answer of every read (live.ts `withRead`). What the screens show
 * is derived from those (`liveOf`), so no read waits on or overwrites another.
 *
 * Out of App.tsx so it can be executed: App renders under next/navigation and
 * the test runner cannot mount it. Everything that touches the page — fetch,
 * the tab's visibility, React state — comes in through `deps`.
 */
import {
  LiveLoadError,
  marketTokensOf,
  parseRead,
  withChanges,
  withQuotes,
  withRead,
  type LiveReadKey,
  type LiveSources,
  type LiveToken,
  type RawRead,
} from "./live";
import type { TokenQuote } from "./quotes";
import {
  ACCOUNT_EVERY_MS,
  BOARD_EVERY_MS,
  DISCOVERIES_EVERY_MS,
  MARKET_EVERY_MS,
  THESES_EVERY_MS,
  THESES_HIDDEN_EVERY_MS,
  type ClockSpec,
} from "./refresh-loop";

export interface LiveClockDeps {
  fetchRead(key: LiveReadKey): Promise<RawRead>;
  /** The Robinhood quotes. Answers an empty map when the venue refuses. */
  loadQuotes(): Promise<ReadonlyMap<string, TokenQuote>>;
  /** The session change for the stocks among these tokens. */
  loadChanges(tokens: LiveToken[]): Promise<ReadonlyMap<string, number>>;
  /** Apply one change to the latest answers — the shell's setState. */
  update(change: (prev: LiveSources) => LiveSources): void;
  /** Session and grants. Throws (a RequestError) when either could not be read. */
  readAccount(): Promise<void>;
  /** Is the tab hidden right now? */
  hidden(): boolean;
}

/**
 * Whether a public read's answer counts as read — and, when nothing answered
 * at all, a throw that says so, which is the only case the outage line may
 * call "Can't reach merrymen" (refresh-loop.ts nothingAnswered).
 */
function verdict(raw: RawRead): boolean {
  if (parseRead(raw).read === "ok") return true;
  if (!raw.answered) throw new LiveLoadError(false);
  return false;
}

export const LIVE_CLOCK_KEYS = ["theses", "market", "board", "discoveries", "account", "feed"] as const;
export type LiveClockKey = (typeof LIVE_CLOCK_KEYS)[number];

/**
 * THE OWNER'S OWN READS — session and grants, and the book — which everything
 * that changes the owner's position asks for again at once: an order that
 * answered, a sign-in, a new agent (App.tsx refreshAccount). A pass already in
 * flight when they ask is followed by one more (refresh-loop.ts retryNow).
 */
export const ACCOUNT_READS = ["account", "feed"] as const satisfies readonly LiveClockKey[];

export function liveClocks(d: LiveClockDeps): (ClockSpec & { key: LiveClockKey })[] {
  /** A public read: its answer applied, and kept past a later failure — see withRead. */
  const publicRead = (key: LiveReadKey) => async () => {
    const raw = await d.fetchRead(key);
    d.update((prev) => withRead(prev, key, raw, true));
    return verdict(raw);
  };
  return [
    {
      // THE FEED — the one read a person watches for something to happen. Not
      // paused while hidden, only slowed: the tab title counts what arrived
      // while nobody was looking, and it can only count what it has read.
      key: "theses",
      half: "market",
      everyMs: () => (d.hidden() ? THESES_HIDDEN_EVERY_MS : THESES_EVERY_MS),
      pass: publicRead("theses"),
    },
    {
      // THE MARKET AND THE QUOTES TOGETHER, ONCE. The quotes were read twice a
      // pass — once on their own and again inside the Promise.all — and both
      // answers were applied. The market's own prices land first; the session
      // change, which needs the stock list and nothing else, follows.
      key: "market",
      half: "market",
      everyMs: MARKET_EVERY_MS,
      paused: d.hidden,
      pass: async () => {
        const [raw, quotes] = await Promise.all([d.fetchRead("market"), d.loadQuotes()]);
        d.update((prev) => withQuotes(withRead(prev, "market", raw, true), quotes));
        const changes = await d.loadChanges(marketTokensOf(raw));
        d.update((prev) => withChanges(prev, changes));
        return verdict(raw);
      },
    },
    { key: "board", half: "market", everyMs: BOARD_EVERY_MS, paused: d.hidden, pass: publicRead("board") },
    {
      // Two minutes: the server's memo lives that long, so asking sooner is
      // asking for the same bytes.
      key: "discoveries",
      half: "market",
      everyMs: DISCOVERIES_EVERY_MS,
      paused: d.hidden,
      pass: publicRead("discoveries"),
    },
    {
      key: "account",
      half: "account",
      everyMs: ACCOUNT_EVERY_MS,
      paused: d.hidden,
      pass: async () => {
        await d.readAccount();
        return true;
      },
    },
    {
      // THE OWNER'S BOOK, which is not on the outage line: a signed-out
      // visitor reads it as unreadable by design, so its failure is not an
      // outage and is not retried on the outage backoff. It says what it could
      // not read on its own surface — which is also why a failure REPLACES the
      // last answer here instead of keeping it: nothing on screen would say a
      // kept book was old.
      key: "feed",
      half: "account",
      everyMs: ACCOUNT_EVERY_MS,
      paused: d.hidden,
      outageLine: false,
      pass: async () => {
        const raw = await d.fetchRead("feed");
        d.update((prev) => withRead(prev, "feed", raw, false));
        return true;
      },
    },
  ];
}
