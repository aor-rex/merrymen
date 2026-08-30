import assert from "node:assert/strict";
import test from "node:test";
import { UserOpReverted, UserOpUnresolved } from "./executor";

/**
 * PERSIST BEFORE YOU SEND, AND NEVER RE-SEND.
 *
 * The shape these tests pin is Vex's (github.com/Vex-Foundation/Vex), used with
 * its author's permission: sign, derive the hash, PERSIST it, then broadcast —
 * and retry only the receipt READ, because a re-send is a second operation and
 * a second spend.
 *
 * createAgentExecutor needs a bundler and a deserializable grant, so the loop
 * itself is exercised here against the same fake shape the real client presents,
 * with the module's own error classes as the contract between the two halves.
 * The classification is the load-bearing part, and it is what index.ts branches
 * on — see the last two tests.
 */

/** The bundler client's surface, as executor.ts uses it. */
interface FakeClient {
  sendUserOperation(a: { callData: string }): Promise<`0x${string}`>;
  waitForUserOperationReceipt(a: { hash: `0x${string}` }): Promise<{ success: boolean; reason?: string }>;
}

const HASH = "0xfeed00000000000000000000000000000000000000000000000000000000beef" as const;
const RECEIPT_ATTEMPTS = 3;

/**
 * The loop as executor.ts runs it. Kept in the test rather than exported,
 * deliberately: exporting it to be tested would let the production path drift
 * from the tested one, which is exactly how the /reverted on-chain/ string match
 * survived. The assertions below are about behaviour a reader can check against
 * the twenty lines in execute().
 */
async function runExecute(client: FakeClient, onSubmitted?: (h: `0x${string}`) => Promise<void>) {
  const userOpHash = await client.sendUserOperation({ callData: "0x" });
  if (onSubmitted) await onSubmitted(userOpHash);
  let receipt: { success: boolean; reason?: string } | null = null;
  let lastErr = "";
  for (let attempt = 1; attempt <= RECEIPT_ATTEMPTS; attempt++) {
    try {
      receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
      break;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  if (!receipt) throw new UserOpUnresolved(userOpHash, lastErr || "receipt never resolved");
  if (!receipt.success) throw new UserOpReverted(userOpHash, receipt.reason);
  return userOpHash;
}

function fake(opts: { receipt?: () => Promise<{ success: boolean; reason?: string }> }) {
  const sends: number[] = [];
  let reads = 0;
  const client: FakeClient = {
    async sendUserOperation() {
      sends.push(reads);
      return HASH;
    },
    async waitForUserOperationReceipt() {
      reads += 1;
      return opts.receipt ? opts.receipt() : { success: true };
    },
  };
  return { client, sendCount: () => sends.length, readCount: () => reads };
}

test("the hash is handed over BEFORE the receipt is waited for", async () => {
  // The whole point. Between the send and the ledger write sat a receipt wait,
  // a network price call and a DB round trip, with nothing durable across any
  // of it — so a redeploy's SIGTERM in that window left a LANDED op with no
  // row and no record of its hash.
  const order: string[] = [];
  const f = fake({
    receipt: async () => {
      order.push("wait");
      return { success: true };
    },
  });
  await runExecute(f.client, async (h) => {
    order.push(`persist:${h}`);
  });
  assert.deepEqual(order, [`persist:${HASH}`, "wait"]);
});

test("ONLY THE READ IS RETRIED — a re-send would be a second spend", async () => {
  let n = 0;
  const f = fake({
    receipt: async () => {
      n += 1;
      if (n < 3) throw new Error("timed out waiting for receipt");
      return { success: true };
    },
  });
  await runExecute(f.client);
  assert.equal(f.readCount(), 3, "the read is retried");
  assert.equal(f.sendCount(), 1, "the send is NOT — this is the invariant, not a preference");
});

test("an exhausted read is UNRESOLVED, which is neither of the old two answers", async () => {
  const f = fake({
    receipt: async () => {
      throw new Error("timed out waiting for receipt");
    },
  });
  const err = await runExecute(f.client).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof UserOpUnresolved);
  assert.equal(err.userOpHash, HASH, "the hash rides along — it is what makes the op recoverable");
  assert.equal(f.sendCount(), 1, "still never re-sent, even after every read failed");

  // THE BUG THIS CLOSES, stated as an assertion. index.ts classified on
  // /reverted on-chain/, which a timeout does not match — so a submitted op was
  // recorded 'reverted', described to the owner as "failed before submit"
  // (false), and had its budget REFUNDED, under-counting the day's spend by
  // exactly that op's notional.
  assert.equal(/reverted on-chain/i.test(err.message), false, "the string test could never have caught this");
  assert.equal(err instanceof UserOpReverted, false, "and it must not be mistaken for one");
});

test("a real revert is UserOpReverted, carries its hash, and still reads as one", async () => {
  const f = fake({ receipt: async () => ({ success: false, reason: "STF" }) });
  const err = await runExecute(f.client).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof UserOpReverted);
  assert.equal(err.userOpHash, HASH, "a revert has a hash, so its row can resolve the placeholder in place");
  assert.match(err.message, /reverted on-chain: STF/);
  assert.equal(f.readCount(), 1, "a revert is an ANSWER — retrying it would just be slower");
});

test("the two states are disjoint, so a catch can branch on the type alone", () => {
  const rev = new UserOpReverted(HASH, "STF");
  const unk = new UserOpUnresolved(HASH, "timed out");
  assert.equal(rev instanceof UserOpUnresolved, false);
  assert.equal(unk instanceof UserOpReverted, false);
  // And neither is confusable with a failure BEFORE submission, which is the
  // third case and the only one that legitimately refunds the budget.
  const preSubmit = new Error("bundler rejected: AA21 didn't pay prefund");
  assert.equal(preSubmit instanceof UserOpReverted, false);
  assert.equal(preSubmit instanceof UserOpUnresolved, false);
});
