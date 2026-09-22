/**
 * THE CARD SAYS WHAT THE SERVER SAID, AND NOTHING ON A TIMER OF ITS OWN.
 *
 * It polled for a fixed seven minutes and then told the owner "nothing was
 * sent". At the hosted 240 s tick the order's own window is 8m15s, so the
 * owner could be told nothing happened, ask again, be refused with "you
 * already have an order waiting", and then watch the first one fill.
 *
 * These drive the loop with a fake clock and a scripted server: whatever the
 * owner is told is the server's terminal answer, or — if none arrives by the
 * order's own deadline — a sentence that does not claim to know.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ORDER_STALE_GRACE_MS } from "@/lib/order-state";
import { followOrder, followWindowMs, type OrderPoll } from "./order-follow";

const MIN = 60_000;
const T = 1_800_000_000_000;
/** What POST hands back: the order's window as a DURATION from the response. */
const WINDOW_MS = (2 * 240 + 15) * 1000;
const EXPIRES = T + WINDOW_MS;

/** A fake clock, a server scripted by time, and a record of what was said. */
function harness(script: (at: number) => OrderPoll | "throw", alive = () => true) {
  let now = T;
  const said: { at: number; line: string }[] = [];
  const polls: number[] = [];
  const deps = {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    poll: async () => {
      polls.push(now);
      const r = script(now);
      if (r === "throw") throw new Error("network");
      return r;
    },
    alive,
    say: (line: string) => said.push({ at: now, line }),
  };
  return { deps, said, polls, clock: () => now };
}

describe("an order that fills after seven minutes", () => {
  it("IS REPORTED AS FILLED, and nothing claims otherwise first", async () => {
    const h = harness((at) =>
      at < T + 8 * MIN
        ? { state: "queued" }
        : at < T + 9 * MIN
          ? { state: "running" }
          : { state: "done", result: "bought 25.00 USDG of TSLA" },
    );
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.deepEqual(h.said.map((s) => s.line), ["bought 25.00 USDG of TSLA"]);
    assert.ok(h.said[0]!.at >= T + 9 * MIN);
  });

  it("it does not stop polling at seven minutes", async () => {
    const h = harness((at) => (at < T + 8 * MIN ? { state: "queued" } : { state: "done", result: "filled" }));
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.ok(h.polls.some((p) => p > T + 7 * MIN), "the poll must outlive the old fixed window");
  });
});

describe("an order that really expired", () => {
  it("SAYS NOTHING WAS SENT — because the server said so", async () => {
    const h = harness((at) => (at <= EXPIRES + ORDER_STALE_GRACE_MS ? { state: "queued" } : { state: "expired" }));
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.equal(h.said.length, 1);
    assert.match(h.said[0]!.line, /nothing was sent/);
    assert.ok(h.said[0]!.at > EXPIRES + ORDER_STALE_GRACE_MS, "and not a moment before the server knew");
  });
});

describe("when the server never answers", () => {
  it("A CLAIMED ORDER WITH NO ANSWER IS NOT CALLED A FAILURE", async () => {
    // The worker took it and has not reported back. It may still have filled;
    // "nothing was sent" here is the exact false sentence this replaces.
    const h = harness(() => ({ state: "running" }));
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.equal(h.said.length, 1);
    assert.doesNotMatch(h.said[0]!.line, /nothing was sent|never|did not/i);
    assert.match(h.said[0]!.line, /trades/, "it points the owner at where the answer will be");
    assert.ok(h.clock() > EXPIRES + ORDER_STALE_GRACE_MS, "and it waited out the order's own window first");
  });

  it("a dropped poll is not an outcome", async () => {
    let n = 0;
    const h = harness(() => (++n < 4 ? "throw" : n < 6 ? null : { state: "done", result: "sold 5.00 USDG of GME" }));
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.deepEqual(h.said.map((s) => s.line), ["sold 5.00 USDG of GME"]);
  });

  it("the loop still ends when the server is unreachable throughout", async () => {
    const h = harness(() => "throw");
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.equal(h.said.length, 1);
    assert.doesNotMatch(h.said[0]!.line, /nothing was sent/);
  });

  it("with no deadline from the server it still ends, and still does not guess", async () => {
    const h = harness(() => ({ state: "queued" }));
    await followOrder("a1", null, h.deps);
    assert.equal(h.said.length, 1);
    assert.doesNotMatch(h.said[0]!.line, /nothing was sent/);
  });
});

