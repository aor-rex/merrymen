/**
 * HOW THE SHELL KEEPS ITS DATA FRESH, AND WHAT IT SAYS WHEN IT CANNOT.
 *
 * App refreshed on a fixed 60s interval whose first line was "return unless the
 * first load succeeded". So a first load that failed was never tried again —
 * the owner sat under the raw DOMException, "signal timed out", until they
 * found a button — and a later refresh that DID succeed never cleared the
 * alert, so a healthy screen kept announcing an outage that had ended.
 *
 * NOW EVERY PASS BOOKS THE NEXT ONE, whatever happened to it: a minute after a
 * success, and 5s, 15s, then 60s after failures in a row. The backoff is short
 * at first because the usual failure is a blip, and it stops at a minute
 * because a real outage should not be answered with a request every five
 * seconds from every open tab.
 *
 * ONE PASS AT A TIME. Retry, the timer and the tab becoming visible all land
 * here, and a second pass started while one is in flight would race it to
 * setState with an older answer.
 *
 * The timers are injected so the schedule can be executed in a test; the shell
 * passes the window's.
 */
import { timeAgo } from "@/lib/time";

export const REFRESH_EVERY_MS = 60_000;
export const RETRY_AFTER_MS = [5_000, 15_000, 60_000] as const;

/** How long until the next pass, given how many have failed in a row. */
export function nextRefreshIn(failuresInARow: number): number {
  if (failuresInARow <= 0) return REFRESH_EVERY_MS;
  return RETRY_AFTER_MS[Math.min(failuresInARow, RETRY_AFTER_MS.length) - 1]!;
}

export interface LoopTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** What the shell renders from: zero failures means healthy. */
export interface LoopState {
  failuresInARow: number;
  /** When the next pass will run — the countdown. */
  nextAt: number;
  /** When a pass last succeeded; null until one has. */
  lastOkAt: number | null;
}

const WINDOW_TIMERS: LoopTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Runs `pass` now, then keeps running it. `pass` resolves true when every read
 * it needed came back; false or a throw is a failure.
 *
 * `paused` is consulted on TIMER passes only — a hidden tab does no work but
 * keeps its next tick booked. The first pass and `retryNow` always run: one is
 * the page loading, the other is a person asking.
 */
export function startRefreshLoop(opts: {
  pass: () => Promise<boolean>;
  report: (state: LoopState) => void;
  paused?: () => boolean;
  timers?: LoopTimers;
}): { retryNow(): void; stop(): void } {
  const t = opts.timers ?? WINDOW_TIMERS;
  let failuresInARow = 0;
  let lastOkAt: number | null = null;
  let handle: unknown = null;
  let inFlight = false;
  let stopped = false;

  const book = (ms: number) => {
    if (handle !== null) t.clearTimeout(handle);
    handle = t.setTimeout(tick, ms);
    return t.now() + ms;
  };

  const run = async () => {
    if (inFlight || stopped) return;
    inFlight = true;
    if (handle !== null) t.clearTimeout(handle);
    handle = null;
    let ok: boolean;
    try {
      ok = await opts.pass();
    } catch {
      ok = false;
    }
    inFlight = false;
    if (stopped) return;
    failuresInARow = ok ? 0 : failuresInARow + 1;
    if (ok) lastOkAt = t.now();
    const nextAt = book(nextRefreshIn(failuresInARow));
    opts.report({ failuresInARow, nextAt, lastOkAt });
  };

  function tick() {
    handle = null;
    if (stopped) return;
    if (opts.paused?.()) {
      // No request from a hidden tab — but the loop must not die of it, or a
      // tab left in the background would come back to data it never refreshes.
      book(nextRefreshIn(failuresInARow));
      return;
    }
    void run();
  }

  void run();
  return {
    retryNow: () => void run(),
    stop: () => {
      stopped = true;
      if (handle !== null) t.clearTimeout(handle);
      handle = null;
    },
  };
}

/**
 * THE SENTENCE, NOT THE STACK. The reader needs three facts: we could not
 * reach the service, we are already trying again, and whether what is on screen
 * is old. The error's own message answers none of them.
 */
export function failureCopy(p: { nextAt: number; lastOkAt: number | null; now: number }): {
  line: string;
  stale: string | null;
} {
  const secs = Math.ceil((p.nextAt - p.now) / 1000);
  return {
    line: secs > 0 ? `Can't reach merrymen, retrying in ${secs}s.` : "Can't reach merrymen, retrying now…",
    stale: p.lastOkAt === null ? null : `Showing what we last read ${timeAgo(p.lastOkAt / 1000)}.`,
  };
}
