/**
 * THE FERRY MAY NOT CLOSE AN ORDER THE CHILD CAN STILL FILL.
 *
 * The ferry closed any unanswered trade row older than a fixed seven minutes,
 * writing "never ran" into it. The order's own window is max(5 min, 2 ticks +
 * 15 s) — 8m15s at the hosted 240 s tick — and the child enforces THAT at the
 * claim. So at the hosted cadence a row could be closed as "never ran" while
 * the child was still entitled to fill it, and the owner's card, reading
 * `done`, repeated the claim.
 *
 * Closing the row also freed the one-at-a-time slot early, so a second order
 * could be accepted while the first was still live — two in flight for what
 * the route promises is one.
 *
 * Driven against a real sqlite table through `ferryForChild`, the function the
 * orchestrator actually runs. Times are relative to the real clock, which is
 * the one the sweep reads.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { wrapSqlite } from "./db";
import { ferryForChild } from "./orchestrator";

const TENANT = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const MIN = 60_000;
/** The hosted window: two 240 s ticks and a ferry pass. */
const WINDOW_MS = (2 * 240 + 15) * 1000;

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function setup() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(`CREATE TABLE agent_commands (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, args TEXT,
    created_at INTEGER NOT NULL, claimed_at INTEGER, done_at INTEGER, result TEXT)`);
  const home = mkdtempSync(path.join(tmpdir(), "merry-window-"));
  homes.push(home);
  return { raw, db: wrapSqlite(raw), home };
}

/** A trade row, already delivered to the child (claimed), placed `ageMs` ago. */
function delivered(raw: DatabaseSync, id: string, ageMs: number, args?: Record<string, unknown> | null) {
  const created = Date.now() - ageMs;
  const body = args === null ? null : JSON.stringify(args ?? { side: "buy", symbol: "TSLA", usdgAmount: 25, expiresAt: created + WINDOW_MS });
  raw
    .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, claimed_at) VALUES (?, ?, 'trade', ?, ?, ?)")
    .run(id, ACCOUNT, body, created, created + 5_000);
}

const state = (raw: DatabaseSync, id: string) =>
  raw.prepare("SELECT done_at, result FROM agent_commands WHERE id = ?").get(id) as {
    done_at: number | null;
    result: string | null;
  };

const pass = (db: ReturnType<typeof wrapSqlite>, home: string) =>
  ferryForChild(db, { home, smartAccount: ACCOUNT, tag: TENANT });

describe("the stale sweep reads the order's own window", () => {
  it("AN ORDER EIGHT MINUTES OLD, INSIDE ITS 8m15s WINDOW, IS LEFT OPEN", async () => {
    const { raw, db, home } = setup();
    delivered(raw, "live-order", 8 * MIN);
    await pass(db, home);
    assert.equal(state(raw, "live-order").done_at, null, "the child may still fill it, so nothing may say it never ran");
  });

  it("and stays open through the grace after its deadline — the slot's own grace", async () => {
    const { raw, db, home } = setup();
    delivered(raw, "in-grace", WINDOW_MS + 90_000);
    await pass(db, home);
    assert.equal(state(raw, "in-grace").done_at, null);
  });

  it("IS CLOSED once it is past its deadline and the grace", async () => {
    const { raw, db, home } = setup();
    delivered(raw, "dead-order", WINDOW_MS + 2 * MIN + 30_000);
    await pass(db, home);
    const s = state(raw, "dead-order");
    assert.ok(s.done_at, "a row nothing will answer must stop holding the slot");
    assert.match(s.result ?? "", /never ran/);
    assert.doesNotMatch(s.result ?? "", /five-minute/, "the window is the order's own, not a constant");
  });

  it("a row with no deadline keeps the old seven-minute rule", async () => {
    // The worker treats a missing expiresAt as no expiry, but a row nothing
    // answers must still stop blocking the owner eventually.
    const { raw, db, home } = setup();
    delivered(raw, "legacy", 7 * MIN + 30_000, { side: "buy", symbol: "TSLA", usdgAmount: 25 });
    delivered(raw, "legacy-fresh", 6 * MIN, { side: "buy", symbol: "TSLA", usdgAmount: 25 });
    await pass(db, home);
    assert.ok(state(raw, "legacy").done_at);
    assert.equal(state(raw, "legacy-fresh").done_at, null);
  });

  it("a real answer that arrives later still replaces the sweep's sentence", async () => {
    // Unchanged, and pinned because it is what keeps a late fill honest if a
    // child is slower than any window we can pick.
    const { raw, db, home } = setup();
    delivered(raw, "slow", WINDOW_MS + 3 * MIN);
    await pass(db, home);
    assert.match(state(raw, "slow").result ?? "", /never ran/);
    const { writeCommandResult } = await import("./command-files");
    writeCommandResult(home, { id: "slow", ok: true, line: "bought 25.00 USDG of TSLA", at: Date.now() });
    await pass(db, home);
    assert.equal(state(raw, "slow").result, "bought 25.00 USDG of TSLA");
  });
});
