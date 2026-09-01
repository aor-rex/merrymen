import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * WHAT AN AGENT'S PROFILE IS ALLOWED TO SAY ABOUT IT.
 *
 * Every figure on this page is a claim about ONE NAMED AGENT's skill, which is a
 * stronger thing than the token page says about a market. The route had no test
 * file at all, and the number rank-pnl was written to refuse was shipping here
 * the whole time it was fixed everywhere else.
 *
 * Source scans, in the idiom of the token page's: these are properties of how
 * the page is written, and a render test passes on a branch that has not been
 * reached yet.
 */

const at = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

/**
 * The same source with comments removed.
 *
 * Every "must not contain" assertion runs against this, because the codebase
 * explains its refusals at length right where it makes them — and a comment
 * describing the arithmetic being refused would otherwise fail the test
 * forbidding that arithmetic, teaching the next person to delete the
 * explanation rather than keep the rule.
 */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const PAGE = at("./page.tsx");
const READ = at("../../../lib/read-agent.ts");
const READ_CODE = code(READ);
const GROWTH = at("../../../lib/growth-index.ts");
const TAPE = at("../../../lib/read-wall-tape.ts");

describe("a return is published under one rule, not two", () => {
  it("the profile uses the same gate as the leaderboard", () => {
    // These computed the identical arithmetic and disagreed about when to show
    // it: the board called an agent unranked while its own profile published a
    // figure, for the same agent on the same data at the same moment.
    assert.match(READ, /import \{ rankPnl/);
    assert.match(READ, /rankPnl\(\{ contributed, latest, gasUsdg, landed \}\)/);
  });

  it("no second copy of the P&L arithmetic survives", () => {
    // The bug was a duplicate of a formula, not a wrong formula. A second copy
    // is how the two surfaces drifted apart in the first place.
    assert.ok(
      !/latest - contributed - gasUsdg\) \/ contributed/.test(READ_CODE),
      "the return may only be computed inside rankPnl",
    );
  });

  it("says WHICH refusal applies, rather than assuming one", () => {
    // It printed "no deposit on record" for every null, including for an agent
    // that had funded and simply never filled anything.
    assert.match(READ, /unrankedWhy/);
    // Both arms must be reachable and distinguishable. The receiver's name is
    // free to change; that BOTH reasons are branched on is the property.
    assert.match(PAGE, /unrankedWhy === "no-deposit"/);
    assert.match(PAGE, /unrankedWhy === "never-filled"/);
    assert.match(PAGE, /no deposit on record/);
    assert.match(PAGE, /nothing has filled yet/);
    assert.ok(
      !/pnlBps === null \? "no deposit on record"/.test(code(PAGE)),
      "a fixed reason cannot be right for both refusals",
    );
  });
});

describe("a drawdown is not the owner moving money", () => {
  it("is measured on the growth index, never the equity line", () => {
    // equity_usdg is a balance reading: it falls when the owner withdraws, and
    // a drawdown taken from it reports that as the agent losing money.
    assert.match(READ, /drawdownBps\(growthFull\)/);
    assert.ok(
      !/drawdownBps\(curve\)/.test(READ_CODE),
      "the raw equity curve must never reach the drawdown",
    );
  });

  it("is refused whenever the return is", () => {
    // An agent that has never filled has produced no drawdown either, and the
    // figure it showed came from a paper book's flat opening balance.
    assert.match(READ, /unrankedWhy === null \? drawdownBps/);
  });

  it("is measured before the series is thinned", () => {
    // One reading in nine cannot see a trough between two kept samples, so a
    // drawdown taken from the decimated series is understated by construction.
    assert.match(READ, /growthFull = growthIndex\(clean, flows\)/);
  });

  it("the growth module divides each period's flow out", () => {
    assert.match(GROWTH, /export function growthIndex/);
    assert.match(GROWTH, /p\.v - flow\) \/ prev/);
    // No imports, for the reason rank-pnl has none: a rule buried in a database
    // read is a rule nobody can test.
    assert.ok(!/^import /m.test(GROWTH), "growth-index must stay dependency-free");
  });
});

describe("the chart and the figure above it measure the same thing", () => {
  it("always keeps the newest reading", () => {
    // A plain modulo anchors on index 0, so the last few readings never reached
    // the chart and its right-hand end was not the value the headline divides.
    // The downsample must admit the final index explicitly, however it is
    // spelled — a bare modulo anchors on 0 and can only keep the last reading
    // by luck of the arithmetic.
    assert.match(READ_CODE, /% step === 0 \|\| .*length - 1/);
  });
});

describe("the wall says which rule stopped it", () => {
  it("carries a per-lane tally, not just the labels", () => {
    // The tally already existed — it is what orders the lanes — and was thrown
    // away one line after it was built.
    assert.match(TAPE, /laneCounts: number\[\]/);
    assert.match(TAPE, /if \(fate === "turned"\) laneCounts\[lane\] \+= 1;/);
  });

  it("records that the tally is of the SAMPLE, not the window", () => {
    // counts is the whole window; laneCounts is the drawn sample, capped at the
    // most recent 400. They do not sum when capped is true, so a consumer that
    // published these as totals would print a breakdown visibly disagreeing
    // with the headline three lines above it. The docstring is the only thing
    // standing between the two, so it is pinned.
    assert.match(TAPE, /OVER THE DRAWN SAMPLE, NOT THE WINDOW/);
  });
});
