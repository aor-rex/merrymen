/**
 * THE ONE TOOL IN THIS REPAIR THAT CAN DESTROY SOMETHING.
 *
 * `recovered` is the state of the phantom cash row AND of a real held token
 * whose tape could not be explained — money the owner owns, in a vault. A
 * predicate that deleted "recovered rows that look odd" would erase the record
 * of a real position, and nothing would bring it back.
 *
 * So these tests are weighted towards what must SURVIVE, not towards what gets
 * deleted. Every clause is exercised alone, because the protection is that all
 * four must hold and any single one failing must refuse the row.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  cashRowRepairLines,
  judgeCashRow,
  planCashRowRepair,
  type CashRowCandidate,
} from "./class-cash-row-repair";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TENANT = "0x8e93bad5a60a266b4283855ceffa0979720aed72";
const AGENT = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";

const row = (over: Partial<CashRowCandidate> = {}): CashRowCandidate => ({
  agentId: AGENT,
  token: USDG,
  symbol: null,
  quoteToken: null,
  state: "recovered",
  curve: null,
  entryTx: null,
  costUsdg: null,
  ...over,
});

describe("what gets deleted", () => {
  it("SHOGUN'S ACTUAL PHANTOM — cash token, no curve, no entry, no cost", () => {
    const v = judgeCashRow(row(), USDG);
    assert.equal(v.deletable, true);
    assert.deepEqual(v.blockedBy, []);
  });

  it("and the same fact recorded the other way — token === its own quote token", () => {
    const other = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
    const v = judgeCashRow(row({ token: other, quoteToken: other }), USDG);
    assert.equal(v.deletable, true);
  });

  it("case-insensitively, because these arrive in both casings", () => {
    assert.equal(judgeCashRow(row({ token: USDG.toLowerCase() }), USDG).deletable, true);
  });
});

describe("WHAT MUST SURVIVE", () => {
  const REAL = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461";
  const CURVE = "0x7d5369f126d98340d8aa88a80beeb03fc3ccff59";

  it("a real recovered position — held money with an unexplained basis", () => {
    // The catastrophic case. This row IS someone's asset.
    const v = judgeCashRow(
      row({ token: REAL, quoteToken: USDG, state: "recovered", curve: CURVE, costUsdg: "5000000" }),
      USDG,
    );
    assert.equal(v.deletable, false);
    assert.match(v.blockedBy.join(" "), /token is not the quote asset/);
  });

  it("A LAUNCH TOKEN THAT CALLS ITSELF USDG", () => {
    // The symbol is chosen by the deployer. If identity were decided on the
    // string, a token could name itself into being deleted — or, worse, name
    // itself out of the position ceiling.
    const v = judgeCashRow(row({ token: REAL, symbol: "USDG", quoteToken: USDG }), USDG);
    assert.equal(v.deletable, false);
  });

  it("a cash-token row that somehow HAS a curve — refused, not deleted", () => {
    const v = judgeCashRow(row({ curve: CURVE }), USDG);
    assert.equal(v.deletable, false);
    assert.match(v.blockedBy.join(" "), /curve is recorded/);
  });

  it("a cash-token row with an entry transaction — something bought it", () => {
    const v = judgeCashRow(row({ entryTx: "0xd860ac4695" }), USDG);
    assert.equal(v.deletable, false);
    assert.match(v.blockedBy.join(" "), /entry_tx is recorded/);
  });

  it("a cash-token row with a cost — something was paid", () => {
    const v = judgeCashRow(row({ costUsdg: "5000000" }), USDG);
    assert.equal(v.deletable, false);
    assert.match(v.blockedBy.join(" "), /cost_usdg is recorded/);
  });

  it("EVERY CLAUSE IS LOAD-BEARING — each alone is enough to refuse", () => {
    // Stated as a property rather than trusting the four cases above to stay
    // in step with the implementation.
    for (const [name, over] of [
      ["curve", { curve: CURVE }],
      ["entryTx", { entryTx: "0xabc" }],
      ["costUsdg", { costUsdg: "1" }],
    ] as const) {
      assert.equal(judgeCashRow(row(over), USDG).deletable, false, `${name} must block a delete on its own`);
    }
  });
});

describe("the plan separates the three populations", () => {
  const REAL = "0x15e498ff2dbca95e8648a1f025cbbd12c2525461";

  it("SHOGUN'S WHOLE LEDGER — one deletion, two positions left alone", () => {
    const plan = planCashRowRepair(
      TENANT,
      [
        row({ token: "0x34d73af0c4e41a727304b7049ff99ca3c953b4af", state: "closed", costUsdg: "5000000",
              quoteToken: USDG, entryTx: "0x3d926ce734", curve: "0x2f0c6e73" }),
        row({ token: REAL, state: "swept", costUsdg: "5000000", quoteToken: USDG,
              entryTx: "0xd860ac4695", curve: "0x7d5369f1" }),
        row(),
      ],
      USDG,
    );
    assert.equal(plan.deletable.length, 1);
    assert.equal(plan.deletable[0]!.row.token, USDG);
    assert.equal(plan.refused.length, 0);
    assert.equal(plan.untouched, 2, "the closed and swept positions are not even candidates");
  });

  it("an empty ledger plans no deletion rather than failing", () => {
    const plan = planCashRowRepair(TENANT, [], USDG);
    assert.equal(plan.deletable.length, 0);
    assert.match(cashRowRepairLines(plan, "report").join("\n"), /nothing to delete/);
  });

  it("report mode says plainly that it wrote nothing", () => {
    const out = cashRowRepairLines(planCashRowRepair(TENANT, [row()], USDG), "report").join("\n");
    assert.match(out, /would delete/);
    assert.match(out, /nothing was written\./);
    assert.doesNotMatch(out, /DELETING/);
  });

  it("apply mode says what it is doing, and names the reason", () => {
    const out = cashRowRepairLines(planCashRowRepair(TENANT, [row()], USDG), "apply").join("\n");
    assert.match(out, /DELETING/);
    assert.match(out, /this is the vault's cash/);
    assert.doesNotMatch(out, /nothing was written/);
  });

  it("a refusal names the clause, so the operator can judge it themselves", () => {
    const out = cashRowRepairLines(
      planCashRowRepair(TENANT, [row({ costUsdg: "5000000" })], USDG),
      "report",
    ).join("\n");
    assert.match(out, /REFUSING/);
    assert.match(out, /cost_usdg is recorded/);
    assert.doesNotMatch(out, /would delete/);
  });
});

/**
 * THE SQL, WHICH IS WHERE THIS PASS ACTUALLY FAILED.
 *
 * The planner was right first time; the query around it was not. Its first
 * production run said `class-cash-row: FAILED — column "smart_account" does
 * not exist`, because `grants` keeps the account inside `grant_json` and there
 * is no such column. A repair whose reads are wrong reports nothing to repair,
 * which is indistinguishable from a clean ledger.
 */
