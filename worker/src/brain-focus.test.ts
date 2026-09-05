/**
 * A COHORT OF ONE, PRODUCED BY A SORT THAT RETURNED UNDEFINED.
 *
 * The focus was "the largest holding", which quietly means Brain is only ever
 * asked whether to keep or trim what it already has. An all-cash agent has no
 * largest holding, so the block was skipped and it was never asked anything.
 *
 * Measured on the live fleet: 24 agents, exactly one with a position and
 * therefore shadowable; three more with evidenced capital, no holdings, and no
 * question in front of them. The interesting question — is anything worth
 * opening? — is precisely the one whose answer is a BUY.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STOCK_TOKENS } from "../../packages/core/src/index";
import { chooseFocus, focusLabel, type HeldPosition, type QuotedPrice } from "./brain-focus";

const TSLA = STOCK_TOKENS.find((t) => t.symbol === "TSLA")!;
const NVDA = STOCK_TOKENS.find((t) => t.symbol === "NVDA")!;
const POOLY = { symbol: "PONS", address: "0x1111111111111111111111111111111111111111" };

const q = (over: Partial<QuotedPrice> = {}): QuotedPrice => ({
  price8: 41_250_000_000n,
  stale: false,
  source: "chainlink",
  ...over,
});

const held = (over: Partial<HeldPosition> = {}): HeldPosition => ({
  symbol: "TSLA",
  token: TSLA.address,
  valueUsdg: 6_500_000,
  price8: 41_250_000_000n,
  priceStale: false,
  priceSource: "chainlink",
  ...over,
});

describe("a real exposure always wins", () => {
  it("picks the largest holding and marks it held", () => {
    const f = chooseFocus({
      positions: [held({ symbol: "NVDA", token: NVDA.address, valueUsdg: 1_000_000 }), held({ valueUsdg: 9_000_000 })],
      universe: [POOLY],
      prices: new Map([["PONS", q({ source: "pool" })]]),
      paused: new Set(),
    });
    assert.equal(f!.symbol, "TSLA");
    assert.equal(f!.held, true);
    assert.equal(f!.heldUsdg, 9_000_000);
  });

  it("is not displaced by a candidate, however attractive", () => {
    // An existing exposure is a live risk; a hypothetical opening is not.
    const f = chooseFocus({
      positions: [held({ priceStale: true })],
      universe: [POOLY],
      prices: new Map([["PONS", q({ source: "pool" })]]),
      paused: new Set(),
    });
    assert.equal(f!.symbol, "TSLA", "a stale holding still beats a fresh candidate");
    assert.equal(f!.held, true);
  });

  it("ignores a dust position with no value", () => {
    const f = chooseFocus({
      positions: [held({ valueUsdg: 0 })],
      universe: [{ symbol: "NVDA", address: NVDA.address }],
      prices: new Map([["NVDA", q()]]),
      paused: new Set(),
    });
    assert.equal(f!.symbol, "NVDA");
    assert.equal(f!.held, false, "a zero-value row is not an exposure");
  });
});

describe("an all-cash agent finally gets asked something", () => {
  it("offers a candidate from its own configured universe", () => {
    const f = chooseFocus({
      positions: [],
      universe: [{ symbol: "NVDA", address: NVDA.address }],
      prices: new Map([["NVDA", q()]]),
      paused: new Set(),
    });
    assert.equal(f!.symbol, "NVDA");
    assert.equal(f!.held, false);
    assert.equal(f!.heldUsdg, 0);
    assert.match(focusLabel(f!), /candidate — the book holds none of it/);
  });

  it("REFUSES to open on a bonding-curve quote", () => {
    // `PriceQuote.source` says it plainly: a curve quote is "good enough to
    // value something already held; it is not good enough to authorise a new
    // buy". Offering one as an opening candidate would launder that.
    const f = chooseFocus({
      positions: [],
      universe: [POOLY],
      prices: new Map([["PONS", q({ source: "curve" })]]),
      paused: new Set(),
    });
    assert.equal(f, null, "no candidate is better than one nobody may act on");
  });

  it("skips a paused token and an unpriced one", () => {
    assert.equal(
      chooseFocus({
        positions: [],
        universe: [{ symbol: "NVDA", address: NVDA.address }],
        prices: new Map([["NVDA", q()]]),
        paused: new Set(["NVDA"]),
      }),
      null,
    );
    assert.equal(
      chooseFocus({ positions: [], universe: [{ symbol: "NVDA", address: NVDA.address }], prices: new Map(), paused: new Set() }),
      null,
      "an instrument nobody can value is a guess, not a question",
    );
    assert.equal(
      chooseFocus({
        positions: [],
        universe: [{ symbol: "NVDA", address: NVDA.address }],
        prices: new Map([["NVDA", q({ price8: 0n })]]),
        paused: new Set(),
      }),
      null,
    );
  });

  it("does NOT exclude a stale candidate — it prefers against it", () => {
    // Brain refuses on a stale price by itself, and watching it do so is the
    // observation. Excluding the instrument would hide the reasoning and
    // silently re-create the empty cohort every evening.
    const f = chooseFocus({
      positions: [],
      universe: [{ symbol: "TSLA", address: TSLA.address }],
      prices: new Map([["TSLA", q({ stale: true })]]),
      paused: new Set(),
    });
    assert.equal(f!.symbol, "TSLA");
    assert.equal(f!.priceStale, true);
  });

  it("prefers fresh over stale, then continuous over market-hours", () => {
    const f = chooseFocus({
      positions: [],
      universe: [{ symbol: "TSLA", address: TSLA.address }, POOLY],
      prices: new Map([
        ["TSLA", q({ stale: true })],
        ["PONS", q({ source: "pool" })],
      ]),
      paused: new Set(),
    });
    assert.equal(f!.symbol, "PONS", "fresh beats stale");

    const g = chooseFocus({
      positions: [],
      universe: [{ symbol: "TSLA", address: TSLA.address }, POOLY],
      prices: new Map([
        ["TSLA", q()],
        ["PONS", q({ source: "pool" })],
      ]),
      paused: new Set(),
    });
    assert.equal(g!.symbol, "PONS", "both fresh, so the one observable at any hour wins");
  });

  it("is stable across identical ticks", () => {
    // A focus that moved for a reason absent from the evidence would make the
    // decision tape unreadable: two runs would differ and nothing would say why.
    const args = {
      positions: [] as HeldPosition[],
      universe: [{ symbol: "NVDA", address: NVDA.address }, { symbol: "TSLA", address: TSLA.address }],
      prices: new Map([
        ["NVDA", q()],
        ["TSLA", q()],
      ]),
      paused: new Set<string>(),
    };
    assert.equal(chooseFocus(args)!.symbol, chooseFocus(args)!.symbol);
    assert.equal(chooseFocus(args)!.symbol, "NVDA", "alphabetical, so it is stable rather than incidental");
  });

  it("returns null when the universe is empty", () => {
    assert.equal(chooseFocus({ positions: [], universe: [], prices: new Map(), paused: new Set() }), null);
  });
});
