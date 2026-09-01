import assert from "node:assert/strict";
import { test } from "node:test";
import { tradeDigestLine, tradeLine } from "./notifier";

test("tradeDigestLine summarises only the non-empty status buckets", () => {
  const line = tradeDigestLine(
    [
      { status: "paper", c: 12, s: 75 },
      { status: "rejected", c: 3, s: 22.5 },
    ],
    15,
  );
  assert.match(line, /last 15m/);
  assert.match(line, /12× paper \(75\.00 USDG\)/);
  assert.match(line, /3× turned back/);
  assert.doesNotMatch(line, /landed/); // no landed bucket → not shown
});

test("tradeDigestLine labels periods nicely (m / h / d)", () => {
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 5), /last 5m/);
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 60), /last 1h/);
  assert.match(tradeDigestLine([{ status: "paper", c: 1, s: 6.25 }], 1440), /last 1d/);
});

test("tradeDigestLine with nothing new reads as quiet", () => {
  assert.match(tradeDigestLine([], 30), /quiet/);
});

/**
 * WHO GETS BLAMED when a trade does not go out.
 *
 * The wall is the owner's OWN sealed policy. Saying it turned a trade back when
 * the real cause was the house's gas sponsor declining sends them looking
 * through their settings for a fault that is not theirs — and there is nothing
 * they could change that would fix it.
 *
 * SponsorRefused carries a fixed three-word vocabulary, all prefixed `sponsor-`,
 * so the distinction is a prefix test rather than a guess at the text.
 */
test("a sponsor failure is not reported as the wall refusing", () => {
  for (const rule of ["sponsor-refused", "sponsor-unreachable", "sponsor-absurd"]) {
    const line = tradeLine(
      { id: 1, kind: "swap", amount_usdg: 25, status: "rejected", reject_rule: rule, tx_hash: null },
      null,
    );
    assert.doesNotMatch(line, /the wall/, `${rule} must not be blamed on the wall`);
    assert.match(line, /gas sponsor declined/);
    assert.match(line, /ours to fix/);
  }
});

test("a real wall refusal still says so", () => {
  // The unsponsored path, and the overwhelmingly common one. It must not move.
  const line = tradeLine(
    { id: 2, kind: "swap", amount_usdg: 25, status: "rejected", reject_rule: "per-trade-cap", tx_hash: null },
    null,
  );
  assert.match(line, /the wall turned back a swap \(per-trade-cap\)/);
  assert.doesNotMatch(line, /sponsor/);
});