describe("the pass reads the tables that exist", () => {
  const SRC = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
  const PASS = SRC.slice(
    SRC.indexOf("async function runCashRowRepairIfAsked("),
    SRC.indexOf("async function runTenantInspectIfAsked("),
  );

  it("resolves the smart account out of grant_json, not a column", () => {
    assert.ok(PASS.length > 0, "the pass must exist to be checked");
    assert.match(PASS, /grant_json->>'smartAccount' AS smart_account/);
    assert.doesNotMatch(
      PASS,
      /SELECT tenant, smart_account FROM grants/,
      "there is no smart_account column on grants",
    );
  });

  it("re-states every clause in the DELETE, so it cannot widen", () => {
    // Belt and braces against the plan being wrong about a row: even then the
    // statement can only remove something with no curve, no entry and no cost.
    assert.match(
      PASS,
      /DELETE FROM class_positions WHERE lower\(agent_id\) = lower\(\?\) AND lower\(token\) = lower\(\?\) [\s\S]{0,80}AND curve IS NULL AND entry_tx IS NULL AND cost_usdg IS NULL/,
    );
  });

  it("refuses to apply across the fleet", () => {
    assert.match(PASS, /REFUSING to apply without MERRYMEN_REPAIR_CLASS_CASH_ROW_ONLY/);
  });

  it("and VERIFIES the row is gone rather than assuming the delete worked", () => {
    assert.match(PASS, /VERIFY FAILED/);
  });
});
