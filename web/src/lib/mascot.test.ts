import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mascotMood } from "./mascot";

/**
 * The mascot is the one purely decorative thing on this page, which is exactly
 * why it needs a test.
 *
 * A little figure that animates "thinking" on a CSS loop would look identical
 * whether the worker was reasoning about the market or had been dead for a
 * week. On a console whose entire pitch is that you can see what the agent is
 * really doing, that is not a harmless flourish — it is the same failure as
 * reporting a virtual seed as depth, in a place nobody would think to check.
 *
 * So every mood is a fact with a clock behind it, and these pin that.
 */
const NOW = 1_700_000_000_000;
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString().replace("T", " ").replace("Z", "");

describe("mascotMood", () => {
  it("draws the bow only when a trade actually landed", () => {
    const m = mascotMood({ mode: "live", lastEventAt: at(10), lastTradeAt: at(30), now: NOW });
    assert.equal(m.mood, "loosed");
  });

  it("thinks only when the worker wrote to the ledger just now", () => {
    const m = mascotMood({ mode: "live", lastEventAt: at(20), lastTradeAt: at(9999), now: NOW });
    assert.equal(m.mood, "thinking");
  });

  it("RESTS rather than thinks when the last tick is old", () => {
    // The common case, and the one an always-animating mascot would lie about:
    // alive, but nothing has happened for a while.
    const m = mascotMood({ mode: "live", lastEventAt: at(600), lastTradeAt: at(9999), now: NOW });
    assert.equal(m.mood, "resting");
    assert.match(m.say, /watching/);
  });

  it("says paper when it is trading on paper", () => {
    const m = mascotMood({ mode: "paper", lastEventAt: at(600), lastTradeAt: undefined, now: NOW });
    assert.match(m.say, /paper/);
  });

  it("sleeps when the worker is not running", () => {
    const m = mascotMood({ mode: "idle", lastEventAt: undefined, lastTradeAt: undefined, now: NOW });
    assert.equal(m.mood, "asleep");
    assert.match(m.say, /not running/);
  });

  it("treats an unreadable timestamp as no signal, not as now", () => {
    // A parse failure returning 0 would read as "one millisecond ago" and pin
    // him permanently to thinking.
    const m = mascotMood({ mode: "live", lastEventAt: "not a date", lastTradeAt: "", now: NOW });
    assert.equal(m.mood, "resting");
  });

  it("a landed trade beats a fresh tick", () => {
    const m = mascotMood({ mode: "live", lastEventAt: at(1), lastTradeAt: at(2), now: NOW });
    assert.equal(m.mood, "loosed");
  });
});
