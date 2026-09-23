/**
 * A CASH CHANGE IS ONLY THE OWNER'S WHEN NOTHING THIS PROCESS DID CAN EXPLAIN IT.
 *
 * Flow inference books a cash change as money the owner moved — "📤 withdrawn
 * X USDG (no trade explains this)", the high-water mark moved with it, and a
 * fee possible in the same tick, never reversed — when no ledger write happened
 * since the last look. Two things this process does move cash without the
 * write it counted:
 *
 *   - an op whose receipt could not be read (UserOpUnresolved), or that
 *     something after the send failed on. The pre-broadcast 'submitted' row is
 *     written outside recordTrade, so it was never counted; the op may land
 *     minutes later, and the next reconcile booked its debit as a withdrawal.
 *   - a trade whose row lands between the tick's cash read and the reconcile.
 *     The count was snapshotted at the END of the reconcile, so its row was
 *     taken as seen while the cash read had not seen its debit yet.
 *
 * These run the witness the way reconcileFlows runs it, against a cash balance
 * the test moves, and the last block runs the outstanding-op read against a
 * real ledger with a real 'submitted' row in it.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-flow-witness-"));
process.env.MERRYMEN_HOME = HOME;

const { UNRESOLVED_OP_HOLD_MS, createFlowWitness, opsStillOut } = await import("./flow-witness");
const { closeStoreForTest, initStore, addTrade, listSubmittedOps } = await import("./store");

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/**
 * An account and the reconciler's use of the witness, as reconcileFlows has
 * it: the mark is taken before the cash is read, the inference branch asks
 * `unexplained`, and the reading is settled as the new baseline.
 */
function account(startCash: bigint) {
  const w = createFlowWitness();
  let chainCash = startCash;
  let lastCash: bigint | null = null;
  const booked: bigint[] = [];
  return {
    w,
    booked,
    move: (d: bigint) => void (chainCash += d),
    /** One tick's read and reconcile; `between` runs after the cash read and before the reconcile. */
    tick(opsOutstanding: boolean, between?: () => void) {
      const mark = w.mark();
      const cash = chainCash;
      between?.();
      // record() books nothing for a zero change.
      if (lastCash !== null && w.unexplained({ opsOutstanding }) && cash !== lastCash) booked.push(cash - lastCash);
      lastCash = cash;
      w.settle({ mark, opsOutstanding });
    },
  };
}

describe("an op whose outcome could not be read is not the owner's withdrawal", () => {
  it("THE REVIEWER'S CASE: SENT, RECEIPT UNREAD, LANDED LATER — NO WITHDRAWAL IS BOOKED", () => {
    const a = account(100_000_000n);
    a.tick(false); // the baseline
    a.w.wrote(); // onSubmitted: the pre-broadcast row, then the send; the receipt read fails
    a.tick(true); // the next tick, with the 'submitted' row still out
    a.move(-10_000_000n); // the op lands, some minutes on
    a.tick(true); // still unresolved in the ledger
    a.tick(false); // the resolver settled it: nothing out now, but it was out last time
    a.tick(false);
    assert.deepEqual(a.booked, [], "every cash change here was the op, and none of it is the owner's");
  });

  it("an op that lands before the next look is explained by its send alone", () => {
    const a = account(100_000_000n);
    a.tick(false);
    a.w.wrote(); // sent
    a.move(-10_000_000n); // landed, but the receipt read failed: no row, no second write
    a.tick(false); // and a ledger read that says nothing is out (the row was resolved already)
    assert.deepEqual(a.booked, []);
  });

  it("A TRADE WHOSE ROW LANDS BETWEEN THE CASH READ AND THE RECONCILE IS NOT A WITHDRAWAL NEXT TICK", () => {
    // A trade typed in Telegram can start mid-tick. Its debit is not in this
    // tick's cash, and its row is written before this reconcile finishes.
    const a = account(100_000_000n);
    a.tick(false);
    a.tick(false, () => {
      a.w.wrote(); // sent
      a.move(-10_000_000n); // landed
      a.w.wrote(); // recordTrade
    });
    a.tick(false); // the next tick reads the debit for the first time
    assert.deepEqual(a.booked, []);
  });

  it("BUT MONEY THAT MOVED WITH NOTHING OUT AND NOTHING WRITTEN IS STILL BOOKED — both ways", () => {
    const a = account(100_000_000n);
    a.tick(false);
    a.move(-25_000_000n); // the owner took 25 out
    a.tick(false);
    a.move(40_000_000n); // and put 40 in
    a.tick(false);
    assert.deepEqual(a.booked, [-25_000_000n, 40_000_000n]);
  });

  it("and once the op has settled and a clean look has passed, the next move is the owner's again", () => {
    const a = account(100_000_000n);
    a.tick(false);
    a.w.wrote();
    a.tick(true);
    a.move(-10_000_000n);
    a.tick(false);
    a.tick(false);
    a.move(-5_000_000n); // a real withdrawal
    a.tick(false);
    assert.deepEqual(a.booked, [-5_000_000n]);
  });

  it("AN OP THE LEDGER SAYS IS OUT HOLDS THE LOOK EVEN WHEN THIS PROCESS NEVER COUNTED IT", () => {
    // The count is this process's; the ledger is shared. A probe run from the
    // CLI against the same home sends an op this worker never saw leave, and
    // its 'submitted' row is the only sign of it.
    const a = account(100_000_000n);
    a.tick(false);
    a.move(-1n); // another process's op lands, uncounted here
    a.tick(true);
    assert.deepEqual(a.booked, []);
  });

  it("the first look books nothing — it is the baseline, and that branch is the anchor's", () => {
    const a = account(100_000_000n);
    a.tick(false);
    assert.deepEqual(a.booked, []);
    assert.equal(createFlowWitness().unexplained({ opsOutstanding: false }), false, "no settled reading, nothing to compare");
  });
});

