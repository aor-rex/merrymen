/**
 * AN ORDER THAT LANDS BETWEEN TICKS WAKES ONE TICK — ONCE — AND NEVER TWO.
 *
 * Pickup was the tick: the orchestrator ferried on its reconcile pass and the
 * child drained at most one command per tick, on a hosted 240-second cadence.
 * An owner who pressed Buy waited up to four and a half minutes to hear
 * anything. The watcher closes that gap, and these tests hold the three ways a
 * watcher goes wrong on a money path:
 *
 *   - it wakes while something is already running (two ticks, two orders);
 *   - it wakes for the same file forever (a queued order the tick cannot drain
 *     — an unarmed worker — would become a tick every two seconds);
 *   - it spends its one wake while it could not act, and then never wakes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMAND_WAKE_MIN_LEAD_MS, commandTickReady, createCommandWake, createTickClock } from "./command-wake";

/** A watcher over a queue the test controls, recording every wake. */
function harness(ready = true) {
  const state = { queue: [] as string[], ready, wakes: 0 };
  const w = createCommandWake({
    pending: () => state.queue,
    ready: () => state.ready,
    wake: () => {
      state.wakes += 1;
    },
  });
  return { state, poll: () => w.poll() };
}

describe("the watcher wakes once per order", () => {
  it("A NEW ORDER WAKES A TICK", () => {
    const h = harness();
    h.state.queue = ["o1"];
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 1);
  });

  it("AND AN ORDER STILL SITTING THERE DOES NOT WAKE ANOTHER — a tick that could not drain it is not retried every two seconds", () => {
    // The unarmed worker, the tick that returned before its drain: the file
    // stays, and without this the watcher would hammer the chain for as long as
    // the order's window stays open. It waits for the regular tick instead.
    const h = harness();
    h.state.queue = ["o1"];
    h.poll();
    for (let i = 0; i < 50; i += 1) h.poll();
    assert.equal(h.state.wakes, 1);
  });

  it("a SECOND order wakes again, even while the first is still listed", () => {
    const h = harness();
    h.state.queue = ["o1"];
    h.poll();
    h.state.queue = ["o1", "o2"];
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 2);
  });

  it("an empty queue never wakes anything", () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) assert.equal(h.poll(), false);
    assert.equal(h.state.wakes, 0);
  });

  it("an id that left the queue is forgotten, so memory does not grow for the life of the process", () => {
    // And an id written again later — a retried file under the same name — is
    // a new arrival, which is what it is.
    const h = harness();
    h.state.queue = ["o1"];
    h.poll();
    h.state.queue = [];
    h.poll();
    h.state.queue = ["o1"];
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 2);
  });
});

describe("the watcher waits rather than spending its wake", () => {
  it("NOT READY IS NOT A WAKE, and the order keeps its claim on the next one", () => {
    // If a busy tick consumed the order's one wake, a tick that then finished
    // without reaching the drain would leave it to the regular cadence — the
    // four-minute wait this exists to remove.
    const h = harness(false);
    h.state.queue = ["o1"];
    for (let i = 0; i < 5; i += 1) assert.equal(h.poll(), false);
    assert.equal(h.state.wakes, 0);
    h.state.ready = true;
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 1);
  });
});

describe("when a command tick may start", () => {
  const base = { ticked: true, tickRunning: false, commandInFlight: false, regularDueInMs: 120_000 };

  it("BETWEEN TICKS, with nothing in flight and the next tick well away, it may", () => {
    assert.equal(commandTickReady(base), true);
  });

  it("NEVER BESIDE A RUNNING TICK — two ticks at once is two drains", () => {
    assert.equal(commandTickReady({ ...base, tickRunning: true }), false);
  });

  it("NEVER BESIDE AN ORDER IN FLIGHT — the one-at-a-time rule, before it is even asked", () => {
    assert.equal(commandTickReady({ ...base, commandInFlight: true }), false);
  });

  it("never before the first tick — the staggered boot is the fleet's, and nothing is armed yet", () => {
    assert.equal(commandTickReady({ ...base, ticked: false }), false);
  });

  it("not when the regular tick is about to run anyway — it drains the order itself", () => {
    assert.equal(commandTickReady({ ...base, regularDueInMs: COMMAND_WAKE_MIN_LEAD_MS }), false);
    assert.equal(commandTickReady({ ...base, regularDueInMs: COMMAND_WAKE_MIN_LEAD_MS + 1 }), true);
  });

  it("and not when no regular tick is on the clock at all — there is nothing to hand the cadence back to", () => {
    assert.equal(commandTickReady({ ...base, regularDueInMs: null }), false);
  });
});

/**
 * THE CADENCE A COMMAND TICK MUST NOT MOVE.
 *
 * The regular tick is what the strategy's per-tick buy, the Trencher's exits
 * and every review deadline are timed off. A command tick runs BETWEEN two of
 * them: it takes the next regular tick off the clock while it runs and puts it
 * back for the moment it was already due — never sooner, which would be an
 * extra basket buy for every order, and never dropped, which would stop the
 * worker ticking at all.
 */
