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
 * And the hold that closed the first of those must not take the owner's own
 * money as profit: a deposit that lands while an op is out is booked as
 * capital once the op has settled, and no fee is charged on it meanwhile.
 *
 * look() is the whole decision reconcileFlows makes, with its reads handed in.
 * These run it the way reconcileFlows does, against a cash balance the test
 * moves, and the last blocks run it against a real ledger with a real
 * 'submitted' row, through the real fee arithmetic and the tick's ratchets.
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

const { UNRESOLVED_OP_HOLD_MS, createFlowWitness, opUsdgMoved, opsStillOut } = await import("./flow-witness");
type FlowStanding = import("./flow-witness").FlowStanding;
const { closeStoreForTest, initStore, addTrade, listSubmittedOps } = await import("./store");
const { accrueAboveHwm } = await import("./fees");
const { tickPlan, tickRatchets } = await import("./command-wake");

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const NOW = 2_000_000_000_000;
const USDG = (n: number) => BigInt(Math.round(n * 1e6));

/**
 * An account, its ledger's 'submitted' rows, and the reconciler's use of the
 * witness as reconcileFlows has it: the mark is taken before the cash is read,
 * and look() is handed the ledger read, the scan and the booking.
 */
function account(startCash: bigint) {
  const w = createFlowWitness();
  let chainCash = startCash;
  let now = NOW;
  let out: { userOpHash: string; createdAt: number }[] = [];
  const booked: bigint[] = [];
  const whys: string[] = [];
  let firsts = 0;
  return {
    w,
    booked,
    whys,
    firsts: () => firsts,
    move: (d: bigint) => void (chainCash += d),
    later: (ms: number) => void (now += ms),
    /** The executor's pre-broadcast row, then the send. */
    send(op: string) {
      out.push({ userOpHash: op, createdAt: Math.floor(now / 1000) });
      w.sent(op);
    },
    /** The resolver: what the op moved, told before its row stops reading 'submitted'. */
    settle(op: string, moved: bigint | null) {
      w.settled(op, moved);
      out = out.filter((o) => o.userOpHash !== op);
    },
    /** Another process's op: its row, and nothing this witness was told. */
    foreign(op: string) {
      out.push({ userOpHash: op, createdAt: Math.floor(now / 1000) });
    },
    /** One tick's read and reconcile; `between` runs after the cash read and before the reconcile. */
    tick(between?: () => void): Promise<FlowStanding> {
      const mark = w.mark();
      const cash = chainCash;
      between?.();
      return w.look({
        cash,
        mark,
        now,
        outstanding: async () => out,
        covered: async () => false,
        first: async () => void (firsts += 1),
        book: async (d, why) => {
          booked.push(d);
          whys.push(why);
        },
      });
    },
  };
}

