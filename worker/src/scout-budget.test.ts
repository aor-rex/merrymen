import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { SETTINGS_DEFAULTS } from "../../packages/core/src/index";

/**
 * DON'T PAY TO RANK WHAT YOU CANNOT BUY.
 *
 * On 2026-08-31 the shared Groq key hit its 200,000-token DAILY limit —
 * 195,881 used — and the first person to notice was a user whose chat stopped
 * working. The consumer was the memecoin scout: an LLM ranking pass running per
 * tenant every ten minutes, across eleven tenants, on a house key.
 *
 * Every one of those rankings was unusable. `scoutEnabled` defaults to false
 * and `scoutBudgetUsdg` to 0, so a scouted coin cannot be bought at any size —
 * the quarantine refuses it. The agent was spending the budget that user chat
 * needs to produce a list nothing was allowed to act on.
 */

const SRC = readFileSync("worker/src/index.ts", "utf8");

test("the defaults mean a scouted coin cannot be bought", () => {
  // The premise. If either of these ever defaults to permissive, the gate below
  // stops being free and this test should fail so somebody reconsiders it.
  assert.equal(SETTINGS_DEFAULTS.scoutEnabled, false);
  assert.equal(SETTINGS_DEFAULTS.scoutBudgetUsdg, 0);
});

test("the paid ranking step is gated on the agent being able to act on it", () => {
  assert.match(
    SRC,
    /const creds = cfg\.scoutEnabled \? resolveLlm\(cfg\) : null;/,
    "the LLM call must wait until the owner has said they want to trade these",
  );
  assert.equal(
    /const creds = resolveLlm\(cfg\);\s*\n\s*const res = await discoverTrending/.test(SRC),
    false,
    "an ungated resolveLlm here is what drained the shared key",
  );
});

test("discovery itself still runs — the gate is on the LLM, not on looking", () => {
  // Candidates are still found, screened and recorded; only the paid narrowing
  // waits. Gating discovery entirely would have been the lazy fix and would
  // have emptied the coins page for everyone.
  assert.match(SRC, /if \(!cfg\.discoveryEnabled \|\| trendInFlight\) return;/);
  assert.match(SRC, /scout: creds \? createMemecoinScout\(creds\) : nullScout/);
});

test("no brain still means nullScout, which picks NOTHING", () => {
  // The pre-existing invariant, unchanged: this step exists to EXCLUDE, so with
  // nothing doing the excluding the honest answer is "nothing has been vetted",
  // never "everything has". A gate that opened the floodgates when the LLM was
  // unavailable would be the dangerous version of this fix.
  assert.match(SRC, /nullScout/);
  assert.equal(/scout: createMemecoinScout\(creds!\)/.test(SRC), false, "no non-null assertion around the brain");
});
