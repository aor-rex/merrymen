/**
 * THE BRAIN REMEMBERS WHAT IT DID, NOT WHAT IT KEPT SAYING.
 *
 * Its memory was the agent's last six published rows. A Trencher reviews every
 * thirty seconds, so those six were its own holds from the last three minutes:
 * it was shown a template ("edge unclear, so hold") and repeated it. What an
 * agent learns from is what it actually did and how that ended, plus where it
 * last stood on each name — so memory is now the last few LANDED trades with
 * their results, and the latest view per name, one line each.
 *
 * Every line is still rendered from gated output only (brain-material.test.ts
 * pins that), and a result is shown only when it was read — never a 0%.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryLines } from "./brain-material";
import type { PublicThesis } from "./thesis-policy";

const NOW = 1_800_000_000;
const post = (over: Partial<PublicThesis> = {}): PublicThesis => ({
  name: "Shogun",
  slug: null,
  handle: null,
  head: "hold CASHCAT (TA151B4A9E1B)",
  action: "hold",
  symbol: "TA151B4A9E1B",
  sizeUsdg: null,
  paper: false,
  outcome: "view",
  outcomeText: "held — no trade, by choice",
  shadow: false,
  reason: "Edge unclear, so hold.",
  post: null,
  said: 1,
  at: NOW - 60,
  firstAt: NOW - 60,
  ...over,
});
const trade = (i: number, over: Partial<PublicThesis> = {}) =>
  post({
    head: `buy COIN${i} (T0000000000${i}) 5.00 USDG`,
    action: "buy",
    symbol: `T0000000000${i}`,
    sizeUsdg: 5,
    outcome: "landed",
    outcomeText: "landed",
    reason: `Entry ${i}: flow turned.`,
    at: NOW - 3600 * (i + 1),
    firstAt: NOW - 3600 * (i + 1),
    ...over,
  });

/** A Trencher's feed: a hold every thirty seconds across three coins, newest first. */
const chatter = Array.from({ length: 30 }, (_, i) =>
  post({ symbol: `TAAAAAAAAAA${i % 3}`, head: `hold TAAAAAAAAAA${i % 3}`, reason: `Review ${i}: edge unclear, so hold.`, at: NOW - 30 * i }),
);

describe("memory is what the agent did, and where it last stood", () => {
  it("THE LANDED TRADES SURVIVE THIRTY NEWER HOLDS — and only the last three of them", () => {
    const lines = memoryLines([...chatter, trade(1), trade(2), trade(3), trade(4)], NOW);
    const trades = lines.filter((l) => /Entry \d/.test(l));
    assert.equal(trades.length, 3);
    assert.ok(trades.some((l) => l.includes("Entry 1")) && trades.some((l) => l.includes("Entry 3")));
    assert.ok(!lines.some((l) => l.includes("Entry 4")), "the fourth-newest trade is left out");
  });

  it("ONE LINE PER NAME for views — its latest, not its last ten repeats", () => {
    const lines = memoryLines(chatter, NOW);
    const views = lines.filter((l) => l.includes("hold TAAAAAAAAAA"));
    assert.equal(views.length, 3, "three coins, three lines");
    for (const coin of ["TAAAAAAAAAA0", "TAAAAAAAAAA1", "TAAAAAAAAAA2"]) {
      assert.equal(views.filter((l) => l.includes(coin)).length, 1, coin);
    }
    assert.ok(lines.some((l) => l.includes("Review 0:")), "the newest word on the first coin");
    assert.ok(!lines.some((l) => l.includes("Review 3:")), "not an older repeat of it");
  });

  it("A NAME REVIEWED TEN TIMES IN A ROW IS STILL ONE LINE, and the next names get theirs", () => {
    // The held coin is reviewed on every pass, so its holds are the newest ten.
    const held = Array.from({ length: 10 }, (_, i) =>
      post({ symbol: "TBBBBBBBBBBB", head: "hold TBBBBBBBBBBB", reason: `Held review ${i}.`, at: NOW - 10 * i }));
    const lines = memoryLines([...held, ...chatter.map((t) => ({ ...t, at: t.at - 600 }))], NOW);
    assert.equal(lines.filter((l) => l.includes("TBBBBBBBBBBB")).length, 1);
    assert.equal(lines.length, 3, "the held coin and two other names");
  });

  it("a refused or pending trade is not remembered as a trade", () => {
    const lines = memoryLines(
      [trade(1, { outcome: "refused", outcomeText: "the drawdown breaker was tripped" }), trade(2, { outcome: "pending", outcomeText: "no trade came of it" })],
      NOW,
    );
    assert.deepEqual(lines, []);
  });

  it("A CLOSED TRADE CARRIES ITS RESULT, when the result was read", () => {
    const [line] = memoryLines([trade(1, { action: "sell", head: "sell COIN1 (T00000000001) 6.50 USDG", realizedPct: 30 })], NOW);
    assert.match(line!, /landed, \+30\.0% realized/);
    const [loss] = memoryLines([trade(1, { action: "sell", realizedPct: -12.345 })], NOW);
    assert.match(loss!, /-12\.3% realized/);
  });

  it("AND NOTHING when it was not — never a 0%", () => {
    const [line] = memoryLines([trade(1, { action: "sell", realizedPct: null })], NOW);
    assert.doesNotMatch(line!, /%/);
    const [older] = memoryLines([trade(1, { action: "sell" })], NOW);
    assert.doesNotMatch(older!, /%/, "a post from an older server has no figure either");
  });

  it("an open buy carries what it paid, so the next call can compare", () => {
    const [line] = memoryLines([trade(1, { entryPriceUsd: 0.00042 })], NOW);
    assert.match(line!, /landed at 0\.00042 USD/);
  });

  it("newest first across both, and bounded", () => {
    const lines = memoryLines([...chatter, trade(1), trade(2), trade(3), trade(4)], NOW);
    assert.equal(lines.length, 6, "three trades and three names");
    assert.match(lines[0]!, /Review 0:/, "the newest thing it said leads");
    assert.match(lines.at(-1)!, /Entry 3/, "the oldest remembered trade ends it");
  });
});
