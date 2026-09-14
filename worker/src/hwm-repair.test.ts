/**
 * THE REPAIR MUST LIFT A FALSE REFUSAL AND LEAVE A REAL ONE STANDING.
 *
 * Those are the same arithmetic from the outside — a peak above equity — and
 * opposite facts underneath. Getting it wrong in one direction leaves an owner
 * unable to trade their own money; in the other it switches off the drawdown
 * breaker for somebody who is actually losing. So both are pinned here, against
 * the same shape, differing only in what the chain says happened.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planHwmRepair, repairLines, type TenantCapitalFacts } from "./hwm-repair";

/** A tenant with everything known and nothing unusual. Tests override one thing. */
const facts = (over: Partial<TenantCapitalFacts> = {}): TenantCapitalFacts => ({
  tenant: "0x8e93bad5a60a266b4283855ceffa0979720aed72",
  smartAccount: "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487",
  name: "Shogun",
  equityUsdg: 24.915968,
  currentHwmUsdg: 49.915968,
  maxDrawdownBps: 500,
  depositsUsdg: 55.701312,
  withdrawalsUsdg: 25.785344,
  internalMoves: 2,
  tradeLegs: 2,
  ambiguousMoves: 0,
  sweptAtCostUsdg: 5.0,
  sweptUnpriceable: 0,
  ratchetedProfitUsdg: 0,
  scanComplete: true,
  scanNote: null,
  ...over,
});

describe("the repair derives Shogun's peak rather than assuming it", () => {
  it("lands on 24.915968 — from the chain, not from equity", () => {
    const p = planHwmRepair(facts());

    // 25.000000 + 5.785344 (paid straight into the vault) + 24.915968 = 55.701312 in.
    // 20.000000 to the owner + 5.785344 recovery = 25.785344 out.
    // 1,063,408 DOGGOS home at a cost of 5.000000.
    assert.equal(p.netContributionsUsdg, 24.915968);
    assert.equal(p.derivedHwmUsdg, 24.915968);
    assert.equal(p.proposedHwmUsdg, 24.915968);
    assert.equal(p.ambiguous, false);

    assert.equal(p.currentDrawdownBps, 5008, "the refusal the canary hit");
    assert.equal(p.refusingNow, true);
    assert.equal(p.proposedDrawdownBps, 0, "and it is gone afterwards");

    // THE CLAMP MUST NOT HAVE FIRED. The figure has to come out of the chain on
    // its own — if the only reason it equals equity is that a clamp raised it,
    // this is the blanket "set it to equity" rule wearing a derivation's coat.
    assert.doesNotMatch(p.reason, /raised from the derived/);
    assert.match(p.reason, /55\.701312 in − 25\.785344 out − 5\.000000 swept out at cost = 24\.915968/);
  });

  it("MANUFACTURES NO PROFIT: the proposal never lands below equity", () => {
    // Same account, one fewer deposit seen. The derivation would put the peak
    // below what the account is worth, and the next tick would book the
    // difference as profit and charge a performance fee on the owner's own
    // money. The clamp stops that and says it did.
    const p = planHwmRepair(facts({ depositsUsdg: 55.701312 - 3 }));
    assert.equal(p.derivedHwmUsdg, 21.915968);
    assert.equal(p.proposedHwmUsdg, 24.915968, "clamped up to equity");
    assert.equal(p.proposedDrawdownBps, 0);
    assert.match(p.reason, /raised from the derived 21\.915968 to current equity/);
  });
});

