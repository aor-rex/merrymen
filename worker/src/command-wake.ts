/**
 * AN ORDER THAT LANDS BETWEEN TICKS WAKES ONE TICK.
 *
 * Pickup used to be the tick itself. The orchestrator ferried commands on its
 * reconcile pass and the child drained at most one per tick, so on the hosted
 * 240-second cadence an owner who pressed Buy waited up to four and a half
 * minutes to hear anything — long enough to press it again, be told an order
 * was already waiting, and then watch the first one fill.
 *
 * WHY A TICK AND NOT A SIDE DOOR. The obvious fix is to drain the file the
 * moment it appears. But an order must not be placed on old numbers: the
 * drawdown breaker judges it against this account's equity, and a figure from
 * four minutes ago is a breaker switched off. Re-reading equity means the
 * tick's own book read — balances, positions, the class vault, quarantine,
 * every fail-closed return in it — and a second copy of that is the copy that
 * drifts. So the watcher does not drain anything. It wakes a COMMAND TICK: the
 * tick with its producers left out, which re-reads the market and the book and
 * then drains under the same `commandInFlight` guard, the same unlink claim and
 * the same deadline checks as every other tick. See index.ts `commandOnly`.
 *
 * ONCE PER ORDER. A tick can finish without draining — an unarmed worker
 * returns before it gets there — and the file then sits in the queue until its
 * window closes. Waking for it again would be a tick every two seconds against
 * a rate-limited chain for as long as that lasts. So an id is woken for once;
 * after that it waits for the regular cadence, exactly as every order used to.
 * And an id is only spent on a wake that actually happened: a watcher that
 * "used up" an order while it could not act would leave that order to the
 * four-minute wait this exists to remove.
 */

/** How close the regular tick may be before the watcher leaves the order to it. */
export const COMMAND_WAKE_MIN_LEAD_MS = 5_000;

/** How often the child looks at its own queue. A directory listing, nothing more. */
export const COMMAND_WAKE_EVERY_MS = 2_000;

/**
 * May a command tick start now?
 *
 *   ticked            — at least one regular tick has completed. Before that
 *                       nothing is armed, and the first tick is staggered
 *                       across the fleet on purpose; a wake must not undo that.
 *   tickRunning       — never beside a running tick: two ticks at once are two
 *                       drains, and the tick's own reads race each other.
 *   commandInFlight   — never beside an order still in flight. The guard in
 *                       runQueuedCommand would refuse it anyway; asking here
 *                       keeps the order's one wake for a moment it can use.
 *   regularDueInMs    — null when no regular tick is on the clock (one is
 *                       running, or none is armed): there is nothing to hand
 *                       the cadence back to. Within the lead, the regular tick
 *                       is about to drain the order itself.
 */
export function commandTickReady(s: {
  ticked: boolean;
  tickRunning: boolean;
  commandInFlight: boolean;
  regularDueInMs: number | null;
}): boolean {
  if (!s.ticked || s.tickRunning || s.commandInFlight) return false;
  if (s.regularDueInMs === null || !Number.isFinite(s.regularDueInMs)) return false;
  return s.regularDueInMs > COMMAND_WAKE_MIN_LEAD_MS;
}

/**
 * The watcher. `poll` is called on a short interval and returns whether it
 * woke a tick this time.
 */
export function createCommandWake(deps: {
  /** What is queued right now — a listing (command-files.ts `queuedCommandIds`). */
  pending: () => readonly string[];
  /** Whether a command tick may start now. See commandTickReady. */
  ready: () => boolean;
  /** Start the command tick. */
  wake: () => void;
}): { poll(): boolean } {
  const woken = new Set<string>();
  return {
    poll() {
      const ids = deps.pending();
      // An id that left the queue was claimed or dropped; forgetting it keeps
      // this set as small as the queue, for the life of the process.
      const listed = new Set(ids);
      for (const id of woken) if (!listed.has(id)) woken.delete(id);
      const fresh = ids.filter((id) => !woken.has(id));
      if (fresh.length === 0) return false;
      if (!deps.ready()) return false;
      for (const id of fresh) woken.add(id);
      deps.wake();
      return true;
    },
  };
}

/**
 * THE WORKER'S TICK CLOCK: regular ticks on their cadence, and a command tick
 * between two of them that moves neither.
 *
 * Lifted out of index.ts's run loop so the one property that matters can be
 * run by a test rather than trusted: a command tick takes the next regular
 * tick off the clock while it runs and puts it back for the moment it was
 * ALREADY due. Sooner would be an extra strategy tick — an extra basket buy —
 * for every order an owner places; later, or dropped, and the worker's own
 * cadence (the Trencher's exits run off it) slides every time somebody trades.
 *
 * A TICK THAT FAILS STILL ARMS THE NEXT ONE. The worst failure a loop like this
 * has is to stop: a rejected regular tick goes back on the clock after
 * `fallbackMs`, and a rejected command tick still hands the regular tick back.
 * index.ts catches its own failures first; this is the floor under that.
 */
export interface TickClock {
  /** Put the first regular tick on the clock, `delayMs` from now. */
  start(delayMs: number): void;
  /** What commandTickReady needs from the clock. */
  state(): { ticked: boolean; tickRunning: boolean; regularDueInMs: number | null };
  /** Run one command tick between regular ones. False — and nothing run — if a tick is running or none is armed. */
  wakeCommand(): boolean;
}

export function createTickClock(deps: {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  /** The wait after a regular tick that rejected instead of saying how long. */
  fallbackMs: number;
  /** One regular tick, and everything after it; resolves to the wait before the next one. */
  regular: () => Promise<number>;
  /** One command tick. */
  command: () => Promise<void>;
}): TickClock {
  let running = false;
  let ticked = false;
  let timer: unknown = null;
  let dueAt = 0;

  const arm = (ms: number) => {
    const wait = Number.isFinite(ms) ? Math.max(0, ms) : deps.fallbackMs;
    dueAt = deps.now() + wait;
    timer = deps.setTimer(runRegular, wait);
  };

  const runRegular = () => {
    timer = null;
    running = true;
    let run: Promise<number>;
    try {
      run = deps.regular();
    } catch {
      run = Promise.resolve(deps.fallbackMs);
    }
    void run
      .catch(() => deps.fallbackMs)
      .then((next) => {
        running = false;
        ticked = true;
        arm(next);
      });
  };

  return {
    start(delayMs) {
      if (timer !== null || running) return;
      arm(delayMs);
    },
    state() {
      return { ticked, tickRunning: running, regularDueInMs: timer === null ? null : dueAt - deps.now() };
    },
    wakeCommand() {
      if (timer === null || running) return false;
      deps.clearTimer(timer);
      timer = null;
      const due = dueAt;
      running = true;
      let run: Promise<void>;
      try {
        run = deps.command();
      } catch {
        run = Promise.resolve();
      }
      void run
        .catch(() => {})
        .then(() => {
          running = false;
          arm(due - deps.now());
        });
      return true;
    },
  };
}
