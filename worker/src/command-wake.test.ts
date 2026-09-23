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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { queuedCommandIds, runTickCommand, writeCommand, type CommandOutcome, type FileCommand } from "./command-files";
import {
  COMMAND_WAKE_MIN_LEAD_MS,
  commandTickReady,
  createCommandClock,
  createCommandWake,
  createOrderInFlight,
  createTickClock,
  drainOnTick,
  tickPlan,
  type TickKind,
} from "./command-wake";

/** A watcher over a queue the test controls, recording every wake. */
function harness(ready = true) {
  const state = { queue: [] as string[], ready, wakes: 0, wakeTakes: true };
  const w = createCommandWake({
    pending: () => state.queue,
    ready: () => state.ready,
    wake: () => {
      if (!state.wakeTakes) return false;
      state.wakes += 1;
      return true;
    },
  });
  return { state, poll: () => w.poll() };
}

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const newHome = () => {
  const h = mkdtempSync(path.join(tmpdir(), "merry-wake-"));
  homes.push(h);
  return h;
};
/** Let every pending promise chain run, as the event loop would between two timers. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
};

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

  it("A WAKE THE CLOCK TURNED DOWN IS NOT SPENT — the order still has its wake coming", () => {
    // ready() and the clock are asked in the same poll and agree today; if
    // they ever disagree, the order must not lose its one wake to the gap.
    const h = harness();
    h.state.queue = ["o1"];
    h.state.wakeTakes = false;
    assert.equal(h.poll(), false);
    h.state.wakeTakes = true;
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 1);
  });
});

/**
 * TWO ORDERS IN ONE LOOK ARE TWO WAKES.
 *
 * A command tick drains ONE live command. The watcher used to mark every new
 * id as woken and wake once, so when two arrived in the same two-second look
 * — a probe beside an order, or two rows the ferry delivered in one pass —
 * the second was spent on a tick that could never reach it, and waited out
 * the regular cadence (four minutes hosted) with the worker idle.
 */