describe("a real drawdown survives the repair", () => {
  it("A TENANT WHO LOST MONEY AND WITHDREW KEEPS THE LOSS", () => {
    // Put in 100, took 40 home, and is now worth 42 — so 18 of the 58-point gap
    // is a genuine trading loss. The peak must come down to the 60 they still
    // have in, and NOT to the 42 they are worth.
    const p = planHwmRepair(
      facts({
        equityUsdg: 42,
        currentHwmUsdg: 100,
        depositsUsdg: 100,
        withdrawalsUsdg: 40,
        sweptAtCostUsdg: 0,
      }),
    );
    assert.equal(p.proposedHwmUsdg, 60, "the withdrawal comes off the peak");
    assert.equal(p.proposedDrawdownBps, 3000, "and a 30% drawdown is still a 30% drawdown");
    assert.ok(p.proposedDrawdownBps! >= p.facts.maxDrawdownBps!, "the breaker still refuses, correctly");
  });

  it("A PURE TRADING LOSS IS NOT TOUCHED AT ALL", () => {
    // No withdrawal anywhere. Every penny of the gap is performance.
    const p = planHwmRepair(
      facts({
        equityUsdg: 60,
        currentHwmUsdg: 100,
        depositsUsdg: 100,
        withdrawalsUsdg: 0,
        sweptAtCostUsdg: 0,
      }),
    );
    assert.equal(p.deltaUsdg, 0);
    assert.equal(p.proposedDrawdownBps, 4000, "unchanged");
    assert.match(p.reason, /any drawdown here is real/);
  });

  it("profit already ratcheted into the peak is kept", () => {
    // Put in 100, earned 20 which was booked and fee'd, then withdrew 50.
    // The peak is 120 and must fall to 70 — not to 50, which would re-charge
    // the owner for profit they have already paid a fee on.
    const p = planHwmRepair(
      facts({
        equityUsdg: 70,
        currentHwmUsdg: 120,
        depositsUsdg: 100,
        withdrawalsUsdg: 50,
        sweptAtCostUsdg: 0,
        ratchetedProfitUsdg: 20,
      }),
    );
    assert.equal(p.proposedHwmUsdg, 70);
    assert.match(p.reason, /\+ 20\.000000 profit already in the peak/);
  });

  it("never raises a peak, whatever the derivation says", () => {
    const p = planHwmRepair(facts({ currentHwmUsdg: 10, equityUsdg: 10 }));
    assert.equal(p.deltaUsdg, 0, "a repair that can widen a drawdown is not a repair");
    assert.equal(p.proposedHwmUsdg, 10);
  });
});

describe("it refuses rather than guesses", () => {
  const refusals: [string, Partial<TenantCapitalFacts>, RegExp][] = [
    ["an incomplete scan", { scanComplete: false, scanNote: "RPC would not answer" }, /whole history/],
    ["an unclassifiable movement", { ambiguousMoves: 1 }, /could not be classified/],
    ["an unpriceable sweep", { sweptUnpriceable: 2 }, /no cost basis on record/],
    ["an unreadable peak", { currentHwmUsdg: null }, /could not be read/],
    ["no equity mark", { equityUsdg: null }, /no equity mark/],
    ["unknown capital totals", { depositsUsdg: null }, /could not be derived/],
    ["an unreadable profit component", { ratchetedProfitUsdg: null }, /separated from profit/],
    ["a negative derivation", { withdrawalsUsdg: 999 }, /negative peak/],
  ];

  for (const [name, over, why] of refusals) {
    it(`refuses on ${name}`, () => {
      const p = planHwmRepair(facts(over));
      assert.equal(p.ambiguous, true, "must not propose");
      assert.equal(p.proposedHwmUsdg, null, "and must not name a figure");
      assert.match(p.reason, why);
    });
  }

  it("STILL REPORTS THE REFUSED TENANT IN FULL — a refusal is not a silence", () => {
    const lines = repairLines([
      planHwmRepair(facts()),
      planHwmRepair(facts({ tenant: "0xdave", name: "SirSendIt", ambiguousMoves: 3 })),
    ]).join("\n");
    assert.match(lines, /2 tenant\(s\) examined · 1 would change · 1 ambiguous/);
    assert.match(lines, /SirSendIt/);
    assert.match(lines, /AMBIGUOUS — no change proposed/);
    assert.match(lines, /3 UNCLASSIFIABLE/);
    assert.match(lines, /NOTHING WAS WRITTEN/);
  });

  it("the report names internal moves as ignored rather than netting them in", () => {
    const lines = repairLines([planHwmRepair(facts())]).join("\n");
    assert.match(lines, /ignored: 2 internal custody move\(s\) · 2 trade leg\(s\)/);
    // The account→vault buy leg is 5.000000 and the vault→account recovery leg
    // is 5.785344. Neither may appear in the capital totals.
    assert.match(lines, /deposits 55\.701312 · withdrawals 25\.785344/);
  });
});
