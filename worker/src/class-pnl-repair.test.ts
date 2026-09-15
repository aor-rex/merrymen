/**
 * THE REPAIR BOOKS A RESULT ONLY WHERE THE CHAIN PROVES ONE.
 *
 * Shogun's round trip is the case: 5.000000 USDG into 0x34d7…b4af on
 * 0x3d926ce734…, 1,006,167.866057921304348465 tokens back out on 0xa8ed38d8aa…
 * for 3.226758 USDG, and a `realized_pnl_usdg` of NULL where −1.773242 belongs.
 *
 * Everything it must REFUSE matters as much as the one thing it does: a sweep
 * has no result, an open position belongs to the live path, an already-booked
 * trip must not be doubled, and a trip whose exit transaction carries more than
 * one candidate row has no single honest place to write.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classPnlRepairLines, planClassPnlRepair, type ClassRoundTripFacts } from "./class-pnl-repair";

const shogun = (over: Partial<ClassRoundTripFacts> = {}): ClassRoundTripFacts => ({
  tenant: "0x8e93bad5a60a266b4283855ceffa0979720aed72",
  smartAccount: "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487",
  token: "0x34d73af0c4e41a727304b7049ff99ca3c953b4af",
  symbol: "0x34d7…b4af",
  entryTx: "0x3d926ce734000000000000000000000000000000000000000000000000000000",
  exitTx: "0xa8ed38d8aa8697378272223fe5718a62c90142b7addbe1732a81aa8f3bfcbff7",
  costRaw: 5_000_000n,
  proceedsRaw: 3_226_758n,
  qtySoldRaw: 1_006_167_866_057_921_304_348_465n,
  sweptRaw: 0n,
  state: "closed",
  exitIntentRows: 1,
  recordedRealizedUsdg: null,
  basisRemainingRaw: 0n,
  scanComplete: true,
  ...over,
});

describe("the repair derives Shogun's result from the chain", () => {
  it("BOOKS −1.773242, which is proceeds minus cost and nothing else", () => {
    const p = planClassPnlRepair(shogun());
    assert.equal(p.ambiguous, false);
    assert.equal(p.realizedRaw, -1_773_242n);
    assert.match(p.reason, /3\.226758 proceeds − 5\.000000 cost = -1\.773242 USDG/);
    assert.match(p.reason, /ClassBuy\/ClassSell/);
  });

  it("the figure is NOT taken from a balance", () => {
    // The vault holds 9.268223 USDG of unrelated reward payments. If the
    // proceeds came from a balance rather than from `ClassSell.quoteOut`, this
    // trip would read as a large gain instead of a loss.
    const p = planClassPnlRepair(shogun());
    assert.ok(p.realizedRaw! < 0n, "a balance-derived figure would be positive here");
  });
});

describe("it refuses everywhere a result cannot be proven", () => {
  const cases: [string, Partial<ClassRoundTripFacts>, RegExp][] = [
    ["an incomplete scan", { scanComplete: false }, /could not be read end to end/],
    ["a still-open position", { state: "open" }, /not closed/],
    ["a swept position", { state: "swept" }, /withdrawal has no proceeds/],
    ["a partly swept position", { sweptRaw: 1n }, /cannot be told apart/],
    ["no exit transaction", { exitTx: null }, /no exit transaction/],
    ["an unreadable cost", { costRaw: null }, /both a cost and a proceeds/],
    ["an unreadable proceeds", { proceedsRaw: null }, /both a cost and a proceeds/],
    ["a zero cost", { costRaw: 0n }, /would read as pure profit/],
    ["two candidate rows", { exitIntentRows: 2 }, /exactly one of them/],
    ["no candidate row", { exitIntentRows: 0 }, /exactly one of them/],
  ];

  for (const [name, over, why] of cases) {
    it(`refuses on ${name}`, () => {
      const p = planClassPnlRepair(shogun(over));
      assert.equal(p.ambiguous, true, "must not propose");
      assert.equal(p.realizedRaw, null, "and must not name a figure");
      assert.match(p.reason, why);
    });
  }

  it("IDEMPOTENT: a trip already booked is left exactly alone", () => {
    // The guard is the absence of a recorded result on the row the exit
    // transaction identifies — so a second run, or a run after the live path
    // has booked the same trip, changes nothing.
    const p = planClassPnlRepair(shogun({ recordedRealizedUsdg: -1.773242 }));
    assert.equal(p.ambiguous, true);
    assert.equal(p.realizedRaw, null);
    assert.match(p.reason, /already recorded as -1\.773242 — nothing to repair/);
  });
});

describe("the report shows what it is deciding from", () => {
  it("names both transactions, both chain figures, and the ledger's silence", () => {
    const lines = classPnlRepairLines([planClassPnlRepair(shogun())]).join("\n");
    assert.match(lines, /1 round trip\(s\) examined · 1 would be booked/);
    assert.match(lines, /entry 0x3d926ce734/);
    assert.match(lines, /exit  0xa8ed38d8aa/);
    assert.match(lines, /cost 5\.000000 · proceeds 3\.226758/);
    assert.match(lines, /realised NOT RECORDED/);
    // Named for WHICH ledger, because the two disagree by design: `setBasis`
    // deletes a row at zero rather than zeroing it, and the mirror skips its
    // own DELETE whenever the child is flagged `rebuilt` — so a deletion has
    // nothing to upsert over the shared row and it sits there indefinitely.
    assert.match(lines, /basis remaining \(shared\)/, "named for which ledger it is");
    assert.match(lines, /WOULD BOOK realised -1\.773242 USDG onto the exit row/);
  });

  it("and reports a refusal in full rather than omitting the trip", () => {
    const lines = classPnlRepairLines([planClassPnlRepair(shogun({ state: "swept" }))]).join("\n");
    assert.match(lines, /0 would be booked · 1 left alone/);
    assert.match(lines, /NO CHANGE — the owner swept this position out/);
  });
});
