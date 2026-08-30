/**
 * ONE OPERATION IS ONE ROW, proven against a real sqlite file.
 *
 * The durable pre-broadcast write (executor.ts's onSubmitted hook) puts a
 * 'submitted' row in the ledger the instant the op leaves. The outcome then
 * arrives later and has to land on THAT row: insert instead, and one operation
 * has two rows, the second of which counts against the daily cap a second time.
 *
 * This cannot be a unit test. The resolution is a SQL UPDATE scoped to
 * (agent_id, user_op_hash, status='submitted'), and every way it can be wrong —
 * a clause that doesn't match, a status guard that lets a settled row be
 * rewritten, an epoch that moves — is invisible to anything that doesn't run
 * the statement. That is the same reason budget-rails.integration.test.ts
 * exists: its bug was a SQL status list too.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-inflight-"));
process.env.MERRYMEN_HOME = HOME;

const { initStore, addTrade, getOpsToday, getSpentTodayUsdg } = await import("./store");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

const AGENT = "0xagent0000000000000000000000000000000001";
const HASH = "0xfeed00000000000000000000000000000000000000000000000000000000beef";
const OTHER = "0xdead00000000000000000000000000000000000000000000000000000000cafe";

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
});

const rows = (hash: string) =>
  new DatabaseSync(homePaths.db())
    .prepare("SELECT status, tx_hash, amount_usdg, epoch FROM trades WHERE agent_id = ? AND user_op_hash = ?")
    .all(AGENT, hash) as { status: string; tx_hash: string | null; amount_usdg: number; epoch: number }[];

const submitted = (hash: string, amount: number) =>
  addTrade({
    agent_id: AGENT,
    kind: "swap",
    target: "0xrouter000000000000000000000000000000001",
    amount_usdg: amount,
    user_op_hash: hash,
    status: "submitted",
  });

describe("the pre-broadcast row and the outcome are the same row", () => {
  it("initialises", async () => {
    await initStore();
  });

  it("a landed outcome RESOLVES the placeholder — it does not sit beside it", async () => {
    assert.equal(await submitted(HASH, 10), true);
    assert.equal(rows(HASH).length, 1, "the placeholder is there before the outcome");
    assert.equal(rows(HASH)[0]!.status, "submitted");

    assert.equal(
      await addTrade({
        agent_id: AGENT,
        kind: "swap",
        target: "0xrouter000000000000000000000000000000001",
        amount_usdg: 10,
        user_op_hash: HASH,
        tx_hash: "0xabc",
        status: "landed",
        fill_side: "buy",
      }),
      true,
    );

    const after1 = rows(HASH);
    assert.equal(after1.length, 1, "ONE operation, ONE row — a second would double-count the cap");
    assert.equal(after1[0]!.status, "landed");
    assert.equal(after1[0]!.tx_hash, "0xabc", "and it carries what the outcome learned");
  });

  it("the cap counts that operation once, not twice", async () => {
    // The reason the row count matters, stated in the units that bite. Both
    // 'landed' and 'submitted' are on the live rail, so a duplicate is a real
    // op and a real $10 the agent never spent.
    assert.equal(await getOpsToday(AGENT, "live"), 1);
    assert.equal(await getSpentTodayUsdg(AGENT, "live"), 10);
  });

  it("a SETTLED row can never be rewritten by a late duplicate", async () => {
    // The status guard, which is the difference between resolving a placeholder
    // and letting anything holding a hash overwrite history. A reconciler
    // arriving late with the same hash must not be able to move a landed row.
    await addTrade({
      agent_id: AGENT,
      kind: "swap",
      target: "0xrouter000000000000000000000000000000001",
      amount_usdg: 999,
      user_op_hash: HASH,
      status: "reverted",
      reject_rule: "a late arrival",
    });
    const all = rows(HASH);
    assert.equal(all.length, 2, "it inserts instead — visible, not silent");
    assert.equal(all[0]!.status, "landed", "and the settled row is untouched");
    assert.equal(all[0]!.amount_usdg, 10);
  });

  it("an outcome with no placeholder just inserts, which is every ordinary row", async () => {
    // Rejections, paper fills and failures BEFORE submission never had an
    // in-flight phase and carry no hash. The UPDATE must not swallow them.
    assert.equal(
      await addTrade({
        agent_id: AGENT,
        kind: "swap",
        target: "0xrouter000000000000000000000000000000001",
        amount_usdg: 5,
        user_op_hash: OTHER,
        status: "reverted",
        reject_rule: "couldn't submit: AA21",
      }),
      true,
    );
    assert.equal(rows(OTHER).length, 1);
    assert.equal(rows(OTHER)[0]!.status, "reverted");
  });

  it("resolving does not move the row's epoch", async () => {
    // The row belongs to the epoch it was SUBMITTED in. Moving it would make the
    // export's boundary disagree with the chain's ordering, and the export is
    // the thing a stranger is meant to be able to verify.
    const landed = rows(HASH).find((r) => r.status === "landed")!;
    const late = rows(HASH).find((r) => r.status === "reverted")!;
    assert.equal(landed.epoch, late.epoch, "same epoch here because no boundary was opened between them");
    assert.ok(Number.isInteger(landed.epoch));
  });
});