describe("every order is owed its own wake", () => {
  it("TWO IDS IN ONE POLL WAKE TWICE — one at a time, never together", () => {
    const h = harness();
    h.state.queue = ["o1", "o2"];
    assert.equal(h.poll(), true);
    assert.equal(h.state.wakes, 1, "one command tick at a time");
    assert.equal(h.poll(), true, "and the second order gets its own");
    assert.equal(h.state.wakes, 2);
    for (let i = 0; i < 20; i += 1) h.poll();
    assert.equal(h.state.wakes, 2, "and still once per order, never a retry loop");
  });

  it("an order a regular tick drained while the watcher waited is not woken for", () => {
    // Owed wakes are bounded by what is still listed: a tick that already
    // took an order leaves nothing for a command tick to do.
    const h = harness(false);
    h.state.queue = ["o1", "o2"];
    h.poll();
    h.state.queue = ["o2"]; // the running regular tick drained o1
    h.state.ready = true;
    assert.equal(h.poll(), true);
    assert.equal(h.poll(), false);
    assert.equal(h.state.wakes, 1);
  });

  it("THE SECOND ORDER IS DRAINED BY A SECOND COMMAND TICK once the first one ends — real files, real drain", async () => {
    // The reviewer's probe: a probe and an order written before one look.
    const home = newHome();
    let now = 1_000_000;
    const inFlight = createOrderInFlight();
    const ran: string[] = [];
    let running = false;
    let wakes = 0;
    const drain = () =>
      inFlight.run(() =>
        runTickCommand(home, {
          now: () => now,
          run: async (cmd) => (ran.push(cmd.id), { ok: true, line: "ok" }),
          told: async () => {},
        }),
      );
    const w = createCommandWake({
      pending: () => queuedCommandIds(home),
      ready: () =>
        commandTickReady({ ticked: true, tickRunning: running, commandInFlight: inFlight.busy(), regularDueInMs: 120_000 }),
      wake: () => {
        wakes += 1;
        running = true;
        void drainOnTick(tickPlan("command"), drain).then(() => {
          running = false;
        });
        return true;
      },
    });
    writeCommand(home, { id: "probe1", kind: "selftest", at: now });
    writeCommand(home, { id: "order1", kind: "trade", at: now + 1, args: { side: "buy", symbol: "TSLA", usdgAmount: 5 }, expiresAt: now + 495_000 });
    w.poll();
    await settle();
    for (let i = 0; i < 5; i += 1) {
      now += 2_000;
      w.poll();
      await settle();
    }
    assert.deepEqual(ran, ["probe1", "order1"], "the order is picked up in seconds, not at the next regular tick");
    assert.equal(wakes, 2);
    assert.deepEqual(queuedCommandIds(home), []);
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
  /** A clock whose ticks the test finishes by hand. */
  function clock(over: { regularDelay?: number } = {}) {
    const f = fake();
    const log: string[] = [];
    const orders = createOrderInFlight();
    let finishRegular: (() => void) | null = null;
    let failRegular: (() => void) | null = null;
    let finishCommand: (() => void) | null = null;
    let failCommand: (() => void) | null = null;
    const c = createTickClock({
      now: f.now,
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
      fallbackMs: 240_000,
      inFlight: () => orders.settled(),
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
    /** An owner order in flight, as runQueuedCommand holds one; the returned function lands it. */
    const startOrder = () => {
      let land!: () => void;
      void orders.run(() => new Promise<void>((r) => (land = r)));
      return async () => (land(), await settle());
    };
    return {
      f,
      c,
      log,
      orders,
      startOrder,
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

  it("A REGULAR TICK DUE WHILE AN ORDER IS IN FLIGHT WAITS FOR IT TO LAND — it never reads the book under a live trade", async () => {
    // The order's own cash move happens between inclusion and its row. A book
    // read in that gap books it as money that left with "no trade explains
    // this", moves the high-water mark with it, and can charge a fee on it.
    const k = clock();
    k.c.start(0);
    k.f.fire();
    await k.finishRegular();
    const land = k.startOrder(); // drained by that tick, still waiting on its receipt
    k.f.fire(); // the next regular tick comes due
    await settle();
    assert.deepEqual(k.log, ["regular"], "not started while the order is mid-trade");
    assert.equal(k.c.state().tickRunning, true, "and it holds the clock, so no command tick starts either");
    assert.equal(k.c.wakeCommand(), false);
    await land();
    assert.deepEqual(k.log, ["regular", "regular"], "it runs the moment the order lands");
    await k.finishRegular();
    assert.equal(k.c.state().tickRunning, false);
    assert.equal(k.f.pending().length, 1, "and the cadence carries on");
  });

  it("with nothing in flight a regular tick starts on its timer, at once", () => {
    const k = clock();
    k.c.start(0);
    k.f.fire();
    assert.deepEqual(k.log, ["regular"]);
  });
});

/**
 * WHAT A COMMAND TICK IS, as one value tick() reads instead of a flag it
 * tests in four places.
 */
describe("the tick plan", () => {
  it("A COMMAND TICK READS AND DRAINS, AND DOES NOTHING ELSE", () => {
    const p = tickPlan("command");
    assert.equal(p.producers, false, "no strategy, class route or discovery — an order must not also buy the basket");
    assert.equal(p.brain, false, "an order arriving is not a reason to ask the Brain anything");
    assert.equal(p.awaitDrain, true, "and it does not end while its order is still mid-trade");
  });

  it("A COMMAND TICK MOVES NO RATCHET AND WRITES NO EQUITY ROW", () => {
    // Fee above the high-water mark follows the running maximum of sampled
    // equity, and that maximum only rises as samples are added — so an owner
    // order that added one could charge a fee on a transient peak the regular
    // cadence would never have seen, and move the breaker's reference point.
    assert.equal(tickPlan("command").ratchets, false);
  });

  it("a regular tick is the whole tick, and leaves its drain running beside the strategy", () => {
    assert.deepEqual(tickPlan("regular"), { kind: "regular", ratchets: true, brain: true, awaitDrain: false, producers: true });
  });
});

describe("the drain, as the plan runs it", () => {
  it("A COMMAND TICK WAITS FOR ITS ORDER, then stops", async () => {
    let landed = false;
    let land!: () => void;
    const drain = () => new Promise<void>((r) => (land = r)).then(() => void (landed = true));
    let returned: boolean | null = null;
    void drainOnTick(tickPlan("command"), drain).then((v) => (returned = v));
    await settle();
    assert.equal(returned, null, "still waiting on the order");
    land();
    await settle();
    assert.equal(landed, true);
    assert.equal(returned, false, "and the tick ends there — no producer runs");
  });

  it("a regular tick starts the drain and goes on to its producers without waiting", async () => {
    let started = false;
    const goOn = await drainOnTick(tickPlan("regular"), () => ((started = true), new Promise<void>(() => {})));
    assert.equal(started, true);
    assert.equal(goOn, true);
  });

  it("a drain that fails never takes the tick down, on either kind", async () => {
    assert.equal(await drainOnTick(tickPlan("command"), () => Promise.reject(new Error("boom"))), false);
    assert.equal(await drainOnTick(tickPlan("regular"), () => Promise.reject(new Error("boom"))), true);
    assert.equal(await drainOnTick(tickPlan("command"), () => { throw new Error("sync boom"); }), false);
  });
});

describe("one owner order in flight", () => {
  it("A SECOND ONE IS NOT STARTED BESIDE THE FIRST", async () => {
    const o = createOrderInFlight();
    let land!: () => void;
    let ran = 0;
    const first = o.run(() => ((ran += 1), new Promise<void>((r) => (land = r))));
    assert.equal(o.busy(), true);
    assert.equal(await o.run(async () => void (ran += 1)), false, "refused, not queued");
    assert.equal(ran, 1);
    land();
    assert.equal(await first, true);
    assert.equal(o.busy(), false);
    assert.equal(o.settled(), null, "nothing to wait for once it has landed");
  });

  it("settled() resolves when the order lands, and a failed order still frees the slot", async () => {
    const o = createOrderInFlight();
    let fail!: (e: Error) => void;
    const run = o.run(() => new Promise<void>((_, rej) => (fail = rej)));
    const waiting = o.settled();
    assert.ok(waiting);
    let settledAt = false;
    void waiting.then(() => (settledAt = true));
    fail(new Error("reverted"));
    await assert.rejects(run);
    await settle();
    assert.equal(settledAt, true);
    assert.equal(o.busy(), false);
  });
});

/**
 * THE WHOLE WIRING, as main() puts it together: the real clock, watcher,
 * readiness rule, plan, drain and command files, with the order's trade held
 * open by the test. The reviewer's probe, made a test.
 */
describe("a command tick's order and the regular tick never overlap", () => {
  function worker() {
    let now = 1_000_000;
    let seq = 0;
    const timers = new Map<number, { fn: () => void; at: number }>();
    const home = newHome();
    const orders = createOrderInFlight();
    const log: string[] = [];
    const landing: (() => void)[] = [];
    const drain = () =>
      orders.run(() =>
        runTickCommand(home, {
          now: () => now,
          run: (cmd: FileCommand) =>
            new Promise<CommandOutcome>((resolve) => {
              log.push(`order ${cmd.id} sent`);
              landing.push(() => {
                log.push(`order ${cmd.id} recorded`);
                resolve({ ok: true, line: "filled" });
              });
            }),
          told: async () => {},
        }),
      );
    const tick = async (kind: TickKind) => {
      const plan = tickPlan(kind);
      log.push(`${kind} reads the book${orders.busy() ? " WITH AN ORDER IN FLIGHT" : ""}`);
      if (!(await drainOnTick(plan, drain))) return;
      log.push(`${kind} runs its producers`);
    };
    // THE SAME FACTORY main() BUILDS ITS CLOCK WITH, so this runs its wiring.
    const clock = createCommandClock({
      now: () => now,
      setTimer: (fn, ms) => (timers.set(++seq, { fn, at: now + ms }), seq),
      clearTimer: (h) => void timers.delete(h as number),
      fallbackMs: 240_000,
      orders,
      pending: () => queuedCommandIds(home),
      regular: async () => (await tick("regular"), 240_000),
      command: () => tick("command"),
    });
    return {
      home,
      log,
      clock,
      watcher: clock,
      advance: (ms: number) => void (now += ms),
      now: () => now,
      pending: () => [...timers.values()].map((t) => t.at),
      fire: async () => {
        const [id, t] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
        timers.delete(id);
        if (now < t.at) now = t.at;
        t.fn();
        await settle();
      },
      land: async () => (landing.shift()!(), await settle()),
      order: (id: string) =>
        writeCommand(home, { id, kind: "trade", at: now, args: { side: "buy", symbol: "TSLA", usdgAmount: 5 }, expiresAt: now + 495_000 }),
    };
  }

  it("A COMMAND TICK DOES NOT END WHILE ITS ORDER IS MID-TRADE, and the regular tick waits behind it", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire(); // the first regular tick; the next is due in 240 s
    const due = w.pending()[0]!;
    w.advance(60_000);
    w.order("order1");
    w.watcher.poll();
    await settle();
    assert.ok(w.log.includes("order order1 sent"));
    assert.equal(w.clock.state().tickRunning, true, "the command tick is still running while its order is in flight");
    w.advance(200_000); // the receipt is slow; the regular tick's moment passes
    assert.deepEqual(w.pending(), [], "no regular tick is on the clock while the order is mid-trade");
    await w.land();
    assert.deepEqual(w.pending(), [w.now()], "handed back the moment the order lands — it was already due");
    assert.ok(w.now() > due);
    await w.fire();
    assert.deepEqual(w.log, [
      "regular reads the book",
      "regular runs its producers",
      "command reads the book",
      "order order1 sent",
      "order order1 recorded",
      "regular reads the book",
      "regular runs its producers",
    ]);
  });

  it("TWO ORDERS IN ONE LOOK: the second never starts beside the first, and gets its own command tick once the first lands", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire();
    w.advance(10_000);
    w.order("order1");
    w.order("order2");
    w.clock.poll();
    await settle();
    assert.ok(w.log.includes("order order1 sent"));
    for (let i = 0; i < 3; i += 1) {
      w.advance(2_000);
      w.clock.poll();
      await settle();
    }
    assert.ok(!w.log.includes("order order2 sent"), "never two in flight");
    await w.land();
    w.advance(2_000);
    w.clock.poll();
    await settle();
    assert.ok(w.log.includes("order order2 sent"), "picked up in seconds, not at the next regular tick");
    await w.land();
    assert.deepEqual(queuedCommandIds(w.home), []);
    assert.equal(w.log.filter((l) => l === "command reads the book").length, 2);
    assert.ok(!w.log.some((l) => l.includes("WITH AN ORDER IN FLIGHT")), w.log.join("\n"));
  });

  it("NO COMMAND TICK WHILE AN ORDER A REGULAR TICK DRAINED IS STILL IN FLIGHT — it would read the book mid-trade too", async () => {
    // The clock is idle and armed, so only the slot knows an order is out.
    const w = worker();
    w.order("order1");
    w.clock.start(0);
    await w.fire(); // drains order1 beside the strategy, ends, and arms the next tick
    w.advance(10_000);
    w.order("order2");
    for (let i = 0; i < 3; i += 1) {
      w.advance(2_000);
      w.clock.poll();
      await settle();
    }
    assert.ok(!w.log.includes("command reads the book"), w.log.join("\n"));
    await w.land(); // order1 lands
    w.clock.poll();
    await settle();
    assert.ok(w.log.includes("order order2 sent"), "and the waiting order gets its tick the moment the first lands");
    assert.ok(!w.log.some((l) => l.includes("WITH AN ORDER IN FLIGHT")), w.log.join("\n"));
  });

  it("AN ORDER THAT LANDS WITHIN FIVE SECONDS OF THE REGULAR TICK IS LEFT TO IT — one read of the chain, not two", async () => {
    const w = worker();
    w.clock.start(0);
    await w.fire();
    w.advance(240_000 - COMMAND_WAKE_MIN_LEAD_MS);
    w.order("order1");
    w.clock.poll();
    await settle();
    assert.ok(!w.log.includes("command reads the book"));
    await w.fire();
    assert.deepEqual(w.log.slice(-3), ["regular reads the book", "order order1 sent", "regular runs its producers"]);
  });

  it("AN ORDER A REGULAR TICK DRAINED IS STILL IN FLIGHT WHEN THE NEXT ONE COMES DUE — that one waits too", async () => {
    const w = worker();
    w.order("order1");
    w.clock.start(0);
    await w.fire(); // reads, drains order1 beside the strategy, and ends
    assert.ok(w.log.includes("order order1 sent"));
    await w.fire(); // the next regular tick, 240 s on, with the receipt still outstanding
    assert.ok(!w.log.some((l) => l.includes("WITH AN ORDER IN FLIGHT")), w.log.join("\n"));
    await w.land();
    assert.deepEqual(w.log.slice(-3), ["order order1 recorded", "regular reads the book", "regular runs its producers"]);
    assert.ok(!w.log.some((l) => l.includes("WITH AN ORDER IN FLIGHT")), w.log.join("\n"));
  });
});