describe("an op whose outcome could not be read is not the owner's withdrawal", () => {
  it("THE REVIEWER'S CASE: SENT, RECEIPT UNREAD, LANDED LATER — NO WITHDRAWAL IS BOOKED", async () => {
    const a = account(USDG(100));
    await a.tick(); // the baseline
    a.send("0xop"); // the pre-broadcast row, then the send; the receipt read fails
    assert.equal(await a.tick(), "held", "the next tick, with the 'submitted' row still out");
    a.move(-USDG(10)); // the op lands, some minutes on
    assert.equal(await a.tick(), "held", "still unresolved in the ledger");
    a.settle("0xop", -USDG(10)); // the resolver read its receipt
    assert.equal(await a.tick(), "settled");
    await a.tick();
    assert.deepEqual(a.booked, [], "every cash change here was the op, and none of it is the owner's");
  });

  it("and when the op's own move cannot be read, the window is waived — still nothing booked", async () => {
    const a = account(USDG(100));
    await a.tick();
    a.send("0xop");
    await a.tick();
    a.move(-USDG(10));
    a.settle("0xop", null); // landed, receipt unreadable
    assert.equal(await a.tick(), "waived");
    assert.deepEqual(a.booked, []);
  });

  it("an op that lands before the next look is explained by its send alone", async () => {
    const a = account(USDG(100));
    await a.tick();
    a.w.sent("0xop"); // sent; landed; its row resolved before any look saw it out
    a.move(-USDG(10));
    assert.equal(await a.tick(), "settled");
    assert.deepEqual(a.booked, []);
  });

  it("A TRADE WHOSE ROW LANDS BETWEEN THE CASH READ AND THE RECONCILE IS NOT A WITHDRAWAL NEXT TICK", async () => {
    // A trade typed in Telegram can start mid-tick. Its debit is not in this
    // tick's cash, and its row is written before this reconcile finishes.
    const a = account(USDG(100));
    await a.tick();
    await a.tick(() => {
      a.w.sent("0xtg");
      a.move(-USDG(10)); // landed
      a.w.wrote(); // recordTrade
    });
    await a.tick(); // the next tick reads the debit for the first time
    assert.deepEqual(a.booked, []);
  });

  it("a trade SENT BEFORE the mark whose row lands after the cash read is not a withdrawal next tick either", async () => {
    // The mark is taken before the cash read, not at the reconcile: a row
    // counted at the reconcile would be taken as seen by a reading whose cash
    // never saw its debit.
    const a = account(USDG(100));
    await a.tick();
    a.w.sent("0xtg");
    await a.tick(() => {
      a.move(-USDG(10)); // landed after this tick read its cash
      a.w.wrote(); // and its row lands before this reconcile
    });
    await a.tick();
    assert.deepEqual(a.booked, []);
  });

  it("BUT MONEY THAT MOVED WITH NOTHING OUT AND NOTHING WRITTEN IS STILL BOOKED — both ways", async () => {
    const a = account(USDG(100));
    await a.tick();
    a.move(-USDG(25)); // the owner took 25 out
    await a.tick();
    a.move(USDG(40)); // and put 40 in
    await a.tick();
    assert.deepEqual(a.booked, [-USDG(25), USDG(40)]);
    assert.deepEqual(a.whys, ["no trade explains this", "no trade explains this"]);
  });

  it("and once the op has settled and a clean look has passed, the next move is the owner's again", async () => {
    const a = account(USDG(100));
    await a.tick();
    a.send("0xop");
    await a.tick();
    a.move(-USDG(10));
    a.settle("0xop", -USDG(10));
    await a.tick();
    await a.tick();
    a.move(-USDG(5)); // a real withdrawal
    await a.tick();
    assert.deepEqual(a.booked, [-USDG(5)]);
  });

  it("AN OP THE LEDGER SAYS IS OUT HOLDS THE LOOK EVEN WHEN THIS PROCESS NEVER COUNTED IT", async () => {
    // The count is this process's; the ledger is shared. A probe run from the
    // CLI against the same home sends an op this worker never saw leave, and
    // its 'submitted' row is the only sign of it.
    const a = account(USDG(100));
    await a.tick();
    a.foreign("0xcli");
    a.move(-1n); // it lands, uncounted here
    assert.equal(await a.tick(), "held");
    a.settle("0xcli", -1n); // the resolver settles every row of this agent's
    assert.equal(await a.tick(), "settled");
    assert.deepEqual(a.booked, []);
  });

  it("the first look books nothing — it is the baseline, and that branch is the anchor's", async () => {
    const a = account(USDG(100));
    assert.equal(await a.tick(), "settled");
    assert.equal(a.firsts(), 1);
    await a.tick();
    assert.equal(a.firsts(), 1, "the anchor's branch runs once");
    assert.deepEqual(a.booked, []);
  });
});

/**
 * THE HOLD DEFERS; IT DOES NOT ABSORB.
 *
 * The first version absorbed every change in the window into the baseline. A
 * deposit that landed inside it was never booked as capital, and the same tick
 * charged a performance fee on it as profit.
 */
