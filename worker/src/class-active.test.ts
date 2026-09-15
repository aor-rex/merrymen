/**
 * THE CEILING COUNTED HISTORY AND SHUT THE ROUTE FOR EVER.
 *
 * `proposeClassEntries` compared `classMaxPositions` against every row
 * `class_positions` had ever carried, so each completed round trip consumed a
 * slot permanently. Shogun reached 3 of 3 holding NOTHING — a closed round
 * trip, a swept token, and a row for USDG that was never a position at all —
 * and because the gate is below the funnel and logs nothing, the agent printed
 * a healthy scan every tick and silently never bought.
 *
 * The first two cases below are the owner's own acceptance criteria.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CASH } from "../../packages/core/src/index";

import {
  activeClassPositions,
  ceilingBlocks,
  describeCeiling,
  isActiveClassState,
  isQuoteTokenRow,
} from "./class-active";

/** A launch token address that is emphatically not the cash token. */
const DOGGOS = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461";
const SOLD = "0x34d73af0c4e41a727304b7049ff99ca3c953b4af";
const OPEN1 = "0x1111111111111111111111111111111111111111";
const OPEN2 = "0x2222222222222222222222222222222222222222";
const OPEN3 = "0x3333333333333333333333333333333333333333";

const row = (
  token: string,
  state: string,
  over: { quoteToken?: string | null; symbol?: string | null } = {},
) => ({
  token,
  state,
  quoteToken: over.quoteToken === undefined ? CASH.USDG : over.quoteToken,
  symbol: over.symbol === undefined ? token.slice(0, 6) : over.symbol,
});

describe("the ceiling counts positions, not ledger history", () => {
  it("SHOGUN'S ACTUAL BOOK — 3 rows, 0 positions, entry NOT blocked", () => {
    // 1 closed round trip + 1 swept token + 1 quote-token row that was never a
    // position. classMaxPositions = 3. The agent holds nothing.
    const book = [
      row(SOLD, "closed"),
      row(DOGGOS, "swept"),
      // The phantom: USDG, no curve, no quote token recorded, state `recovered`.
      row(CASH.USDG, "recovered", { quoteToken: null, symbol: null }),
    ];
    assert.equal(activeClassPositions(book).length, 0, "none of these is a position");
    assert.equal(ceilingBlocks(book, 3), false, "the route must be OPEN");
  });

  it("AND A GENUINELY FULL BOOK — 3 standing positions, entry IS blocked", () => {
    const book = [row(OPEN1, "open"), row(OPEN2, "open"), row(OPEN3, "recovered")];
    assert.equal(activeClassPositions(book).length, 3);
    assert.equal(ceilingBlocks(book, 3), true, "a real ceiling must still bind");
  });

  it("counts `recovered` as standing — held, with a basis nobody could explain", () => {
    // Money the agent cannot account for still occupies a slot. Treating it as
    // absent would let the same capital be committed twice.
    assert.equal(isActiveClassState("recovered"), true);
    assert.equal(isActiveClassState("open"), true);
    assert.equal(isActiveClassState("closed"), false);
    assert.equal(isActiveClassState("swept"), false);
    assert.equal(isActiveClassState(null), false, "an unknown state is not a position");
  });

  it("one more position than the ceiling still blocks, and one fewer does not", () => {
    const two = [row(OPEN1, "open"), row(OPEN2, "open")];
    assert.equal(ceilingBlocks(two, 3), false);
    assert.equal(ceilingBlocks([...two, row(OPEN3, "open")], 3), true);
    assert.equal(ceilingBlocks([...two, row(OPEN3, "open"), row(SOLD, "open")], 3), true);
  });

  it("an unset ceiling does not read as `no positions allowed`", () => {
    const full = [row(OPEN1, "open"), row(OPEN2, "open"), row(OPEN3, "open")];
    assert.equal(ceilingBlocks(full, 0), false);
    assert.equal(ceilingBlocks(full, -1), false);
  });
});

describe("cash is never a position", () => {
  it("catches the cash row by ADDRESS when no quote token was ever recorded", () => {
    // The live shape: the phantom has no curve, so there was no pair token to
    // read, so `quote_token` is NULL. An identity test that needed that column
    // would have missed the only row this bug actually produced.
    assert.equal(isQuoteTokenRow({ token: CASH.USDG, quoteToken: null, state: "recovered" }), true);
  });

  it("and by self-reference, which keeps working if the quote asset changes", () => {
    const other = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // WETH
    assert.equal(isQuoteTokenRow({ token: other, quoteToken: other, state: "open" }), true);
  });

  it("is case-insensitive, because these addresses arrive in both casings", () => {
    assert.equal(
      isQuoteTokenRow({ token: CASH.USDG.toLowerCase(), quoteToken: null, state: "recovered" }),
      true,
    );
    assert.equal(
      isQuoteTokenRow({ token: CASH.USDG.toUpperCase().replace("0X", "0x"), quoteToken: null, state: "open" }),
      true,
    );
  });

  it("A TOKEN THAT CALLS ITSELF USDG IS STILL A POSITION — address-keyed, never symbol-keyed", () => {
    // A launch token's symbol is chosen by its deployer. If identity were
    // decided on the string, minting a token named USDG would exempt it from
    // the ceiling — an attacker-controlled hole in a risk limit.
    const impostor = row(DOGGOS, "open", { symbol: "USDG" });
    assert.equal(isQuoteTokenRow(impostor), false);
    assert.equal(activeClassPositions([impostor]).length, 1);
  });

  it("a real position quoted IN usdg is not a cash row", () => {
    // The overwhelmingly common shape — every genuine class position has
    // quoteToken === USDG. Confusing "quoted in cash" with "is cash" would
    // exclude every position there has ever been.
    assert.equal(isQuoteTokenRow(row(DOGGOS, "open")), false);
    assert.equal(activeClassPositions([row(DOGGOS, "open")]).length, 1);
  });
});

describe("the operator can see what was counted", () => {
  it("names the tokens and states, so a jammed ceiling is not read as a full one", () => {
    // "3/3" alone invites exactly the wrong reading: that three positions are
    // open. For every hour Shogun was stuck, none were.
    const out = describeCeiling(
      [row(SOLD, "closed"), row(DOGGOS, "swept"), row(CASH.USDG, "recovered", { quoteToken: null })],
      3,
    );
    assert.match(out, /class positions 0\/3/);
    assert.match(out, /counted: none/);
    assert.match(out, /3 ledger row\(s\) not counted/);
  });

  it("and names them when the book really is full", () => {
    const out = describeCeiling([row(OPEN1, "open", { symbol: "AAA" }), row(OPEN2, "recovered", { symbol: "BBB" })], 2);
    assert.match(out, /class positions 2\/2/);
    assert.match(out, /AAA\(open\)/);
    assert.match(out, /BBB\(recovered\)/);
    assert.doesNotMatch(out, /not counted/, "nothing was skipped, so say nothing");
  });
});
