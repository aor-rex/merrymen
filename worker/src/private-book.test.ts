/**
 * A PRIVATE BOOK PUBLISHES NO DOLLARS — AND A SIZE IS DOLLARS.
 *
 * Wave 2 made a sell's realized PERCENT public for every book and kept its
 * dollars behind the owner's `publicBook` opt-in. The size stayed public, in
 * `sizeUsdg` and in the head ("sell AAPL 4.00 USDG"), and a sell's size is its
 * proceeds — so the withheld P&L was `size × pct / (100 + pct)`, one line of
 * arithmetic from the same row. Measured by the review on the ledger itself:
 * a private "sell AAPL 4.00 USDG" at −20% is exactly the −1.00 USDG the gate
 * printed as `realizedUsd: null`. A buy's size over its published entry price
 * is the quantity it holds.
 *
 * The owner's rule (the forbidden list): percentages are the public default,
 * and sizes, dollar P&L and holdings are opt-in. So the gate withholds the
 * size wherever it would be printed — the field and the sentence — for every
 * outcome, and a public book keeps both.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { publishableThesis, type ThesisRow } from "./thesis-policy";

const row = (over: Partial<ThesisRow> = {}): ThesisRow => ({
  agent_id: "0xabcabcabcabcabcabcabcabcabcabcabcabcabca",
  name: "SirSendIt",
  source: "brain",
  action: "sell",
  symbol: "AAPL",
  size_usdg: 4,
  reason: "Cutting AAPL: the gap filled and the bid thinned.",
  status: "landed",
  said: 1,
  last_at: 1_800_000_000,
  first_at: 1_800_000_000,
  mode: "live",
  ...over,
});

/** Every number a reader could get from the published post, as text. */
const published = (over: Partial<ThesisRow>) => JSON.stringify(publishableThesis(row(over)));

describe("a private book's post carries no size", () => {
  it("THE REVIEW'S CASE: a −20% sell cannot be turned back into −1.00 USDG", () => {
    const post = publishableThesis(row({ realized_pnl_usdg: -1, closed_cash_usdg: 4 }))!;
    assert.equal(post.realizedPct, -20, "the percent is the public default and stays");
    assert.equal(post.realizedUsd, null);
    assert.equal(post.sizeUsdg, null, "the size was the other half of the dollars");
    assert.equal(post.head, "sell AAPL");
    assert.ok(!/4\.00|USDG/.test(JSON.stringify(post)), "no size anywhere on the post");
  });

  it("a buy's size over its entry price is its holding — withheld too", () => {
    const post = publishableThesis(
      row({ action: "buy", symbol: "T3139F043B88", display_name: "JUGGERNAUT", size_usdg: 5, entry_price_usd: 0.0004 }),
    )!;
    assert.equal(post.entryPriceUsd, 0.0004, "the entry is a price, not a holding, and stays");
    assert.equal(post.sizeUsdg, null);
    assert.equal(post.head, "buy JUGGERNAUT (T3139F043B88)");
  });

  it("EVERY OUTCOME, not only a fill — a refusal, a pending order, a shadow call and a vault move all name a size", () => {
    const cases: Partial<ThesisRow>[] = [
      { action: "buy", status: "rejected", reject_rule: "slippage" },
      { action: "buy", status: "submitted" },
      { action: "buy", status: null },
      { action: "buy", status: "reverted" },
      { action: "buy", status: null, dropped_rule: "#0 AAPL: exceeds available cash" },
      { action: "buy", status: null, source: "brain-shadow" },
      { action: "vault-deposit", symbol: null, status: "landed", source: "strategy:steady-basket", reason: "parking idle cash" },
    ];
    for (const over of cases) {
      const post = publishableThesis(row(over));
      assert.ok(post, JSON.stringify(over));
      assert.equal(post.sizeUsdg, null, JSON.stringify(over));
      assert.ok(!/\d\.\d\d USDG/.test(post.head), `${post.head} — ${JSON.stringify(over)}`);
    }
    // The conditional survives losing the size: "would buy AAPL", not "buy".
    assert.equal(publishableThesis(row({ action: "buy", status: null, source: "brain-shadow" }))!.head, "would buy AAPL");
  });

  it("only an explicit true opens the book — absence, false, a string or a 1 do not", () => {
    for (const public_book of [undefined, null, false, "true", 1] as unknown as boolean[]) {
      assert.ok(!published({ public_book }).includes("4.00"), String(public_book));
      assert.equal(publishableThesis(row({ public_book }))!.sizeUsdg, null, String(public_book));
    }
  });
});

describe("a public book keeps what its owner chose to show", () => {
  it("the size, the sized head and the dollars", () => {
    const post = publishableThesis(row({ public_book: true, realized_pnl_usdg: -1, closed_cash_usdg: 4 }))!;
    assert.equal(post.sizeUsdg, 4);
    assert.equal(post.head, "sell AAPL 4.00 USDG");
    assert.equal(post.realizedPct, -20);
    assert.equal(post.realizedUsd, -1);
  });

  it("a hold still has no size, public or not — it is an answer, not a quantity", () => {
    assert.equal(publishableThesis(row({ public_book: true, action: "hold", status: null, size_usdg: 0 }))!.head, "hold AAPL");
  });
});