describe("the tick clock", () => {
  /** Timers the test fires by hand, and a clock it moves. */
  function fake() {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map<number, { fn: () => void; at: number }>();
    return {
      now: () => now,
      setTimer: (fn: () => void, ms: number) => {
        seq += 1;
        timers.set(seq, { fn, at: now + ms });
        return seq;
      },
      clearTimer: (h: unknown) => {
        timers.delete(h as number);
      },
      advance: (ms: number) => {
        now += ms;
      },
      /** The one pending timer, as its due time. */
      pending: () => [...timers.values()].map((t) => t.at),
      /** Fire the due timer, as the event loop would. */
      fire: () => {
        const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
        timers.delete(id);
        if (now < t.at) now = t.at;
        t.fn();
      },
    };
  }
  const settle = () => new Promise((r) => setImmediate(r));

  /** A clock whose ticks the test finishes by hand. */
  function clock(over: { regularDelay?: number } = {}) {
    const f = fake();
    const log: string[] = [];
    let finishRegular: (() => void) | null = null;
    let failRegular: (() => void) | null = null;
    let finishCommand: (() => void) | null = null;
    let failCommand: (() => void) | null = null;
    const c = createTickClock({
      now: f.now,
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
      fallbackMs: 240_000,
      regular: () =>
        new Promise<number>((resolve, reject) => {
          log.push("regular");
          finishRegular = () => resolve(over.regularDelay ?? 240_000);
          failRegular = () => reject(new Error("boom"));
        }),
      command: () =>
        new Promise<void>((resolve, reject) => {
          log.push("command");
          finishCommand = resolve;
          failCommand = () => reject(new Error("boom"));
        }),
    });
    return {
      f,
      c,
      log,
      finishRegular: async () => (finishRegular!(), await settle()),
      failRegular: async () => (failRegular!(), await settle()),
      finishCommand: async () => (finishCommand!(), await settle()),
      failCommand: async () => (failCommand!(), await settle()),
    };
  }

  it("A REGULAR TICK RUNS ON ITS TIMER AND PUTS THE NEXT ONE ON THE CLOCK", async () => {
    const k = clock();
    k.c.start(30_000);
    assert.deepEqual(k.f.pending(), [1_030_000]);
    assert.equal(k.c.state().ticked, false, "nothing has ticked before the staggered first tick");
    k.f.fire();
    assert.deepEqual(k.log, ["regular"]);
    assert.equal(k.c.state().tickRunning, true);
    await k.finishRegular();
    assert.deepEqual(k.f.pending(), [1_030_000 + 240_000]);
    assert.deepEqual(k.c.state(), { ticked: true, tickRunning: false, regularDueInMs: 240_000 });
  });

  it("A COMMAND TICK HANDS THE REGULAR TICK BACK FOR THE MOMENT IT WAS ALREADY DUE", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular(); // next regular due at +240s
    const due = k.f.pending()[0]!;
    k.f.advance(60_000); // an order lands a minute in
    assert.equal(k.c.wakeCommand(), true);
    assert.deepEqual(k.f.pending(), [], "the regular tick is off the clock while the command tick runs");
    assert.equal(k.c.state().regularDueInMs, null);
    k.f.advance(20_000); // the command tick's reads take twenty seconds
    await k.finishCommand();
    assert.deepEqual(k.f.pending(), [due], "not shortened, not pushed back — the same moment");
    assert.deepEqual(k.log, ["regular", "command"], "and no extra regular tick ran");
  });

  it("A COMMAND TICK THAT OUTLASTS THE DUE TIME HANDS BACK AT ONCE, never with a negative wait", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    k.f.advance(230_000);
    k.c.wakeCommand();
    k.f.advance(30_000);
    await k.finishCommand();
    assert.deepEqual(k.f.pending(), [k.f.now()]);
  });

  it("NEVER A COMMAND TICK BESIDE A RUNNING TICK — regular or command", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    assert.equal(k.c.wakeCommand(), false, "a regular tick is running");
    await k.finishRegular();
    assert.equal(k.c.wakeCommand(), true);
    assert.equal(k.c.wakeCommand(), false, "a command tick is running");
    assert.deepEqual(k.log, ["regular", "command"]);
  });

  it("a command tick before the first timer is armed does nothing", () => {
    const k = clock();
    assert.equal(k.c.wakeCommand(), false);
    assert.deepEqual(k.log, []);
  });

  it("A TICK THAT FAILS STILL PUTS THE NEXT ONE ON THE CLOCK — a worker that stops ticking is the worst failure there is", async () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.failRegular();
    assert.deepEqual(k.f.pending(), [k.f.now() + 240_000], "the fallback cadence");
    const due = k.f.pending()[0]!;
    k.f.advance(10_000);
    k.c.wakeCommand();
    await k.failCommand();
    assert.deepEqual(k.f.pending(), [due], "and a failed command tick still hands the regular one back");
    assert.equal(k.c.state().tickRunning, false);
  });
});
