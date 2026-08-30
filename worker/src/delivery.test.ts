import assert from "node:assert/strict";
import test from "node:test";
import { belowFloorBps, checkDelivery, describeDelivery } from "./delivery";

/**
 * THE INCIDENT THIS EXISTS FOR, as a fixture.
 *
 * On 2026-08-10, on chain 4663, a confirmed buy of 43,932 TOM emitted a
 * perfectly decodable Transfer log and balanceOf(wallet) returned zero. Every
 * check in netTokenDeltas passes on that log: three topics, the right topic0, a
 * parseable uint256. It is a well-formed lie, and until this module the worker
 * booked it as cost basis.
 */
const TOM = 43_932n * 10n ** 18n;

test("a well-formed Transfer log and a zero balance is the honeypot verdict", () => {
  return checkDelivery({ balanceOf: async () => 0n }).then((d) => {
    assert.equal(d.kind, "undelivered");
    const note = describeDelivery("TOM", d)!;
    assert.match(note, /balanceOf reads exactly 0/);
    // The sentence must say WHY a log is not proof, or the reader has to already
    // know the thing the guard exists to teach them.
    assert.match(note, /written by the token contract/);
  });
});

test("a real balance says nothing at all — silence is the ordinary case", async () => {
  const d = await checkDelivery({ balanceOf: async () => TOM });
  assert.deepEqual(d, { kind: "delivered", balanceRaw: TOM });
  assert.equal(describeDelivery("TOM", d), null, "this runs on EVERY buy; a tape of non-events is noise");
});

test("A FAILED READ IS NOT A ZERO — the one conflation this must never inherit", async () => {
  // token-stats.ts coerces a failed balanceOf to 0n. Sound there: it is summing
  // burn addresses and a missing one contributes nothing. Here the same
  // coercion turns an RPC hiccup into an accusation of fraud.
  const d = await checkDelivery({
    balanceOf: async () => {
      throw new Error("HTTP request failed: 503");
    },
  });
  assert.equal(d.kind, "unknown");
  assert.notEqual(d.kind, "undelivered");
  const note = describeDelivery("TOM", d)!;
  assert.match(note, /failed read, NOT a zero balance/);
});

test("a negative decode is unreadable, not undelivered", async () => {
  // Impossible from a uint256, so it means the decode is wrong — not that the
  // balance is. Reporting it as a honeypot would be manufacturing evidence.
  const d = await checkDelivery({ balanceOf: async () => -1n });
  assert.equal(d.kind, "unknown");
});

test("nothing here throws, because the swap has already settled", async () => {
  // Rule 2: the money is spent and the ledger row still needs writing. An
  // exception path at this point loses the row and changes no outcome.
  for (const balanceOf of [
    async () => 0n,
    async () => {
      throw new Error("boom");
    },
    async () => {
      throw "not even an Error";
    },
  ]) {
    await assert.doesNotReject(() => checkDelivery({ balanceOf: balanceOf as () => Promise<bigint> }));
  }
});

test("the floor check is a DIFFERENT question from the quote", () => {
  // A settled output below the minOut the op was signed with cannot come from a
  // well-behaved router — it would have reverted. So this is not "bad
  // execution", it is "the payout and the arrival are different numbers".
  assert.equal(belowFloorBps(1_000n, 1_000n), null, "at the floor is not below it");
  assert.equal(belowFloorBps(1_000n, 1_200n), null, "above the floor is the normal case");
  assert.equal(belowFloorBps(1_000n, 900n), 1_000, "10% short reads as 1000 bps");
  assert.equal(belowFloorBps(1_000n, 0n), 10_000, "nothing arrived");
});

test("the floor check refuses to divide by a floor that is not one", () => {
  // minOut is 0 on the branches that never computed one (the Rialto lane
  // executes API calldata with no floor at all). Reporting "10000 bps short"
  // there would be an artefact of the absent input, not a finding.
  assert.equal(belowFloorBps(0n, 0n), null);
  assert.equal(belowFloorBps(-5n, 1n), null);
});
