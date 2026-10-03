/**
 * THE CONVERT TICKET — at-most-once manual swaps across hosted redeploys.
 *
 * The orchestrator claims each manual swap id in shared convert_claims and
 * ferries a ticket file; the worker spends only holding an "ok" ticket naming
 * the handoff id. These tests drive the pure decision, the store claim, and
 * the file seam with real directories — against ONE sqlite handle, so like
 * the command-queue tests they prove the SQL and the file shapes, not the
 * hosted Postgres boundary itself. The boundary reasoning (child cannot read
 * shared, home dies on redeploy) is documented in convert-latch.ts; what is
 * proven here is that every ambiguous input fails closed.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-ticket-"));
process.env.MERRYMEN_HOME = HOME;

const {
  closeStoreForTest,
  initStore,
  claimConvertSwapId,
  getConvertClaimIds,
} = await import("./store");
const {
  decideConvertTicket,
  manualTicketAllows,
  readConvertTicket,
} = await import("./convert-latch");

const AGENT = "0xagent00000000000000000000000000000000a1";

after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("convert ticket decision", () => {
  it("issues a fresh handoff", () => {
    assert.deepEqual(
      decideConvertTicket({ handoffId: "swap-1", completedIds: [], claimedIds: [], ticketInHome: null }),
      { action: "issue" },
    );
  });

  it("leaves an in-flight ticket alone", () => {
    assert.deepEqual(
      decideConvertTicket({
        handoffId: "swap-1",
        completedIds: [],
        claimedIds: ["swap-1"],
        ticketInHome: { id: "swap-1", status: "ok" },
      }),
      { action: "pending" },
    );
  });

  it("cleans up when the id completed", () => {
    assert.deepEqual(
      decideConvertTicket({
        handoffId: "swap-1",
        completedIds: ["swap-1"],
        claimedIds: ["swap-1"],
        ticketInHome: { id: "swap-1", status: "ok" },
      }),
      { action: "done" },
    );
  });

  it("cleans up when the handoff is gone", () => {
    assert.deepEqual(
      decideConvertTicket({ handoffId: null, completedIds: [], claimedIds: ["swap-1"], ticketInHome: null }),
      { action: "done" },
    );
  });

  it("BLOCKS broadcast → redeploy before mirror with the same id", () => {
    // The crash Kaka named: the swap broadcast, the home died before the
    // mirror carried the completion up. Shared state now holds the claim but
    // no completion, and the fresh home holds no ticket. Re-issuing would
    // replay the spend — the only safe answer is blocked.
    assert.deepEqual(
      decideConvertTicket({
        handoffId: "swap-1",
        completedIds: [],
        claimedIds: ["swap-1"],
        ticketInHome: null,
      }),
      { action: "blocked" },
    );
  });

  it("unblocks once the mirror lands the completion", () => {
    assert.deepEqual(
      decideConvertTicket({
        handoffId: "swap-1",
        completedIds: ["swap-1"],
        claimedIds: ["swap-1"],
        ticketInHome: null,
      }),
      { action: "done" },
    );
  });

  it("changes nothing when storage is unreachable", () => {
    // claimedIds null = the claims read failed. "done" here means "remove any
    // ticket and touch nothing" — crucially never "issue".
    assert.deepEqual(
      decideConvertTicket({ handoffId: "swap-1", completedIds: [], claimedIds: null, ticketInHome: null }),
      { action: "done" },
    );
  });

  it("a blocked ticket already in the home stays blocked", () => {
    assert.deepEqual(
      decideConvertTicket({
        handoffId: "swap-1",
        completedIds: [],
        claimedIds: ["swap-1"],
        ticketInHome: { id: "swap-1", status: "blocked" },
      }),
      { action: "blocked" },
    );
  });
});

describe("worker ticket gate", () => {
  it("goes only on an ok ticket naming the handoff", () => {
    assert.equal(manualTicketAllows({ status: "ok", id: "swap-1", issuedAtMs: 1 }, "swap-1"), "go");
  });

  it("waits silently with no ticket or a foreign ticket", () => {
    assert.equal(manualTicketAllows(null, "swap-1"), "wait");
    assert.equal(manualTicketAllows({ status: "ok", id: "swap-2", issuedAtMs: 1 }, "swap-1"), "wait");
  });

  it("alerts on a blocked ticket naming the handoff", () => {
    assert.equal(manualTicketAllows({ status: "blocked", id: "swap-1", issuedAtMs: 1 }, "swap-1"), "blocked");
  });

  it("reads real ticket files, strictly", () => {
    const f = path.join(HOME, "ticket-probe.json");
    writeFileSync(f, JSON.stringify({ status: "ok", id: "swap-1", issuedAtMs: 7 }), "utf8");
    assert.deepEqual(readConvertTicket(readFileSync(f, "utf8")), { status: "ok", id: "swap-1", issuedAtMs: 7 });
    writeFileSync(f, "{not json", "utf8");
    assert.equal(readConvertTicket(readFileSync(f, "utf8")), null);
    writeFileSync(f, JSON.stringify({ status: "ok", id: "../evil", issuedAtMs: 7 }), "utf8");
    assert.equal(readConvertTicket(readFileSync(f, "utf8")), null);
    writeFileSync(f, JSON.stringify({ status: "maybe", id: "swap-1" }), "utf8");
    assert.equal(readConvertTicket(readFileSync(f, "utf8")), null);
  });
});

describe("convert claims store", () => {
  it("initialises", async () => {
    await initStore();
  });

  it("a claim authorizes exactly once", async () => {
    assert.equal(await claimConvertSwapId(AGENT, "swap-1", []), "claimed");
    assert.equal(await claimConvertSwapId(AGENT, "swap-1", []), "already");
    assert.deepEqual(await getConvertClaimIds(AGENT), ["swap-1"]);
  });

  it("prunes ids the child has since completed", async () => {
    assert.equal(await claimConvertSwapId(AGENT, "swap-2", ["swap-1"]), "claimed");
    assert.deepEqual(await getConvertClaimIds(AGENT), ["swap-2"]);
  });

  it("an unknown agent has no claims, not a failure", async () => {
    assert.deepEqual(await getConvertClaimIds("0xagent00000000000000000000000000000000ff"), []);
  });
});