describe("money the owner moved while an op was out is booked once it settles", () => {
  it("A DEPOSIT THAT LANDS INSIDE THE HOLD IS BOOKED AS CAPITAL WHEN IT CLOSES — the op's own debit set aside", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xop");
    assert.equal(await a.tick(), "held");
    a.move(USDG(500)); // the owner deposits 500
    assert.equal(await a.tick(), "held");
    a.move(-USDG(10)); // the order lands
    assert.equal(await a.tick(), "held");
    a.settle("0xop", -USDG(10));
    assert.equal(await a.tick(), "settled");
    assert.deepEqual(a.booked, [USDG(500)]);
    assert.match(a.whys[0]!, /judged once the order that was out had settled/);
    await a.tick();
    assert.deepEqual(a.booked, [USDG(500)], "booked once");
  });

  it("a withdrawal inside the hold, and an op that SOLD (cash in), each keep their own sign", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xsell");
    await a.tick();
    a.move(USDG(37)); // the sell's proceeds
    a.move(-USDG(200)); // the owner withdraws
    a.settle("0xsell", USDG(37));
    await a.tick();
    assert.deepEqual(a.booked, [-USDG(200)]);
  });

  it("an op that REVERTED moved nothing, so the whole change is the owner's", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xop");
    await a.tick();
    a.move(USDG(50));
    a.settle("0xop", 0n);
    await a.tick();
    assert.deepEqual(a.booked, [USDG(50)]);
  });

  it("two ops out at once are both set aside", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xa");
    await a.tick();
    a.send("0xb");
    await a.tick();
    a.move(-USDG(10));
    a.move(-USDG(20));
    a.move(USDG(300));
    a.settle("0xa", -USDG(10));
    assert.equal(await a.tick(), "held", "one is still out");
    a.settle("0xb", -USDG(20));
    assert.equal(await a.tick(), "settled");
    assert.deepEqual(a.booked, [USDG(300)]);
  });

  it("an op sent and settled inside the window without ever being seen out is set aside too", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xa");
    assert.equal(await a.tick(), "held");
    // Sent after that look's ledger read, landed, and settled by the resolver
    // before the next look: never listed as out, but sent in this window.
    a.send("0xb");
    a.move(-USDG(20));
    a.settle("0xb", -USDG(20));
    a.move(-USDG(10));
    a.settle("0xa", -USDG(10));
    a.move(USDG(250));
    assert.equal(await a.tick(), "settled");
    assert.deepEqual(a.booked, [USDG(250)]);
  });

  it("AN OP THAT SETTLED WHILE THIS READING WAS BEING TAKEN MAY HAVE LANDED AFTER ITS CASH READ — judged on the next look", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xop");
    await a.tick();
    a.move(USDG(500));
    // The resolver settles it after this tick's mark and cash read: the op
    // may have landed after the read, so this reading cannot set it aside.
    assert.equal(
      await a.tick(() => {
        a.move(-USDG(10));
        a.settle("0xop", -USDG(10));
      }),
      "held",
    );
    assert.deepEqual(a.booked, []);
    assert.equal(await a.tick(), "settled");
    assert.deepEqual(a.booked, [USDG(500)]);
  });
});

