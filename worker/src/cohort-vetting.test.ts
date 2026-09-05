/**
 * PICKING A COHORT FROM BALANCES IS HOW YOU LEARN NOTHING.
 *
 * The first shadow cohort was one agent, and it spent a day producing forced
 * holds: its book could not be sized, so every model call bought an outcome
 * that was decided before the analysts ran. An agent with capital and no
 * evidenced contributions is exactly that trap, and it looks like a good
 * candidate from the outside.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STOCK_TOKENS } from "../../packages/core/src/index";
import { cohortLines, vetCandidate, type CandidateInput, type CandidatePosition } from "./cohort-vetting";

const NOW = 1_788_600_000;
const EQUITY_TOKEN = STOCK_TOKENS.find((t) => t.kind === "stock")!;
const POOL_TOKEN = "0x1111111111111111111111111111111111111111";

const pos = (over: Partial<CandidatePosition> = {}): CandidatePosition => ({
  symbol: EQUITY_TOKEN.symbol,
  token: EQUITY_TOKEN.address,
  valueUsdg: 6_500_000,
  priceStale: false,
  priceSource: "chainlink",
  updatedAt: NOW - 60,
  ...over,
});

const cand = (over: Partial<CandidateInput> = {}): CandidateInput => ({
  account: "0xabcdef0123456789",
  name: "Much",
  epoch: 1,
  mode: "live",
  beatAt: NOW - 30,
  netContributionsUsdg: 10_000_000,
  legacyRows: 0,
  positions: [pos()],
  landedTrades: 4,
  decisions: 12,
  ...over,
});

describe("a candidate has to clear the gate before it is worth a model call", () => {
  it("accepts a live, funded, freshly-priced agent", () => {
    const v = vetCandidate(cand(), NOW);
    assert.equal(v.verdict, "READY");
    assert.equal(v.focus!.symbol, EQUITY_TOKEN.symbol);
    assert.equal(v.focusClass, "equity-token");
  });

  it("rejects capital with no evidenced contributions — the trap", () => {
    // The whole reason this module exists. Money in the account, nothing on
    // record about where it came from, so `computePnl` refuses, `may_size` is
    // false, and every decision is a forced hold decided before the analysts ran.
    const v = vetCandidate(cand({ netContributionsUsdg: 0 }), NOW);
    assert.equal(v.verdict, "BLOCKED-NO-CAPITAL");
    assert.match(v.why, /nothing can be sized against it/);
  });

  it("tells a zero we measured from a question we failed to ask", () => {
    assert.equal(vetCandidate(cand({ netContributionsUsdg: null }), NOW).verdict, "BLOCKED-CONTRIBUTIONS-UNKNOWN");
  });

  it("rejects a book holding pre-cutover rows", () => {
    assert.equal(vetCandidate(cand({ legacyRows: 3 }), NOW).verdict, "BLOCKED-LEGACY-HISTORY");
  });

  it("rejects an agent that is not running", () => {
    assert.equal(vetCandidate(cand({ beatAt: NOW - 4000 }), NOW).verdict, "BLOCKED-IDLE");
    assert.equal(vetCandidate(cand({ beatAt: null }), NOW).verdict, "BLOCKED-IDLE");
  });

  it("rejects an empty book — no position, no question", () => {
    assert.equal(vetCandidate(cand({ positions: [] }), NOW).verdict, "BLOCKED-NO-POSITION");
    assert.equal(vetCandidate(cand({ positions: [pos({ valueUsdg: 0 })] }), NOW).verdict, "BLOCKED-NO-POSITION");
  });

  it("checks the reasons in the order they actually bite", () => {
    // An idle agent with unknown contributions and a legacy history reports
    // IDLE: nothing else matters if nothing runs, and reporting the wrong one
    // sends whoever reads it to the wrong place.
    const v = vetCandidate(cand({ beatAt: null, netContributionsUsdg: null, legacyRows: 5 }), NOW);
    assert.equal(v.verdict, "BLOCKED-IDLE");
  });
});

describe("a stale price means two different things", () => {
  it("a shut equity market is NOT a blocked agent", () => {
    // TSLA on a 24/5 Chainlink feed, outside US market hours. The agent is
    // sound and the only thing missing is trading hours — collapsing this into
    // "blocked" would exclude every tokenised equity permanently, which is most
    // of the fleet.
    const v = vetCandidate(cand({ positions: [pos({ priceStale: true })] }), NOW);
    assert.equal(v.verdict, "READY-WHEN-MARKET-OPENS");
    assert.equal(v.focusIsContinuous, false);
    assert.match(v.why, /sound agent, wrong hour/);
  });

  it("a stale pool IS a fault, because that market never closes", () => {
    const v = vetCandidate(
      cand({ positions: [pos({ token: POOL_TOKEN, symbol: "PONS", priceSource: "pool", priceStale: true })] }),
      NOW,
    );
    assert.equal(v.verdict, "BLOCKED-STALE-POOL");
    assert.equal(v.focusIsContinuous, true);
    assert.match(v.why, /stopped being readable/);
  });

  it("marks a fresh pool-priced agent as the one that can be observed at any hour", () => {
    const v = vetCandidate(
      cand({ positions: [pos({ token: POOL_TOKEN, symbol: "PONS", priceSource: "pool" })] }),
      NOW,
    );
    assert.equal(v.verdict, "READY");
    assert.equal(v.focusClass, "memecoin");
    assert.equal(v.focusIsContinuous, true);
    assert.match(v.why, /trades around the clock/);
  });
});

describe("the focus is the position a run would actually be about", () => {
  it("is the largest holding, not the first row", () => {
    const v = vetCandidate(
      cand({
        positions: [
          pos({ symbol: "SMALL", valueUsdg: 1_000_000 }),
          pos({ symbol: "BIG", valueUsdg: 9_000_000 }),
        ],
      }),
      NOW,
    );
    assert.equal(v.focus!.symbol, "BIG");
    assert.equal(v.equityUsdg, 10_000_000, "but equity is the whole book");
  });
});

describe("the report says when a cohort cannot be observed after hours", () => {
  it("warns when nothing in the cohort trades continuously", () => {
    const all = [vetCandidate(cand(), NOW), vetCandidate(cand({ account: "0xb" }), NOW)];
    const text = cohortLines(all).join("\n");
    assert.match(text, /2 READY · 0 of those trade 24\/7/);
    assert.match(text, /the cohort will be idle outside market hours/);
  });

  it("does not warn when one of them does", () => {
    const all = [
      vetCandidate(cand(), NOW),
      vetCandidate(cand({ account: "0xb", positions: [pos({ token: POOL_TOKEN, symbol: "PONS" })] }), NOW),
    ];
    const text = cohortLines(all).join("\n");
    assert.match(text, /1 of those trade 24\/7/);
    assert.ok(!/idle outside market hours/.test(text));
  });
});