describe("THE CARD WAITS ON ITS OWN CLOCK, NOT THE SERVER'S", () => {
  // The give-up time was the server's `expiresAt` compared with the browser's
  // Date.now(). A browser clock eleven minutes fast gave up before asking once
  // — "I could not get an answer" about an order about to fill — and a smaller
  // skew stopped asking before the fill arrived, so the owner never heard it.
  /** The same scripted server, seen from a browser whose clock is `skewMs` off. */
  function skewed(skewMs: number, script: (elapsed: number) => OrderPoll) {
    let local = T + skewMs;
    const start = local;
    const said: string[] = [];
    let polls = 0;
    return {
      said,
      polls: () => polls,
      deps: {
        now: () => local,
        sleep: async (ms: number) => {
          local += ms;
        },
        poll: async () => {
          polls += 1;
          return script(local - start);
        },
        alive: () => true,
        say: (line: string) => said.push(line),
      },
    };
  }
  // Fills at nine minutes — inside the window and grace, as the server sees it.
  const fillsLate = (elapsed: number): OrderPoll =>
    elapsed < 9 * MIN ? { state: "running" } : { state: "done", result: "bought 25.00 USDG of TSLA" };

  for (const skew of [11 * MIN, 3 * MIN, -7 * MIN]) {
    it(`a browser clock ${skew / MIN} min off still hears the fill`, async () => {
      const h = skewed(skew, fillsLate);
      await followOrder("a1", WINDOW_MS, h.deps);
      assert.deepEqual(h.said, ["bought 25.00 USDG of TSLA"]);
    });
  }

  it("and asks exactly as often whatever the skew", async () => {
    const counts = await Promise.all(
      [0, 11 * MIN, -30 * MIN].map(async (skew) => {
        const h = skewed(skew, () => ({ state: "running" }));
        await followOrder("a1", WINDOW_MS, h.deps);
        return h.polls();
      }),
    );
    assert.ok(counts[0]! > 0);
    assert.deepEqual(counts, [counts[0], counts[0], counts[0]]);
  });
});

describe("what the card takes from the POST", () => {
  it("THE DURATION, never the server's epoch", () => {
    assert.equal(followWindowMs({ id: "a1", expiresAt: EXPIRES, expiresInMs: WINDOW_MS }), WINDOW_MS);
    // A reply with only the epoch is not something this clock can use.
    assert.equal(followWindowMs({ id: "a1", expiresAt: EXPIRES }), null);
  });

  it("and only a real, non-negative number", () => {
    for (const bad of [null, undefined, {}, { expiresInMs: "495000" }, { expiresInMs: Number.NaN }, { expiresInMs: -1 }]) {
      assert.equal(followWindowMs(bad), null, JSON.stringify(bad));
    }
    assert.equal(followWindowMs({ expiresInMs: 0 }), 0);
  });
});

describe("the screen going away", () => {
  it("stops the poll and says nothing — even when the answer lands afterwards", async () => {
    let live = true;
    let goneAt = 0;
    const h = harness(
      (at) => {
        if (at > T + MIN && live) {
          live = false;
          goneAt = at;
        }
        return at > T + 2 * MIN ? { state: "done", result: "bought 25.00 USDG of TSLA" } : { state: "queued" };
      },
      () => live,
    );
    await followOrder("a1", WINDOW_MS, h.deps);
    assert.deepEqual(h.said, [], "nothing is said into a screen that has gone");
    assert.ok(h.polls.every((p) => p <= goneAt), "and nothing is asked after it went");
  });
});
