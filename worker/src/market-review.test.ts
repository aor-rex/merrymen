import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { marketReview, MarketReviewClock, type ReviewQuote } from "./market-review";
import { publishableThesis } from "./thesis-policy";
import { memoryLines, sentimentLine } from "./brain-material";

const quote = (over: Partial<ReviewQuote> = {}): ReviewQuote => ({ symbol: "NVDA", priceUsd: 100, at: 1800000000, stale: false, ...over });

describe("a quiet tick still has a grounded market thesis", () => {
  it("publishes an observation and a follow-up condition without inventing history", () => {
    const review = marketReview(quote())!;
    assert.equal(review.action, "hold");
    assert.match(review.reason, /\$100\.00/);
    assert.match(review.reason, /next review/);
    const post = publishableThesis({ source: "market-review", ...review, first_at: quote().at, last_at: quote().at, name: "Robin" });
    assert.ok(post, "the same publication gate used by the feed must admit this view");
    assert.equal(post.action, "hold");
    assert.ok(sentimentLine([post], "NVDA", "sentiment")?.includes("100.00"));
    assert.ok(memoryLines([post], quote().at + 1).join(" ").includes("100.00"));
  });

  it("compares real quotes and names what would change its view", () => {
    const review = marketReview(quote({ priceUsd: 103, at: quote().at + 300 }), quote())!;
    assert.match(review.reason, /rose 3\.0%/);
    assert.match(review.reason, /below \$100\.00/);
    const down = marketReview(quote({ priceUsd: 97, at: quote().at + 300 }), quote())!;
    assert.match(down.reason, /fell 3\.0%/);
    assert.match(down.reason, /reclaiming \$100\.00/i);
  });

  it("never invents a thesis from an unread or stale quote", () => {
    for (const q of [quote({ stale: true }), quote({ priceUsd: NaN }), quote({ priceUsd: 0 }), quote({ symbol: "bad\nname" })]) {
      assert.equal(marketReview(q), null);
    }
    assert.doesNotMatch(marketReview(quote(), quote({ symbol: "TSLA", priceUsd: 900, at: quote().at - 300 }))!.reason, /rose|fell/);
  });

  it("publishes every five minutes, withholds repeats inside the window, and respects other decisions", () => {
    const clock = new MarketReviewClock();
    assert.ok(clock.prepare(quote()));
    // Failed persistence must leave the review due.
    assert.ok(clock.prepare(quote()));
    clock.recorded(quote());
    assert.equal(clock.prepare(quote({ at: quote().at + 299 })), null);
    assert.ok(clock.prepare(quote({ at: quote().at + 300 })));
    clock.noteDecision(quote().at + 300);
    assert.equal(clock.prepare(quote({ at: quote().at + 301 })), null);
    assert.ok(clock.prepare(quote({ at: quote().at + 600 })));
  });

  it("shares the scheduler's bounded early window and keeps observed quote times", () => {
    const clock = new MarketReviewClock();
    clock.recorded(quote());
    assert.equal(clock.prepare(quote({ at: quote().at + 239 }), 60_000), null);
    const prepared = quote({ at: quote().at + 240, priceUsd: 102 });
    const review = clock.prepare(prepared, 60_000)!;
    assert.equal(JSON.parse(review.evidence_json).quote.at, prepared.at);
    clock.recorded(prepared);
    assert.equal(clock.nextAt, prepared.at + 300);
    assert.equal(clock.prepare(quote({ at: prepared.at + 1 }), 999_999), null);
  });
});
