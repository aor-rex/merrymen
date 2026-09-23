/**
 * EVERY CALL, MEASURED FROM WHEN IT WAS MADE — OR NOT AT ALL.
 *
 * The figure under a trade was `<Delta value={tok?.change24hPct}>`: the TOKEN's
 * move over the last day, printed beside the agent's buy, so a reader took the
 * market's 24h for the agent's result. A buy made an hour ago at the day's high
 * showed green; a sell that realized a loss showed whatever the token did next.
 *
 * What replaces it is the call's own number:
 *
 *   a buy   — live price / fill price − 1, "since entry"
 *   a sell  — the return the sell realized, and its dollars ONLY when the
 *             author's book is public (the reader sends null otherwise)
 *   a view  — live price / the mark the author saw − 1, "since posted"
 *
 * and NOTHING when either input was not read. Never 0%: a zero is a claim that
 * something was measured, and an unread fill price is not a measurement.
 *
 * Every case goes through `beatsOf` from a row in the reader's shape, then the
 * function the row renders with, then the rendered row itself.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { beatsOf, callFigure, callFigureText, lanesOf, livePriceOf, type FeedRow, type TradeBeat, type ViewBeat } from "./beat";
import type { LiveAgent, LiveToken } from "./live";

(globalThis as unknown as { React: typeof React }).React = React;

const NOW = 1_790_000_000;

const row = (over: Partial<FeedRow> = {}): FeedRow =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action: "buy",
    symbol: "TSLA",
    sizeUsdg: 5,
    reason: "Adding under its average.",
    paper: false,
    head: "buy TSLA 5.00 USDG",
    outcome: "landed",
    outcomeText: "filled",
    said: 1,
    at: NOW,
    firstAt: NOW,
    unchangedSince: NOW,
    postId: "b".repeat(32),
    ...over,
  }) as FeedRow;

const agents = [
  { slug: "shogun", name: "Shogun", handle: null, owner: null, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "Strategy" }, thesis: "" },
] as unknown as LiveAgent[];

const token = (over: Partial<LiveToken> = {}): LiveToken =>
  ({
    id: "0xtsla",
    symbol: "TSLA",
    name: "Tesla",
    logo: "",
    priceUsd: 220,
    change24hPct: 9.9,
    fdvUsd: null,
    holders: null,
    agents: null,
    buys: null,
    kind: "stock",
    marks: [],
    cast: [],
    ...over,
  }) as LiveToken;

const one = (r: FeedRow): TradeBeat | ViewBeat => {
  const [b] = beatsOf([r], agents);
  assert.ok(b && (b.kind === "trade" || b.kind === "view"));
  return b;
};

async function render(rows: FeedRow[], tokens: LiveToken[]): Promise<string> {
  const { Wire } = await import("./wire");
  return renderToStaticMarkup(createElement(Wire, { lanes: lanesOf(beatsOf(rows, agents)), tokens }));
}

describe("a buy is measured from its fill", () => {
  it("live 220 over a 200 fill is +10% since entry", () => {
    const f = callFigure(one(row({ entryPriceUsd: 200 })), 220);
    assert.ok(f);
    assert.equal(f.basis, "since entry");
    assert.ok(Math.abs(f.pct - 10) < 1e-9);
    assert.equal(f.usd, null, "a buy realized nothing");
  });

  it("NO FILL PRICE READ, NO FIGURE — never 0%", () => {
    assert.equal(callFigure(one(row()), 220), null, "a server from before the field");
    assert.equal(callFigure(one(row({ entryPriceUsd: null })), 220), null);
    assert.equal(callFigure(one(row({ entryPriceUsd: 0 })), 220), null, "a zero price is not a price");
    assert.equal(callFigure(one(row({ entryPriceUsd: Number.NaN })), 220), null);
  });

  it("NO LIVE PRICE READ, NO FIGURE", () => {
    assert.equal(callFigure(one(row({ entryPriceUsd: 200 })), null), null);
    assert.equal(callFigure(one(row({ entryPriceUsd: 200 })), 0), null);
  });

  it("a buy that did not land has no entry to measure from", () => {
    for (const outcome of ["refused", "reverted", "dropped", "pending"] as const) {
      assert.equal(callFigure(one(row({ entryPriceUsd: 200, outcome })), 220), null, outcome);
    }
    assert.equal(callFigure(one(row({ entryPriceUsd: 200, shadow: true, outcome: "shadow" })), 220), null);
  });

  it("a paper fill is still a call, and is measured", () => {
    assert.ok(callFigure(one(row({ entryPriceUsd: 200, paper: true })), 220));
  });
});

describe("a sell says what it realized", () => {
  const sell = (over: Partial<FeedRow> = {}) =>
    row({ action: "sell", head: "sell TSLA 5.00 USDG", entryPriceUsd: null, ...over });

  it("the realized percent, with no dollars on a private book", () => {
    const f = callFigure(one(sell({ realizedPct: -3.25, realizedUsd: null })), 220);
    assert.deepEqual(f, { basis: "realized", pct: -3.25, usd: null });
  });

  it("dollars ONLY when the reader sent them — i.e. the book is public", () => {
    const f = callFigure(one(sell({ realizedPct: 12.5, realizedUsd: 0.62 })), null);
    assert.deepEqual(f, { basis: "realized", pct: 12.5, usd: 0.62 }, "and it needs no live price");
  });

  it("dollars without a percent are not shown alone", () => {
    assert.equal(callFigure(one(sell({ realizedPct: null, realizedUsd: 0.62 })), 220), null);
  });

  it("an unread realized return renders nothing, even with a live price", () => {
    assert.equal(callFigure(one(sell()), 220), null);
    assert.equal(callFigure(one(sell({ realizedPct: undefined })), 220), null);
  });

  it("a refused sell realized nothing", () => {
    assert.equal(callFigure(one(sell({ realizedPct: 5, outcome: "refused" })), 220), null);
  });
});

describe("a view is measured from the mark its author saw", () => {
  const view = (over: Partial<FeedRow> = {}) =>
    row({ action: "hold", head: "hold TSLA", outcome: "view", sizeUsdg: null, ...over });

  it("live 190 against a 200 mark is −5% since posted", () => {
    const f = callFigure(one(view({ markUsd: 200 })), 190);
    assert.ok(f);
    assert.equal(f.basis, "since posted");
    assert.ok(Math.abs(f.pct + 5) < 1e-9);
  });

  it("no mark, no figure", () => {
    assert.equal(callFigure(one(view()), 190), null);
    assert.equal(callFigure(one(view({ markUsd: null })), 190), null);
  });

  it("a would-buy is a call too, measured since it was posted", () => {
    const f = callFigure(one(row({ shadow: true, outcome: "shadow", head: "would buy TSLA 5.00 USDG", markUsd: 200 })), 210);
    assert.ok(f);
    assert.equal(f.basis, "since posted", "never 'since entry': nothing was entered");
  });
});

describe("the live price is read only when it is unambiguous", () => {
  it("one token with the symbol: its price", () => {
    assert.equal(livePriceOf([token()], "TSLA"), 220);
    assert.equal(livePriceOf([token()], "tsla"), 220);
  });

  it("TWO TOKENS SHARE A TICKER: no price, because one of them is a guess", () => {
    // Memecoin tickers are not unique. A since-entry figure computed against
    // the wrong PEPE is a false number about the agent's call.
    assert.equal(livePriceOf([token({ id: "0xa" }), token({ id: "0xb", priceUsd: 1 })], "TSLA"), null);
  });

  it("an unpriced or missing token has no price", () => {
    assert.equal(livePriceOf([token({ priceUsd: null })], "TSLA"), null);
    assert.equal(livePriceOf([], "TSLA"), null);
    assert.equal(livePriceOf([token()], null), null);
  });
});

describe("the row", () => {
  it("REGRESSION: the token's 24h change is not printed under a trade", async () => {
    const html = await render([row({ entryPriceUsd: 200 })], [token({ change24hPct: 9.9 })]);
    assert.ok(!/class="delta/.test(html), "no 24h Delta");
    assert.ok(!html.includes("9.9"), "the token's day is not the agent's result");
    assert.match(html, /\+10\.0%/);
    assert.match(html, /since entry/);
  });

  it("an unmeasured trade prints no figure at all", async () => {
    const html = await render([row()], [token()]);
    assert.ok(!html.includes("since entry"));
    assert.ok(!/0\.0%|\b0%/.test(html), "never 0%");
    assert.match(html, /\$5\.00/, "the size is still there");
  });

  it("a public sell prints its percent and its dollars", async () => {
    const html = await render(
      [row({ action: "sell", head: "sell TSLA 5.00 USDG", realizedPct: 12.5, realizedUsd: 0.62 })],
      [token()],
    );
    assert.match(html, /\+12\.5%/);
    assert.match(html, /realized/);
    assert.match(html, /\+\$0\.62/);
  });

  it("a private sell prints the percent and no dollars", async () => {
    const html = await render(
      [row({ action: "sell", head: "sell TSLA 5.00 USDG", realizedPct: -4, realizedUsd: null })],
      [token()],
    );
    assert.match(html, /−4\.0%/u, "a loss takes the house minus");
    assert.ok(!/[+−-]\$/u.test(html), "no signed dollar figure");
  });

  it("a view prints since posted", async () => {
    const html = await render([row({ action: "hold", head: "hold TSLA", outcome: "view", sizeUsdg: null, markUsd: 200 })], [token({ priceUsd: 190 })]);
    assert.match(html, /−5\.0%/u);
    assert.match(html, /since posted/);
  });

  it("a loss reads the same in both halves, and a rounded zero is not green", () => {
    assert.deepEqual(callFigureText({ basis: "realized", pct: -3.2, usd: -0.16 }), { pct: "−3.2%", usd: "−$0.16", tone: "down" });
    assert.deepEqual(callFigureText({ basis: "realized", pct: 12.5, usd: 0.62 }), { pct: "+12.5%", usd: "+$0.62", tone: "up" });
    assert.equal(callFigureText({ basis: "since entry", pct: 0.01, usd: null }).tone, "flat", "prints 0.0%, so it is not a gain");
  });
});
