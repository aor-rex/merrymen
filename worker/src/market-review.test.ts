import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { marketReview, MarketReviewClock, type ReviewQuote } from "./market-review";
import { publishableThesis } from "./thesis-policy";
import { memoryLines, sentimentLine } from "./brain-material";
const quote = (over: Partial<ReviewQuote> = {}): ReviewQuote => ({ symbol: "TSLA", priceUsd: 102, at: 1800000000, stale: false, ...over });
const history = [{ at: quote().at - 3600, priceUsd: 100 }, { at: quote().at - 1800, priceUsd: 103 }, { at: quote().at - 60, priceUsd: 101 }];
describe("research-backed quiet decisions", () => {
  it("publishes evidence, a horizon, and falsifiable follow-up conditions to peers", () => {
    const review = marketReview(quote(), null, history)!;
    assert.match(review.reason, /up 2.00%/);
    assert.match(review.reason, /1.0h window \(3 oracle rounds/);
    assert.match(review.reason, /two fresh oracle rounds above \$103.00/);
    assert.match(review.reason, /two below \$100.00/);
    assert.match(review.reason, /next hour/);
    const post = publishableThesis({ source: "market-review", ...review, first_at: quote().at, last_at: quote().at, name: "shogun" });
    assert.ok(post);
    assert.ok(sentimentLine([post], "TSLA", "sentiment")?.includes("103.00"));
    assert.ok(memoryLines([post], quote().at + 1).join(" ").includes("103.00"));
    assert.deepEqual(JSON.parse(review.evidence_json).points, history);
  });
  it("rejects spot quotes, repeated timestamps, stale or flat history", () => {
    for (const points of [[], history.slice(0, 1), history.map(p => ({ ...p, at: quote().at })), history.map(p => ({ ...p, priceUsd: 100 })), history.map(p => ({ ...p, at: p.at - 7200 }))]) assert.equal(marketReview(quote(), null, points), null);
    for (const q of [quote({ stale: true }), quote({ priceUsd: NaN }), quote({ priceUsd: 0 }), quote({ symbol: "bad\nname" })]) assert.equal(marketReview(q, null, history), null);
  });
  it("excludes future and invalid observations", () => {
    const review = marketReview(quote(), null, [...history, { at: quote().at + 1, priceUsd: 999 }, { at: quote().at - 1, priceUsd: Infinity }])!;
    assert.deepEqual(JSON.parse(review.evidence_json).points, history);
  });
  it("records private holds without publishing operational failures", () => {
    assert.equal(publishableThesis({ source: "research-unavailable", action: "hold", reason: "Invalid API key" }), null);
    const clock = new MarketReviewClock();
    assert.equal(clock.prepare(quote()), null);
    assert.equal(clock.due(quote().at), true);
    clock.recorded(quote());
    assert.equal(clock.due(quote().at + 299), false);
    assert.equal(clock.due(quote().at + 300), true);
  });
  it("retries failed persistence and respects bounded preparation", () => {
    const clock = new MarketReviewClock();
    assert.ok(clock.prepare(quote(), 0, history));
    assert.ok(clock.prepare(quote(), 0, history));
    clock.recorded(quote());
    assert.equal(clock.prepare(quote({ at: quote().at + 239 }), 60000, history), null);
    assert.ok(clock.prepare(quote({ at: quote().at + 240 }), 60000, history));
    clock.noteDecision(quote().at + 300);
    assert.equal(clock.due(quote().at + 301), false);
    assert.equal(clock.nextAt, quote().at + 600);
  });
  it("uses decision time for cadence without falsifying observation timestamps", () => {
    const clock = new MarketReviewClock();
    clock.noteDecision(quote().at - 250);
    const review = clock.prepare(quote(), 0, history, quote().at + 50)!;
    assert.ok(review);
    assert.equal(JSON.parse(review.evidence_json).quote.at, quote().at);
  });
});
