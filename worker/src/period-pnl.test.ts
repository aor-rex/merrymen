/**
 * Step-by-step attribution of an account's change (period-pnl.ts).
 *
 * The scenarios are the ones that made a single "change minus flows" figure
 * lie: an opening balance booked again at a restart, a deposit made while the
 * agent was down and booked by nobody, a fill at the very second of a mark, a
 * practice book that must never take real money's flows — and the join across
 * a redeploy between the shared ledger's record and the child's own.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { accountSeries, attributeBook, periodChange, stepAttribution, type AccountPoint, type BookMark } from "./period-pnl";

const mark = (at: number, equity: number, cash: number): BookMark => ({ at, equity, cash });

function over(marks: BookMark[], flows: { at: number; signed: number; evidenced: boolean }[], trades: number[], o = 0, c = marks.length - 1) {
  const cum = attributeBook(marks, flows, trades);
  const change = marks[c]!.equity - marks[o]!.equity;
  const f = cum[c]!.flows - cum[o]!.flows;
  const u = cum[c]!.unattributed - cum[o]!.unattributed;
  const r = (n: number) => Math.round(n * 1e6) / 1e6;
  return { change: r(change), flows: r(f), unattributed: r(u), trading: r(change - f - u) };
}

describe("stepAttribution / attributeBook", () => {
  it("an opening balance booked again with no cash behind it is dropped, never a trading loss", () => {
    const m = [mark(100, 100, 60), mark(200, 101, 60), mark(900, 102, 60)];
    assert.deepEqual(over(m, [{ at: 850, signed: 100, evidenced: false }], []), { change: 2, flows: 0, unattributed: 0, trading: 2 });
  });

  it("a deposit nobody booked (made while the agent was down) is unattributed, not profit", () => {
    const m = [mark(100, 100, 60), mark(200, 100, 60), mark(900, 151, 110), mark(960, 150, 110)];
    assert.deepEqual(over(m, [], []), { change: 50, flows: 0, unattributed: 51, trading: -1 });
  });

  it("an inferred deposit the balance really made counts as money put in", () => {
    const m = [mark(100, 100, 60), mark(160, 125, 85)];
    assert.deepEqual(over(m, [{ at: 160, signed: 25, evidenced: false }], []), { change: 25, flows: 25, unattributed: 0, trading: 0 });
  });

  it("a price move with cash flat is trading and price moves", () => {
    const m = [mark(100, 100, 60), mark(900, 108, 60)];
    assert.deepEqual(over(m, [], []), { change: 8, flows: 0, unattributed: 0, trading: 8 });
  });

  it("a fill at the previous mark's second belongs to the step after it; a flow at a mark's second to the step it ends", () => {
    const m = [mark(100, 100, 60), mark(160, 99.5, 50)];
    assert.deepEqual(over(m, [], [100]), { change: -0.5, flows: 0, unattributed: 0, trading: -0.5 });
    assert.deepEqual(over(m, [], [160]), { change: -0.5, flows: 0, unattributed: -0.5, trading: 0 }, "a trade AT the closing mark is the next step's");
    const d = [mark(100, 100, 60), mark(160, 110, 70)];
    assert.deepEqual(over(d, [{ at: 100, signed: 10, evidenced: true }], []).unattributed, 10, "a flow at the opening mark is already inside it");
    assert.deepEqual(over(d, [{ at: 160, signed: 10, evidenced: true }], []).flows, 10);
  });

  it("an evidenced deposit and an unbooked one: the receipt counts, the rest is unattributed", () => {
    const m = [mark(100, 100, 60), mark(900, 130, 90)];
    assert.deepEqual(over(m, [{ at: 500, signed: 10, evidenced: true }], []), { change: 30, flows: 10, unattributed: 20, trading: 0 });
  });

  it("within tolerance is rounding, not money", () => {
    assert.deepEqual(stepAttribution(mark(0, 10, 10), mark(1, 10.004, 10.004), [], false), { flows: 0, unattributed: 0 });
  });

  it("the identity holds for any series: change = flows + unattributed + trading", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 50; run++) {
      const marks: BookMark[] = [];
      let at = 0;
      let cash = 100;
      let eq = 100;
      for (let i = 0; i < 20; i++) {
        at += 1 + Math.floor(rnd() * 100);
        cash += rnd() < 0.3 ? Math.round((rnd() - 0.5) * 40) : 0;
        eq = cash + rnd() * 20;
        marks.push(mark(at, eq, cash));
      }
      const flows = Array.from({ length: 5 }, () => ({ at: Math.floor(rnd() * at), signed: Math.round((rnd() - 0.5) * 30), evidenced: rnd() < 0.5 }));
      const trades = Array.from({ length: 4 }, () => Math.floor(rnd() * at));
      const r = over(marks, flows, trades, Math.floor(rnd() * 10), 10 + Math.floor(rnd() * 10));
      assert.ok(Math.abs(r.change - r.flows - r.unattributed - r.trading) < 1e-5); // each part rounded to 1e-6
    }
  });
});

describe("accountSeries across a restart", () => {
  const carried = (at: number, equity: number, cash: number, flows = 0, unattributed = 0, book: AccountPoint["book"] = "live") => ({ at, equity, cash, flows, unattributed, book });

  it("joins the carried record to this ledger's, and a deposit made while down is unattributed", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60), carried(2000, 102, 60, 0, 0)],
      carriedTail: [],
      local: [{ at: 5000, equity: 153, cash: 110, book: "live" }, { at: 5100, equity: 154, cash: 110, book: "live" }],
      localFlows: [],
      tradeTimes: { paper: [], live: [] },
    });
    const pc = periodChange(series, 1500);
    assert.equal(pc.kind, "change");
    if (pc.kind !== "change") return;
    assert.equal(pc.open.at, 1000);
    assert.equal(pc.open.carried, true);
    assert.equal(pc.close.at, 5100);
    assert.deepEqual([pc.change, pc.flows, pc.unattributed, Math.round(pc.trading * 1e6) / 1e6], [54, 0, 51, 3]);
  });

  it("an opening balance the new run booked again at the restart is dropped", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60)],
      carriedTail: [],
      local: [{ at: 5000, equity: 101, cash: 60, book: "live" }],
      localFlows: [{ at: 4999, signed: 100, evidenced: false }],
      tradeTimes: { paper: [], live: [] },
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.change, pc.flows, pc.unattributed, pc.trading], [1, 0, 0, 1]);
  });

  it("a trade the old run made just before shutting down explains the cash across the seam", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60)],
      carriedTail: [{ book: "live", evidenced: 0, unevidenced: 0 }],
      local: [{ at: 5000, equity: 99, cash: 40, book: "live" }],
      localFlows: [],
      tradeTimes: { paper: [], live: [1500] },
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.flows, pc.unattributed, pc.trading], [0, 0, -1]);
  });

  it("a deposit booked after the old run's last mark rides the tail into the seam", () => {
    const series = accountSeries({
      carried: [carried(1000, 100, 60, 5, 0)],
      carriedTail: [{ book: "live", evidenced: 20, unevidenced: 0 }],
      local: [{ at: 5000, equity: 120, cash: 80, book: "live" }],
      localFlows: [],
      tradeTimes: { paper: [], live: [] },
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.change, pc.flows, pc.unattributed, pc.trading], [20, 20, 0, 0]);
  });

  it("a practice book takes no flows, and switching books is not a change", () => {
    const series = accountSeries({
      carried: [],
      carriedTail: [],
      local: [
        { at: 100, equity: 1000, cash: 1000, book: "paper" },
        { at: 200, equity: 1010, cash: 1000, book: "paper" },
      ],
      localFlows: [{ at: 150, signed: 500, evidenced: true }],
      tradeTimes: { paper: [], live: [] },
    });
    const pc = periodChange(series, 0);
    assert.ok(pc.kind === "change");
    if (pc.kind === "change") assert.deepEqual([pc.flows, pc.trading], [0, 10]);
    const switched = accountSeries({
      carried: [carried(100, 1000, 1000, 0, 0, "paper")],
      carriedTail: [],
      local: [{ at: 5000, equity: 50, cash: 50, book: "live" }],
      localFlows: [],
      tradeTimes: { paper: [], live: [] },
    });
    assert.equal(periodChange(switched, 0).kind, "switched");
    assert.equal(periodChange([], 0).kind, "none");
  });
});
