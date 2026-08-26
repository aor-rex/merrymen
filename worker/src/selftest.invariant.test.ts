import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { RIALTO, UNISWAP, type GrantCaps } from "../../packages/core/src/index";
import { buildCallPermissions } from "../../packages/core/src/wall";

/**
 * `merrymen selftest` IS THE GATE BEFORE REAL MONEY.
 *
 * cli/bin.mjs walks a first-timer to it as onboarding step 4, "prove the shot
 * lands". Three separate things made it prove nothing:
 *
 *  1. It exited 0 unconditionally. processIntent absorbs every failure — a
 *     policy rejection, no-route, no-gas, a bundler refusal, an on-chain revert
 *     all record a row and return normally — so "did not throw" carries no
 *     information whatsoever. It printed "done" for UserOps the wall refused.
 *  2. The approve leg was hardcoded to the Rialto router, so a green result
 *     said nothing about the default Uniswap path. Worse — see the test below —
 *     Rialto is not in the wall of any grant this repo can sign, so the probe
 *     violated the call policy on every install, and reported success.
 *  3. It passed equityUsdg = 0n with equityKnown defaulting to true: an
 *     unknown book asserted as a zero one, in a codebase whose central rule is
 *     that unknown is never representable as zero.
 *
 * index.ts exports nothing, so the wiring is pinned as source. The claim about
 * the WALL below is checked for real, against the real permission builder.
 */

const SRC = readFileSync(fileURLToPath(new URL("index.ts", import.meta.url)), "utf8");
const SELFTEST = SRC.slice(SRC.indexOf("  if (selftest) {"));

test("the probe approves the router this install will actually use", () => {
  const intent = SRC.slice(SRC.indexOf("function selfTestIntent("), SRC.indexOf("/** Everything tied to the currently"));
  assert.match(intent, /target:\s*swapRouterFor\(cfg\)/, "the probe's target must follow swapVenue");
  assert.doesNotMatch(intent, /RIALTO\./, "no hardcoded venue in the probe");
  // And the approve call it actually emits.
  assert.match(
    SRC,
    /args:\s*\[swapRouterFor\(cfg\),\s*intent\.sellAmountRaw\]/,
    "the approve spender must follow swapVenue too — the intent and the calldata must agree",
  );
});

test("a grant this repo can sign does NOT carry the Rialto router — which is why the old probe always violated the wall", () => {
  // Not a source scan: the actual wall, from the actual builder, with the
  // options both signers actually pass (neither passes allowRialto).
  const SELF = "0x00000000000000000000000000000000000000a1" as const;
  const CAPS: GrantCaps = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };
  const perms = buildCallPermissions(CAPS, SELF) as unknown as { target: string; functionName?: string }[];
  const targets = perms.map((p) => p.target.toLowerCase());
  assert.equal(
    targets.includes(RIALTO.routerSnapshot.toLowerCase()),
    false,
    "Rialto is opt-in and no signer opts in — so approving it could only ever be refused",
  );
  assert.equal(
    targets.includes(UNISWAP.swapRouter02.toLowerCase()),
    true,
    "…while the Uniswap router IS in every wall, so the probe now approves something real",
  );
});

test("selftest fails loudly unless the probe LANDED", () => {
  assert.match(SELFTEST, /lastTradeOutcome/, "it must read the ledger row, not the absence of an exception");
  assert.match(
    SELFTEST,
    /status\s*!==\s*"landed"[\s\S]{0,600}process\.exit\(1\)/,
    "anything other than 'landed' must exit non-zero — a green light for a refused UserOp is worse than no check",
  );
  assert.match(SELFTEST, /!outcome[\s\S]{0,300}process\.exit\(1\)/, "no row at all must also fail");
  // And the success line must not overclaim: it proves approve, not the swap.
  assert.match(SELFTEST, /PASSED/, "sanity: there is still a success path");
  assert.match(
    SELFTEST,
    /swap call itself is not covered/i,
    "say what green does NOT mean — this never exercises exactInputSingle",
  );
});

test("selftest declares the probe's book UNKNOWN rather than zero", () => {
  assert.match(
    SELFTEST,
    /processIntent\(probe,\s*0n,\s*false\)/,
    "equityKnown must be false — passing 0n as a known equity is the exact 'unknown as zero' bug this codebase exists to avoid",
  );
});

test("selftest warns when the answer cannot mean what it looks like", () => {
  // Both are cases where the run can go green while proving nothing: a testnet
  // grant approves an address with no code, and a Rialto-configured install is
  // about to be refused by a wall that never carried its router.
  assert.match(SELFTEST, /TRADEABLE_CHAIN_ID/, "a non-mainnet grant must be called out");
  assert.match(SELFTEST, /swapVenue === "rialto"/, "a Rialto install must be told the wall will refuse");
});
