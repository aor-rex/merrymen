import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { checkPolicy, type AgentState, type AgentLimits, type TradeIntent } from "../policy";

/**
 * THE PROPOSE/DISPOSE LINE, PINNED.
 *
 * Depth is market colour. It exists to make the agent's PROPOSALS better — which
 * token, which size, whether a wall is about to eat the fill. It must never
 * become an input to the wall that judges those proposals, because the whole
 * safety argument of this project is that the deciding code cannot be talked
 * into anything: policy.ts takes a fixed set of inputs, and every branch of it
 * either rejects or passes a trade through unchanged. A cap that moved because
 * "there was lots of liquidity" would be a cap an attacker can manufacture.
 *
 * This file fails if anyone wires the two together.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string) => readFileSync(`${HERE}${p}`, "utf8");

test("policy.ts does not import the depth reader, directly or by name", () => {
  const policy = read("../policy.ts");
  assert.equal(/from\s+["'].*venues\/depth["']/.test(policy), false, "policy.ts must not import ./venues/depth");
  for (const symbol of ["readPoolDepth", "cashWithinBps", "deriveZones", "PoolDepth", "DepthZone"]) {
    assert.equal(
      policy.includes(symbol),
      false,
      `policy.ts must not reference ${symbol} — market colour cannot reach the wall`,
    );
  }
});

test("the quarantine scout is likewise depth-blind", () => {
  // scoutAllows() is the one other place that can narrow a trade. It may only
  // ever tighten, and it must tighten on facts about OUR OWN book — never on a
  // number an outside party can move by adding liquidity to a pool.
  const quarantine = read("../quarantine.ts");
  assert.equal(/venues\/depth/.test(quarantine), false, "quarantine.ts must not import the depth reader");
  assert.equal(quarantine.includes("PoolDepth"), false);
});

const LIMITS: AgentLimits = {
  perTradeUsdg: 50_000_000n,
  dailyUsdg: 500_000_000n,
  maxOpsPerDay: 48,
  maxDrawdownBps: 2000,
  expiresAt: Math.floor(Date.now() / 1000) + 86_400,
  allowedTargets: ["0x00000000000000000000000000000000000000a1"],
  allowedAssets: [
    "0x00000000000000000000000000000000000000c1",
    "0x00000000000000000000000000000000000000c2",
  ],
};

const STATE: AgentState = {
  spentTodayUsdg: 0n,
  opsToday: 0,
  equityUsdg: 1_000_000_000n,
  highWaterMarkUsdg: 1_000_000_000n,
  nowSec: Math.floor(Date.now() / 1000),
};

const INTENT: TradeIntent = {
  kind: "swap",
  target: "0x00000000000000000000000000000000000000a1",
  sellToken: "0x00000000000000000000000000000000000000c1",
  buyToken: "0x00000000000000000000000000000000000000c2",
  sellAmountRaw: 1n,
  notionalUsdg: 10_000_000n,
};

test("checkPolicy takes no market-data argument at all", () => {
  // Arity is the structural guarantee: (intent, limits, state, scout?). There is
  // no seat at this table for a depth map, and adding one would show up here.
  assert.equal(checkPolicy.length <= 4, true, `checkPolicy takes ${checkPolicy.length} params — a 5th means a new input`);
});

test("an oversized trade is refused no matter how deep the pool is", () => {
  // The scenario this guards against in plain terms: an attacker floods a pool
  // with liquidity, the agent sees enormous depth, and concludes it can size up.
  // The wall must not care. It never sees the depth, so the verdict is fixed by
  // the cap alone — and this asserts the OUTCOME, not just the wiring.
  const oversized: TradeIntent = { ...INTENT, notionalUsdg: LIMITS.perTradeUsdg + 1n };
  const verdict = checkPolicy(oversized, LIMITS, STATE);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.rule, "per-trade-cap");
});

test("the same intent gets a byte-identical verdict regardless of surrounding market state", () => {
  // Depth is not a parameter, so the only way it could ever leak in is via a
  // field smuggled onto limits or state. Cast through unknown and try it: the
  // verdict must be unchanged, because nothing reads those keys.
  const base = checkPolicy(INTENT, LIMITS, STATE);
  const withDepth = checkPolicy(
    INTENT,
    { ...LIMITS, depthUsdg: 10n ** 30n, bidWallUsdg: 10n ** 30n } as unknown as AgentLimits,
    { ...STATE, depthUsdg: 10n ** 30n } as unknown as AgentState,
  );
  assert.deepEqual(withDepth, base, "no depth-shaped field may change a verdict");
  assert.equal(base.ok, true, "sanity: the honest trade passes, so the test is not vacuously comparing refusals");
});
