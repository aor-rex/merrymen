import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * THE RULE MOVED. See `exec-mode.test.ts`.
 *
 * This file used to model paperActive() in local code and pin index.ts against
 * the model with four regexes. The model is now a real function — `execModeOf`
 * in exec-mode.ts — so the tests call it directly instead of describing it, and
 * the source pins moved with them.
 *
 * That relocation is not tidying. The old pins matched the four lines that
 * DEFINED the rule, and all four kept matching while the execution fork asked a
 * different question entirely (`!executor`) a few thousand lines below. The
 * definition was pinned; the use was not; the fleet ran for months labelled
 * paper, valued paper and executed live. `exec-mode.test.ts` pins the CALL
 * SITES, which is the half that was missing.
 *
 * What stays here is the one paper-mode fact that is not about the predicate:
 * where a simulated fill gets its numbers.
 */

test("paper prices AND multipliers both come from mainnet", () => {
  // They disagreed: prices read through mainnetClient, multipliers through the
  // grant-chain client. On a testnet grant that meant live prices and no
  // multiplier — and paperMultiplierOf returns null for an unread token by
  // design, so the fill path refused every simulated trade. Practice mode
  // looked implemented and produced nothing.
  const src = readFileSync("worker/src/index.ts", "utf8");
  assert.match(src, /readMultipliers\(mainnetClient\(\), watchTokens\)/);
  assert.equal(
    /readMultipliers\(client,/.test(src),
    false,
    "reading multipliers on the grant chain is what broke testnet paper",
  );
});