describe("a window that cannot be separated is waived — absorbed, and charged no fee", () => {
  it("A TRADE'S ROW LANDED INSIDE IT — the old rule for a fill: absorbed", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xop");
    await a.tick();
    a.move(USDG(500));
    a.w.sent("0xother");
    a.move(-USDG(5));
    a.w.wrote(); // another trade landed with its row
    a.move(-USDG(10));
    a.settle("0xop", -USDG(10));
    assert.equal(await a.tick(), "waived");
    assert.deepEqual(a.booked, []);
  });

  it("A ROW WITH NO OP OF ITS OWN INSIDE IT — a brokerage fill, say — is a move nobody set aside", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xop");
    await a.tick();
    a.move(-USDG(40));
    a.w.wrote(); // a fill with a row and no op this witness saw sent
    a.move(-USDG(10));
    a.settle("0xop", -USDG(10));
    assert.equal(await a.tick(), "waived");
    assert.deepEqual(a.booked, []);
  });

  it("AN OP THAT AGED OUT UNSETTLED — the hold is bounded, and the window closes waived", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xstuck");
    await a.tick();
    a.move(USDG(500));
    a.later(UNRESOLVED_OP_HOLD_MS + 1_000); // its row is no longer taken as out
    assert.equal(await a.tick(), "waived");
    assert.deepEqual(a.booked, []);
    a.move(USDG(20)); // and inference is back
    await a.tick();
    assert.deepEqual(a.booked, [USDG(20)]);
  });

  it("AN OP THIS WINDOW NEVER HAD OUT SETTLED INSIDE IT — when it landed is unknown", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xop");
    await a.tick();
    a.w.settled("0xold", -USDG(3)); // an aged-out row the resolver found at last
    a.move(-USDG(3));
    a.settle("0xop", 0n);
    assert.equal(await a.tick(), "waived");
    assert.deepEqual(a.booked, []);
  });

  it("AN OP OUT AT THE BASELINE MAY ALREADY BE IN ITS CASH — its move cannot be set aside against it", async () => {
    const a = account(USDG(1000));
    a.send("0xop");
    a.move(-USDG(10)); // landed before the first reading, receipt unread
    await a.tick(); // the first reading: the op is out, its debit already in this cash
    assert.equal(await a.tick(), "held");
    a.move(USDG(500));
    a.settle("0xop", -USDG(10));
    assert.equal(await a.tick(), "waived", "setting -10 aside would book 510");
    assert.deepEqual(a.booked, []);
  });

  it("AN OP SETTLED WHILE THE BASELINE WAS READ MAY HAVE LANDED AFTER ITS CASH READ — the next look waives, not books", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.w.sent("0xop"); // sent, never listed as out at a look
    await a.tick(() => {
      a.move(-USDG(10)); // landed after this tick read its cash
      a.settle("0xop", -USDG(10)); // and settled before its ledger read
    });
    assert.equal(await a.tick(), "waived", "the next look must not read the op's debit as a withdrawal");
    assert.deepEqual(a.booked, []);
  });

  it("A BASELINE READ WHILE AN OP WAS OUT CANNOT ANCHOR A SEPARATION — the first reading, say", async () => {
    const a = account(USDG(1000));
    a.send("0xop");
    await a.tick(); // the first reading, with the op already out
    a.move(-USDG(10));
    a.move(USDG(500));
    a.settle("0xop", -USDG(10));
    assert.equal(await a.tick(), "waived");
    assert.deepEqual(a.booked, []);
  });

  it("AN OP SENT AND SETTLED WHILE THE BASELINE WAS BEING READ — its move may be in that cash or not", async () => {
    const a = account(USDG(1000));
    await a.tick();
    // Sent after this reading's mark, landed and settled before its ledger
    // read: the look absorbs it as a write, and the reading is not clean.
    assert.equal(
      await a.tick(() => {
        a.send("0xop");
        a.move(-USDG(10));
        a.settle("0xop", -USDG(10));
      }),
      "settled",
    );
    a.send("0xnext");
    await a.tick();
    a.move(USDG(500));
    a.settle("0xnext", 0n);
    assert.equal(await a.tick(), "waived", "a window anchored on that reading cannot be separated");
    assert.deepEqual(a.booked, []);
  });

  it("an op sent while a LATER reading is taken is out at its ledger read: that look is held, and the baseline stays", async () => {
    const a = account(USDG(1000));
    await a.tick();
    assert.equal(await a.tick(() => a.send("0xop")), "held");
    a.move(-USDG(10));
    a.move(USDG(70));
    a.settle("0xop", -USDG(10));
    assert.equal(await a.tick(), "settled", "the baseline is the reading before, which the op postdates");
    assert.deepEqual(a.booked, [USDG(70)]);
  });
});

describe("a failed read or write judges nothing", () => {
  it("A LEDGER READ THAT FAILS ABORTS THE LOOK, AND THE NEXT ONE JUDGES THE SAME WINDOW", async () => {
    const w = createFlowWitness();
    const booked: bigint[] = [];
    const look = (cash: bigint, fail = false) =>
      w.look({
        cash,
        mark: w.mark(),
        now: NOW,
        outstanding: async () => {
          if (fail) throw new Error("ledger unreachable");
          return [];
        },
        covered: async () => false,
        first: async () => {},
        book: async (d) => void booked.push(d),
      });
    await look(USDG(100));
    await assert.rejects(look(USDG(140), true));
    await look(USDG(140));
    assert.deepEqual(booked, [USDG(40)], "booked once, against the same baseline");
  });

  it("A BOOKING THAT FAILS SETTLES NOTHING, AND THE NEXT LOOK BOOKS IT", async () => {
    const w = createFlowWitness();
    const booked: bigint[] = [];
    let refuse = true;
    const look = (cash: bigint) =>
      w.look({
        cash,
        mark: w.mark(),
        now: NOW,
        outstanding: async () => [],
        covered: async () => false,
        first: async () => {},
        book: async (d) => {
          if (refuse) throw new Error("flow not recorded");
          booked.push(d);
        },
      });
    await look(USDG(100));
    await assert.rejects(look(USDG(160)));
    refuse = false;
    await look(USDG(160));
    assert.deepEqual(booked, [USDG(60)]);
  });

  it("A WINDOW'S RELEASE THAT FAILS TO BOOK KEEPS THE WINDOW, and the next look releases it", async () => {
    const a = account(USDG(1000));
    await a.tick();
    a.send("0xop");
    await a.tick();
    a.move(USDG(500));
    a.move(-USDG(10));
    a.settle("0xop", -USDG(10));
    const w = a.w;
    await assert.rejects(
      w.look({
        cash: USDG(1490),
        mark: w.mark(),
        now: NOW,
        outstanding: async () => [],
        covered: async () => false,
        first: async () => {},
        book: async () => {
          throw new Error("flow not recorded");
        },
      }),
    );
    assert.equal(await a.tick(), "settled");
    assert.deepEqual(a.booked, [USDG(500)]);
  });

  it("a scan that covered the window stands inference down, and becomes the baseline", async () => {
    const w = createFlowWitness();
    const booked: bigint[] = [];
    const look = (cash: bigint, covered: boolean) =>
      w.look({
        cash,
        mark: w.mark(),
        now: NOW,
        outstanding: async () => [],
        covered: async () => covered,
        first: async () => {},
        book: async (d) => void booked.push(d),
      });
    await look(USDG(100), false);
    assert.equal(await look(USDG(150), true), "settled");
    await look(USDG(150), false);
    assert.deepEqual(booked, []);
  });
});

