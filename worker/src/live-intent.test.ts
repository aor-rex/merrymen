/**
 * FUNDING IS NOT CONSENT.
 *
 * A beta owner created an agent, chose "Paper trading · recommended" in the
 * wizard, and said so in as many words: "I know that I haven't given my
 * permission to execute real trades... When I decide to go mainnet, I will have
 * to give permissions and fund the agent."
 *
 * The product disagreed with him. `canTradeForReal` asked seven questions —
 * armed, executor, chain, cash, gas, policy, wall — and not one of them was
 * "did the owner ask for this". `paperTradingEnabled` was consulted only AFTER
 * that predicate had already answered, and `exec-mode.ts` says why in its own
 * words: "paper is PERMISSION TO SIMULATE, not a request to, and it never moves
 * a working agent". So paper was reachable only as a FALLBACK from a broken
 * rail, and the moment the rail healed the agent went live.
 *
 * MEASURED, by executing the real functions against his real inputs before this
 * change (gasSponsored true — MERRYMEN_SPONSOR_GAS and a bundler key are both
 * set on the orchestrator — and paperTradingEnabled true):
 *
 *     mainnet + owner wants paper + funded 500 USDG  ->  {"mode":"live"}
 *
 * That is the defect. Funding, or a chain move, silently promoted an owner from
 * PAPER to LIVE with no action by them and nothing on screen to say so.
 *
 * THE FIX IS A FOURTH THING, kept separate from the other three on purpose:
 *
 *     network selection   which chain the grant is for
 *     funding             whether there is money
 *     paperTradingEnabled permission to SIMULATE when real execution is off
 *     liveTradingEnabled  permission to EXECUTE REAL ORDERS   <- new, required
 *
 * `liveTradingEnabled` is a required TERM of `canTradeForReal`, not a fallback
 * consulted afterwards, because a term is the only shape that cannot be routed
 * around by the world changing underneath it.
 *
 * WHY THE TWO BOOLEANS ARE NOT REDUNDANT, and why this is not `!paper`: they
 * answer different questions. `liveTradingEnabled` asks "may real money move".
 * `paperTradingEnabled` asks "when it may not, should I simulate instead".
 * Collapsing them would mean an owner who turns off simulation has thereby
 * asked to trade for real, which is the same class of implicit promotion this
 * file exists to forbid.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canTradeForReal, execModeOf, type ExecInputs } from "./exec-mode";

const MAINNET = 4663;
const TESTNET = 46630;

/**
 * A healthy rail. Every safety condition satisfied, so the ONLY variable in the
 * cases below is the owner's intent — which is the whole point: if intent were
 * merely one more way to be broken, a test could pass by breaking something
 * else.
 *
 * `gasSponsored: true` mirrors production. It matters more than it looks: with
 * sponsorship on, a zero ETH balance stops being a blocker, so nothing in the
 * gas leg was left to accidentally hold a paper owner back.
 */
const healthy: ExecInputs = {
  armed: true,
  executor: true,
  chainId: MAINNET,
  cashUsdg: 500_000_000n, // 500 USDG, funded
  gasWei: 0n,
  gasSponsored: true,
  deadPolicy: false,
  wallTooWide: false,
  paperTradingEnabled: true,
  liveTradingEnabled: false,
};

describe("funding a paper agent does not transition it to live", () => {
  it("MAINNET + PAPER + FUNDED is simulation only", () => {
    // The exact case that executed as {"mode":"live"} before this change.
    const a = { ...healthy, liveTradingEnabled: false };
    assert.equal(canTradeForReal(a), false, "an owner who never asked for live must not get it");
    assert.equal(execModeOf(a).mode, "paper");
  });

  it("and ARRIVING money changes nothing — the promotion path is closed", () => {
    // Same agent, before and after a deposit. This is the transition the owner
    // reported as the thing he expected to control, so it is asserted as a
    // transition and not as two unrelated states.
    const unfunded = { ...healthy, liveTradingEnabled: false, cashUsdg: 0n };
    const funded = { ...unfunded, cashUsdg: 10_000_000_000n };
    assert.equal(execModeOf(unfunded).mode, "paper");
    assert.equal(execModeOf(funded).mode, "paper", "a deposit is not a signature");
  });

  it("MAINNET + PAPER + SPONSORED GAS is simulation only", () => {
    // Sponsorship is the term that made this urgent: it removes the no-gas leg
    // for the whole fleet at once, so before this change the house turning
    // sponsorship on was itself enough to move owners onto the live rail.
    const a = { ...healthy, liveTradingEnabled: false, gasWei: 0n, gasSponsored: true };
    assert.equal(canTradeForReal(a), false);
    assert.equal(execModeOf(a).mode, "paper");
  });

  it("MAINNET + PAPER + UNFUNDED is simulation only", () => {
    const a = { ...healthy, liveTradingEnabled: false, cashUsdg: 0n };
    assert.equal(execModeOf(a).mode, "paper");
  });

  it("and a never-read balance is not a loophole", () => {
    // NULL IS NOT ZERO is the rule everywhere else in this codebase, and it is
    // exactly how the reported agent slipped through: `readAsBroke` is false for
    // an unread balance, so on the paper rail — which never reads balances —
    // cash stayed null forever and could never block anything. Intent has to
    // hold on its own, without help from a number nobody has looked at.
    const a = { ...healthy, liveTradingEnabled: false, cashUsdg: null };
    assert.equal(canTradeForReal(a), false);
    assert.equal(execModeOf(a).mode, "paper");
  });
});

