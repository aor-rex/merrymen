/**
 * A RESTART MUST NOT LEAVE A POSITION THAT CANNOT BE SOLD.
 *
 * `class_positions` has two producers. `upsertClassPosition` writes the
 * CANDIDATE columns — symbol, decimals, quote_token, first_seen — at buy time
 * from the intent. `writeClassLedger` writes the MONEY columns from the vault's
 * own events. A child rebuilds its sqlite on redeploy, and only the second one
 * runs on the way back up.
 *
 * So a restarted agent came back holding a position it could not exit:
 *
 *   quote_token NULL   proposeClassExits refuses the row outright — both legs
 *                      are needed to route a sell, and it says so in an event.
 *   first_seen  NOW    the column defaults to unixepoch(), so the six-hour hold
 *                      clock restarted on every redeploy. While deploys kept
 *                      happening the position could never age out.
 *
 * Both are recoverable because the chain still knows: the curve names its pair
 * token, the ERC-20 names its symbol and decimals, and the ClassBuy that opened
 * the position sits in a block with a timestamp.
 *
 * Asserted as source — `rehydrateClassRow` is a closure inside the tick with a
 * live client and store behind it, and there is no seam to call it through.
 * These pin the properties that would be silently lost.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(path.join(__dirname, "index.ts"), "utf8");
const CODE = RAW.replace(/\/\*[\s\S]*?\*\//g, " ")
  .split(/\r?\n/)
  .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
  .join("\n");
const STORE = readFileSync(path.join(__dirname, "store.ts"), "utf8");

const REHYDRATE = (() => {
  const start = CODE.indexOf("async function rehydrateClassRow(");
  assert.ok(start > 0, "the rehydrator must exist");
  return CODE.slice(start, CODE.indexOf("async function reconcileClassFromChain", start));
})();

describe("the reconciler restores what a rebuild lost", () => {
  it("IS CALLED for every reconciled position", () => {
    // Restoring only some rows would leave exactly the positions a restart
    // orphaned — the ones with no candidate row at all.
    assert.match(CODE, /await rehydrateClassRow\(agentId, p, client\)/);
    const write = CODE.indexOf("await writeClassLedger(agentId, {");
    const rehydrate = CODE.indexOf("await rehydrateClassRow(");
    assert.ok(write > 0 && rehydrate > write, "money columns first, then the candidate columns");
  });

  it("reads the quote token FROM THE CURVE, which is the authority", () => {
    assert.match(REHYDRATE, /functionName: "pairToken"/);
  });

  it("and never guesses one — an unreadable curve leaves it null for the next tick", () => {
    // proposeClassExits refuses a null quoteToken by name. A guessed quote asset
    // would route a sell against the wrong pair.
    const at = REHYDRATE.indexOf('functionName: "pairToken"');
    const after = REHYDRATE.slice(at, at + 400);
    assert.match(after, /catch/, "the read must be individually tolerant");
    assert.doesNotMatch(REHYDRATE, /quoteToken = ["'`]0x/, "no hard-coded fallback quote asset");
  });

  it("WRITES ONLY WHAT IS MISSING, so a buy-path row is not restated", () => {
    assert.match(REHYDRATE, /needsLegs/);
    assert.match(REHYDRATE, /if \(!needsLegs && !needsClock\) return;/);
  });

  it("and a failure here never costs the money columns", () => {
    // The caller has just reconciled cost, quantity and state from chain. A
    // throw from a repair step must not discard that.
    const tail = REHYDRATE.slice(REHYDRATE.lastIndexOf("} catch"));
    assert.match(tail, /catch/, "the whole rehydrate is wrapped");
  });
});

describe("the hold clock comes from the chain, not from the container", () => {
  it("detects a clock that is WRONG, not one that is missing", () => {
    // first_seen defaults to unixepoch(), so a rebuilt row stamps NOW and a
    // "is it absent" test would never fire.
    assert.match(STORE, /first_seen INTEGER NOT NULL DEFAULT \(unixepoch\(\)\)/);
    assert.match(REHYDRATE, /existing\.firstSeen - estimatedOpenedAt > CLASS_CLOCK_DRIFT_SEC/);
  });

  it("estimates first so a correct row costs no RPC", () => {
    assert.match(REHYDRATE, /estimatedOpenedAt/);
    const exact = REHYDRATE.indexOf("client.getBlock({ blockNumber");
    const guard = REHYDRATE.indexOf("needsClock");
    assert.ok(guard > 0 && exact > guard, "the exact block read must sit behind the estimate");
  });

  it("takes the timestamp of the block that OPENED the position", () => {
    assert.match(REHYDRATE, /client\.getBlock\(\{ blockNumber: p\.openedAtBlock \}\)/);
    assert.match(REHYDRATE, /setClassFirstSeen\(agentId, p\.token, Number\(block\.timestamp\)\)/);
  });

  it("and the clock can ONLY EVER MOVE EARLIER", () => {
    /**
     * Guarded in SQL rather than by the caller. A write that could move the
     * clock forward is a write that could postpone an exit, and the entire
     * point of a hold timer on an asset with no oracle is that it cannot be
     * postponed. Belt and braces: even a caller passing a bogus future
     * timestamp cannot extend a position's life.
     */
    assert.match(STORE, /UPDATE class_positions SET first_seen = \?/);
    assert.match(STORE, /AND first_seen > \?/, "the row is updated only when the new value is EARLIER");
  });

  it("and it is a separate function from the general upsert, deliberately", () => {
    // upsertClassPosition excludes the clock so a top-up cannot rejuvenate a
    // position past its exit. That rule stays; this is its one exception.
    assert.match(STORE, /export async function setClassFirstSeen/);
    const upsert = STORE.slice(STORE.indexOf("INSERT INTO class_positions (agent_id, token, symbol"));
    assert.doesNotMatch(upsert.slice(0, 400), /first_seen/, "the upsert must still not touch the clock");
  });
});