describe("what counts as an op still out", () => {
  const NOW = 2_000_000_000_000;
  it("A 'SUBMITTED' ROW YOUNGER THAN THE HOLD IS OUT — its landing time is unknown", () => {
    assert.equal(opsStillOut([{ createdAt: (NOW - 60_000) / 1000 }], NOW), true);
    assert.equal(opsStillOut([{ createdAt: (NOW - UNRESOLVED_OP_HOLD_MS + 1_000) / 1000 }], NOW), true);
  });

  it("ONE OLDER THAN THE HOLD IS NOT — an op nobody can find must not switch inference off for good", () => {
    // The resolver never guesses: an op it cannot find stays 'submitted'
    // forever. Holding inference for as long as one exists would stop every
    // later deposit from being booked, and a deposit not booked as capital is
    // charged a fee as profit.
    assert.equal(opsStillOut([{ createdAt: (NOW - UNRESOLVED_OP_HOLD_MS - 1_000) / 1000 }], NOW), false);
    assert.equal(opsStillOut([], NOW), false);
  });

  it("the hold outlasts every read the worker gives an op, with room", () => {
    // Three receipt reads of two minutes each (executor.ts), then the stranded
    // resolver on its five-minute clock.
    assert.ok(UNRESOLVED_OP_HOLD_MS >= 3 * 120_000 + 2 * 300_000, `${UNRESOLVED_OP_HOLD_MS}`);
  });
});

describe("against a real ledger", () => {
  const AGENT = "0xagent0000000000000000000000000000000077";
  const HASH = "0xfeed00000000000000000000000000000000000000000000000000000000f10a";
  const row = (status: "submitted" | "landed") =>
    addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0xrouter000000000000000000000000000000001",
      amount_usdg: 10,
      user_op_hash: HASH,
      ...(status === "landed" ? { tx_hash: "0xresolved" } : {}),
      status,
    });

  it("A PRE-BROADCAST ROW WITH NO OUTCOME HOLDS INFERENCE, AND ITS RESOLUTION RELEASES IT", async () => {
    await initStore();
    assert.equal(opsStillOut(await listSubmittedOps(AGENT), Date.now()), false, "nothing out yet");
    assert.equal(await row("submitted"), true);
    assert.equal(opsStillOut(await listSubmittedOps(AGENT), Date.now()), true, "the op left and nobody knows how it went");
    assert.equal(await row("landed"), true);
    assert.equal(opsStillOut(await listSubmittedOps(AGENT), Date.now()), false, "resolved in place");
  });
});