describe("explicit live intent is what turns real execution on", () => {
  it("MAINNET + LIVE + FUNDED trades for real", () => {
    // The other half. A consent gate that never opens is not a gate, it is an
    // outage, and this is the assertion that would catch one.
    const a = { ...healthy, liveTradingEnabled: true };
    assert.equal(canTradeForReal(a), true);
    assert.equal(execModeOf(a).mode, "live");
  });

  it("but it does not override any safety condition — LIVE + TESTNET is never live", () => {
    // Intent is ADDED to the safety conditions, never substituted for them.
    // A grant sealed for 46630 cannot reach a mainnet router whatever the owner
    // has ticked, so consent must not be able to talk the rail into trying.
    const a = { ...healthy, liveTradingEnabled: true, chainId: TESTNET };
    assert.equal(canTradeForReal(a), false, "testnet is never real trading");
    assert.notEqual(execModeOf(a).mode, "live");
  });

  it("nor over an empty account, a dead policy, or a wall that cannot install", () => {
    for (const [name, broken] of [
      ["read-as-broke", { cashUsdg: 0n }],
      ["dead policy", { deadPolicy: true }],
      ["wall too wide", { wallTooWide: true }],
      ["not armed", { armed: false }],
      ["no executor", { executor: false }],
    ] as const) {
      const a = { ...healthy, liveTradingEnabled: true, ...broken };
      assert.equal(canTradeForReal(a), false, `${name} must still block the live rail`);
    }
  });

  it("and an unsponsored account with no ETH still cannot trade, consent or not", () => {
    const a = { ...healthy, liveTradingEnabled: true, gasSponsored: false, gasWei: 0n };
    assert.equal(canTradeForReal(a), false);
  });
});

describe("the owner's two switches stay independent", () => {
  it("turning OFF simulation does not turn ON real trading", () => {
    // The collapse this guards against: `liveTradingEnabled = !paperTradingEnabled`
    // would make "stop showing me pretend fills" mean "start spending my money".
    const a = { ...healthy, paperTradingEnabled: false, liveTradingEnabled: false };
    assert.equal(canTradeForReal(a), false, "no simulation is not a request to trade for real");
    assert.equal(execModeOf(a).mode, "refuse", "it does nothing at all, and says so");
  });

  it("a live owner who also allows simulation still trades for real", () => {
    // paperTradingEnabled keeps its old meaning — a FALLBACK — so leaving it on
    // must not hold back an owner who has asked for live.
    const a = { ...healthy, paperTradingEnabled: true, liveTradingEnabled: true };
    assert.equal(execModeOf(a).mode, "live");
  });

  it("and a live owner whose rail breaks falls back to simulation, as before", () => {
    const a = { ...healthy, liveTradingEnabled: true, chainId: TESTNET, paperTradingEnabled: true };
    assert.equal(execModeOf(a).mode, "paper", "the fallback is unchanged for those who opted in");
  });
});

describe("the whole matrix, as the owner specified it", () => {
  /** network × intent × funding -> what may happen. The spec, executed. */
  const MATRIX: readonly {
    chainId: number;
    live: boolean;
    funded: boolean;
    expect: "live" | "paper";
  }[] = [
    { chainId: MAINNET, live: false, funded: true, expect: "paper" },
    { chainId: MAINNET, live: true, funded: true, expect: "live" },
    { chainId: MAINNET, live: false, funded: false, expect: "paper" },
    { chainId: TESTNET, live: false, funded: true, expect: "paper" },
    { chainId: TESTNET, live: true, funded: true, expect: "paper" },
    { chainId: TESTNET, live: true, funded: false, expect: "paper" },
  ];

  for (const row of MATRIX) {
    const net = row.chainId === MAINNET ? "mainnet" : "testnet";
    it(`${net} + ${row.live ? "LIVE" : "PAPER"} + ${row.funded ? "funded" : "unfunded"} -> ${row.expect}`, () => {
      const a: ExecInputs = {
        ...healthy,
        chainId: row.chainId,
        liveTradingEnabled: row.live,
        cashUsdg: row.funded ? 500_000_000n : 0n,
      };
      assert.equal(execModeOf(a).mode, row.expect);
    });
  }

  it("and real execution requires mainnet AND explicit intent, both", () => {
    // Stated once more as a property rather than a table, so a future edit that
    // satisfies every row above by coincidence still fails here.
    for (const chainId of [MAINNET, TESTNET]) {
      for (const live of [true, false]) {
        const a: ExecInputs = { ...healthy, chainId, liveTradingEnabled: live };
        assert.equal(
          canTradeForReal(a),
          chainId === MAINNET && live,
          `chain ${chainId}, live ${live}`,
        );
      }
    }
  });
});
