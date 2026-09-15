import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { growthIndex, drawdownBps, type EquityPoint, type Flow } from "./growth-index";

/**
 * The profile drew a chart and a drawdown off the raw equity line, which moves
 * when the OWNER moves money. These pin the correction.
 */

const p = (at: number, v: number): EquityPoint => ({ at, v });
const f = (at: number, signed: number): Flow => ({ at, signed });

const near = (a: number | null, b: number, tol = 1e-9) => {
  assert.ok(a !== null, "expected a value");
  assert.ok(Math.abs(a - b) < tol, `${a} is not within ${tol} of ${b}`);
};

describe("a deposit is not a gain", () => {
  it("holds the index flat when the whole rise was funding", () => {
    // 100 in the book, the owner adds 100, the book does nothing. The equity
    // line doubles. The agent did not.
    const g = growthIndex([p(1, 100), p(2, 200)], [f(2, 100)]);
    near(g[1]!, 1);
  });

  it("still measures a real gain that happened alongside a deposit", () => {
    // 100 in, owner adds 100, and the book earns 10 in the same period: the
    // reading is 210, of which only the 10 is the agent's doing.
    const g = growthIndex([p(1, 100), p(2, 210)], [f(2, 100)]);
    near(g[1]!, 1.1);
  });

  it("does not read a withdrawal as a loss", () => {
    // This is the one that made the profile lie: the owner takes half out and
    // the drawdown reported 50%.
    const g = growthIndex([p(1, 100), p(2, 50)], [f(2, -50)]);
    near(g[1]!, 1);
    assert.equal(drawdownBps(g), 0);
  });
});

describe("a real loss is still a loss", () => {
  it("compounds an actual fall", () => {
    const g = growthIndex([p(1, 100), p(2, 90), p(3, 81)], []);
    near(g[1]!, 0.9);
    near(g[2]!, 0.81);
  });

  it("reports the peak-to-trough on the growth index", () => {
    // Up to 1.2, down to 0.9: a 25% fall from the peak, not 10% from the start.
    const g = growthIndex([p(1, 100), p(2, 120), p(3, 90)], []);
    assert.equal(drawdownBps(g), 2500);
  });
});

describe("the openings that have no denominator", () => {
  it("treats the first deposit as funding, not an infinite return", () => {
    // An account opens at zero and is funded. (E - F) / 0 is not a return; it
    // is the moment there started to be a book at all.
    const g = growthIndex([p(1, 0), p(2, 500)], [f(2, 500)]);
    assert.equal(g[0], 1);
    near(g[1]!, 1);
    assert.ok(g.every(Number.isFinite), "no infinities may reach the chart");
  });

  it("carries the index through a reading it cannot use", () => {
    // A period that would compute a non-positive ratio told us nothing. Saying
    // so beats zeroing the entire series from that point on.
    const g = growthIndex([p(1, 100), p(2, 0), p(3, 100)], []);
    assert.ok(g.every((v) => Number.isFinite(v) && v > 0));
  });

  it("survives an empty history and a single reading", () => {
    assert.deepEqual(growthIndex([], []), []);
    assert.deepEqual(growthIndex([p(1, 100)], []), [1]);
    assert.equal(drawdownBps([]), null);
    assert.equal(drawdownBps([1]), null);
  });
});

describe("flows are counted once and in order", () => {
  it("never applies a flow to two periods", () => {
    const flows = [f(2, 100)];
    const g = growthIndex([p(1, 100), p(2, 200), p(3, 200)], flows);
    near(g[1]!, 1);
    near(g[2]!, 1); // the deposit must not be subtracted a second time
  });

  it("applies several flows inside one period together", () => {
    const g = growthIndex([p(1, 100), p(4, 300)], [f(2, 150), f(3, 50)]);
    near(g[1]!, 1);
  });

  it("ignores a flow recorded after the last reading", () => {
    // It has not shown up in a balance yet, so it cannot be divided out of one.
    const g = growthIndex([p(1, 100), p(2, 110)], [f(99, 1000)]);
    near(g[1]!, 1.1);
  });
});