describe("what counts as an op still out", () => {
  it("A 'SUBMITTED' ROW YOUNGER THAN THE HOLD IS OUT — its landing time is unknown", () => {
    assert.equal(opsStillOut([{ createdAt: (NOW - 60_000) / 1000 }], NOW), true);
    assert.equal(opsStillOut([{ createdAt: (NOW - UNRESOLVED_OP_HOLD_MS + 1_000) / 1000 }], NOW), true);
  });

  it("ONE OLDER THAN THE HOLD IS NOT — an op nobody can find must not switch inference off for good", () => {
    // The resolver never guesses: an op it cannot find stays 'submitted'
    // forever. Holding inference for as long as one exists would stop every
    // later deposit from being booked.
    assert.equal(opsStillOut([{ createdAt: (NOW - UNRESOLVED_OP_HOLD_MS - 1_000) / 1000 }], NOW), false);
    assert.equal(opsStillOut([], NOW), false);
  });

  it("the hold outlasts every read the worker gives an op, with room", () => {
    // Three receipt reads of two minutes each (executor.ts), then the stranded
    // resolver on its five-minute clock.
    assert.ok(UNRESOLVED_OP_HOLD_MS >= 3 * 120_000 + 2 * 300_000, `${UNRESOLVED_OP_HOLD_MS}`);
  });
});

describe("what an op moved, read off its receipt", () => {
  const ACCOUNT = "0x00000000000000000000000000000000000000aa";
  const VAULT = "0x00000000000000000000000000000000000000bb";
  const ROUTER = "0x00000000000000000000000000000000000000cc";
  const USDG_TOKEN = "0x00000000000000000000000000000000000000dd";
  const OTHER = "0x00000000000000000000000000000000000000ee";
  const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
  const log = (token: string, from: string, to: string, value: bigint) => ({
    address: token,
    topics: [TRANSFER, topic(from), topic(to)],
    data: `0x${value.toString(16).padStart(64, "0")}`,
  });
  const chain = (logs: ReturnType<typeof log>[] | null) => ({ getReceiptLogs: async () => logs });

  it("A BUY'S USDG LEAVES THE ACCOUNT — negative; a sell's arrives — positive", async () => {
    assert.equal(await opUsdgMoved(chain([log(USDG_TOKEN, ACCOUNT, ROUTER, 10_000_000n), log(OTHER, ROUTER, ACCOUNT, 5n)]), "0xt", ACCOUNT, USDG_TOKEN), -10_000_000n);
    assert.equal(await opUsdgMoved(chain([log(USDG_TOKEN, ROUTER, ACCOUNT, 37_000_000n)]), "0xt", ACCOUNT, USDG_TOKEN.toUpperCase().replace("0X", "0x")), 37_000_000n);
  });

  it("the ACCOUNT's cash, not its custody: a class buy's USDG sent to the vault left the account", async () => {
    assert.equal(await opUsdgMoved(chain([log(USDG_TOKEN, ACCOUNT, VAULT, 9_000_000n), log(USDG_TOKEN, VAULT, ROUTER, 9_000_000n)]), "0xt", ACCOUNT, USDG_TOKEN), -9_000_000n);
  });

  it("no USDG leg is a zero, and a receipt that cannot be read is null — never a zero", async () => {
    assert.equal(await opUsdgMoved(chain([log(OTHER, ACCOUNT, ROUTER, 1n)]), "0xt", ACCOUNT, USDG_TOKEN), 0n);
    assert.equal(await opUsdgMoved(chain(null), "0xt", ACCOUNT, USDG_TOKEN), null);
    assert.equal(
      await opUsdgMoved({ getReceiptLogs: async () => Promise.reject(new Error("429")) }, "0xt", ACCOUNT, USDG_TOKEN),
      null,
    );
  });
});

