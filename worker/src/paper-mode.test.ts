import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { TRADEABLE_CHAIN_ID } from "./preflight";

/**
 * PAPER IS A CAPABILITY, and the predicate that decides it is one line in a
 * 4,000-line closure with no seam. So this models the rule and pins the source
 * against it — the model is worthless without the second half, because a model
 * that has drifted from the code it describes is just a second opinion.
 *
 * The bug being pinned: paper used to be `!executor && paperTradingEnabled`,
 * i.e. the accidental consequence of having nothing to sign with. Hosted always
 * injects the house bundler key, so no hosted tenant could ever be in paper —
 * a testnet tenant got a LIVE executor building swaps against mainnet-only
 * addresses, which is neither trading nor simulating.
 */

/** The rule as index.ts implements it. */
function paperActive(a: {
  armed: boolean;
  executor: boolean;
  chainId: number;
  cashUsdg: bigint | null;
  paperTradingEnabled: boolean;
}) {
  const chainCanTrade = a.armed && a.chainId === TRADEABLE_CHAIN_ID;
  const readAsBroke = a.cashUsdg !== null && a.cashUsdg === 0n;
  const canTradeForReal = a.armed && a.executor && chainCanTrade && !readAsBroke;
  return a.armed && !canTradeForReal && a.paperTradingEnabled;
}

const base = {
  armed: true,
  executor: true,
  chainId: TRADEABLE_CHAIN_ID,
  cashUsdg: 100_000_000n,
  paperTradingEnabled: true,
};

test("THE REGRESSION THAT MATTERED: a funded mainnet agent trades for real", () => {
  // paperTradingEnabled defaults to TRUE. Reading it as a mode selector rather
  // than as permission would have put every funded agent in the fleet into
  // simulation while its owner believed it was trading — the single worst
  // outcome available here, and an easy mistake to make while fixing the other
  // direction.
  assert.equal(paperActive(base), false);
});

test("a testnet grant is paper, whatever the bundler key says", () => {
  // The case that could not previously happen hosted. Every token and router
  // merrymen knows is a mainnet deployment, so there is no venue to route
  // through — preflight calls the same fact a hard blocker.
  assert.equal(paperActive({ ...base, chainId: 46630 }), true);
  assert.equal(paperActive({ ...base, chainId: 46630, executor: true }), true, "an executor does not make a dead chain tradeable");
});

test("no signer is still paper — the original case, unbroken", () => {
  assert.equal(paperActive({ ...base, executor: false }), true);
});

test("an account read as empty is paper, because a swap needs something to sell", () => {
  assert.equal(paperActive({ ...base, cashUsdg: 0n }), true);
});

test("UNKNOWN IS NOT UNFUNDED", () => {
  // lastCashUsdg is null until the first balance read of the process. If null
  // counted as broke, every worker would spend its first tick simulating — and
  // worse, a funded agent whose balance read failed would quietly start writing
  // pretend fills. Only a READ zero counts.
  assert.equal(paperActive({ ...base, cashUsdg: null }), false);
});

test("paperTradingEnabled is permission to simulate, not a request to", () => {
  // Turning it off does not force a broken agent to trade; it makes it idle.
  assert.equal(paperActive({ ...base, chainId: 46630, paperTradingEnabled: false }), false);
  assert.equal(paperActive({ ...base, executor: false, paperTradingEnabled: false }), false);
  // And it never overrides a working agent in either direction.
  assert.equal(paperActive({ ...base, paperTradingEnabled: false }), false);
});

test("nothing is paper when nothing is armed", () => {
  assert.equal(paperActive({ ...base, armed: false }), false);
  assert.equal(paperActive({ ...base, armed: false, executor: false }), false);
});

test("the model above matches the source it claims to describe", () => {
  // Without this the tests are a second opinion, not a check.
  const src = readFileSync("worker/src/index.ts", "utf8");
  assert.match(src, /const chainCanTrade = \(\) =>[^;]*TRADEABLE_CHAIN_ID/);
  assert.match(src, /const readAsBroke = \(\) => lastCashUsdg !== null && lastCashUsdg === 0n;/);
  assert.match(src, /const canTradeForReal = \(\)[^;]*!!active\.executor && chainCanTrade\(\) && !readAsBroke\(\)/);
  assert.match(src, /const paperActive = \(\) => !!active && !canTradeForReal\(\) && cfg\.paperTradingEnabled;/);
});

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