/**
 * THE SPEC'S CASE, END TO END: a real ledger holding a real 'submitted' row,
 * the witness judging it, the real fee arithmetic (fees.ts accrueAboveHwm at
 * 20%) and the tick's own ratchets deciding what is written down — the same
 * calls tick() makes, in its order: reconcile, then the risk peak, then the
 * fee rate, then the accrual.
 */
describe("against a real ledger, through the fee", () => {
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

  it("A DEPOSIT LANDING INSIDE THE HOLD IS BOOKED AS CAPITAL AFTERWARDS, AND NO FEE ACCRUES ON IT", async () => {
    await initStore();
    const agent = "0xagent0000000000000000000000000000000078";
    const hash = "0xfeed00000000000000000000000000000000000000000000000000000000f10b";
    const w = createFlowWitness();
    // The book: cash, plus a position the order buys into at cost.
    let cash = USDG(1000);
    let position = 0n;
    let hwm = USDG(1000);
    let riskPeak = USDG(1000);
    let fee = 0n;
    const booked: bigint[] = [];
    const standings: FlowStanding[] = [];
    const observed: (number | null)[] = [];
    const tick = async () => {
      const ratchet = tickRatchets(tickPlan("regular"), { incomplete: false, curveMarked: 0 });
      const mark = w.mark();
      const cashRead = cash;
      const equity = cashRead + position;
      const flows = await w.look({
        cash: cashRead,
        mark,
        now: Date.now(),
        outstanding: () => listSubmittedOps(agent),
        covered: async () => false,
        first: async () => {},
        // record(): the flow and the peaks move together (adjustAgentHwm + adjustRiskCapital).
        book: async (d) => {
          booked.push(d);
          hwm += d;
          riskPeak += d;
        },
      });
      standings.push(flows);
      await ratchet.riskPeak(Number(equity) / 1e6, async (observe) => {
        observed.push(observe);
        if (observe !== null && USDG(observe) > riskPeak) riskPeak = USDG(observe);
        return riskPeak;
      }, flows);
      const accrual = accrueAboveHwm(equity, hwm, ratchet.feeBps(2000, true, flows));
      hwm = await ratchet.accrue(accrual, hwm, async () => void (fee += accrual.feeUsdg), flows);
    };

    await tick(); // the baseline
    // The order: its pre-broadcast row, the send, and a receipt nobody could read.
    await addTrade({ agent_id: agent, kind: "swap", target: "0xrouter", amount_usdg: 10, user_op_hash: hash, status: "submitted" });
    w.sent(hash);
    await tick();
    cash += USDG(500); // the owner deposits 500 while the order is out
    await tick();
    cash -= USDG(10); // the order lands: 10 USDG into a position worth 10
    position += USDG(10);
    await tick();
    // The resolver reads the receipt, tells the witness, and resolves the row.
    w.settled(hash, -USDG(10));
    await addTrade({ agent_id: agent, kind: "swap", target: "0xrouter", amount_usdg: 10, user_op_hash: hash, tx_hash: "0xtx", status: "landed" });
    await tick();
    await tick();

    assert.deepEqual(standings, ["settled", "held", "held", "held", "settled", "settled"]);
    assert.deepEqual(booked, [USDG(500)], "the deposit is capital, booked once the order settled");
    assert.equal(fee, 0n, "no fee on the owner's own money, before or after it was booked");
    assert.equal(hwm, USDG(1500), "the peak moved with the deposit, once");
    assert.equal(riskPeak, USDG(1500), "and the risk peak with it — not raised on the deposit AND by it");
    assert.deepEqual(observed.slice(1, 4), [null, null, null], "no peak observed while the deposit was not yet capital");

    // And a real gain afterwards is still charged.
    position += USDG(100);
    await tick();
    assert.equal(fee, USDG(20));
  });
});
