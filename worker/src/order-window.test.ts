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
 * THEN THE SAME SENTENCE, ONE DEADLINE LATER. Reading the order's own window
 * moved the false "never ran" to deadline + grace, but still wrote it onto rows
 * the child had already CLAIMED — and a claimed order can still be waiting on
 * its receipt (three reads of up to two minutes each, executor.ts) when the
 * grace runs out. So the sweep now looks in the child's home before it says
 * anything: a file still queued is an order nobody took, and the child refuses
 * it at the claim from here on; a `.running` marker, or the file gone with no
 * answer, is an order somebody did take, and nothing here knows how it went.
 *
 * Driven against a real sqlite table and a real home through `ferryForChild`,
 * the function the orchestrator actually runs. Times are relative to the real
 * clock, which is the one the sweep reads.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";

import { ORDER_IN_FLIGHT_MS as SWEEP_IN_FLIGHT_MS, markRunning, writeCommand, writeCommandResult } from "./command-files";
import { wrapSqlite } from "./db";
import { ferryForChild } from "./orchestrator";
import { ORDER_IN_FLIGHT_MS, ORDER_STALE_GRACE_MS, placeHostedOrder } from "../../web/src/lib/order-state";

const TENANT = "0x1111111111111111111111111111111111111111";
const ACCOUNT = "0x2222222222222222222222222222222222222222";
const MIN = 60_000;
/** The hosted window: two 240 s ticks and a ferry pass. */
const WINDOW_MS = (2 * 240 + 15) * 1000;
const GRACE_MS = 2 * MIN;

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

const ORDER = { side: "buy", symbol: "TSLA", usdgAmount: 25 } as const;

/**
 * A trade row the ferry has already DELIVERED (claimed_at set), placed `ageMs`
 * ago. Where it is in the child's home is the test's to say — see below.
 */
function delivered(raw: DatabaseSync, id: string, ageMs: number, args?: Record<string, unknown> | null) {
  const created = Date.now() - ageMs;
  const body = args === null ? null : JSON.stringify(args ?? { ...ORDER, expiresAt: created + WINDOW_MS });
  raw
    .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at, claimed_at) VALUES (?, ?, 'trade', ?, ?, ?)")
    .run(id, ACCOUNT, body, created, created + 5_000);
  return created;
}

/** ...and still sitting in the child's queue: nobody has taken it. */
function stillQueued(raw: DatabaseSync, home: string, id: string, ageMs: number) {
  const created = delivered(raw, id, ageMs);
  writeCommand(home, { id, kind: "trade", at: created, args: { ...ORDER }, expiresAt: created + WINDOW_MS });
  return created;
}

/** ...and TAKEN by the child, which is filling it now: the claim unlinked the file and left a marker. */
function takenAndRunning(raw: DatabaseSync, home: string, id: string, ageMs: number) {
  const created = delivered(raw, id, ageMs);
  markRunning(home, id);
  return created;
}

const state = (raw: DatabaseSync, id: string) =>
  raw.prepare("SELECT claimed_at, done_at, result FROM agent_commands WHERE id = ?").get(id) as {
    claimed_at: number | null;
    done_at: number | null;
    result: string | null;
  };

const pass = (db: ReturnType<typeof wrapSqlite>, home: string) =>
  ferryForChild(db, { home, smartAccount: ACCOUNT, tag: TENANT });

/** A sentence that claims to know the order did not go out. */
const CLAIMS_NOTHING_WENT = /never ran|will not fill|nothing was sent|did not/i;

describe("the stale sweep reads the order's own window", () => {
  it("AN ORDER EIGHT MINUTES OLD, INSIDE ITS 8m15s WINDOW, IS LEFT OPEN", async () => {
    const { raw, db, home } = setup();
    stillQueued(raw, home, "live-order", 8 * MIN);
    await pass(db, home);
    assert.equal(state(raw, "live-order").done_at, null, "the child may still fill it, so nothing may say it never ran");
  });

  it("and stays open through the grace after its deadline — the slot's own grace", async () => {
    const { raw, db, home } = setup();
    stillQueued(raw, home, "in-grace", WINDOW_MS + 90_000);
    await pass(db, home);
    assert.equal(state(raw, "in-grace").done_at, null);
  });

  it("A FILE STILL QUEUED PAST ITS DEADLINE AND GRACE IS CLOSED AS NEVER RAN — nobody took it, and nobody now can", async () => {
    // The child checks `expiresAt` at the claim (command-files isExpired), so a
    // file still sitting in its queue this late can only ever be refused.
    const { raw, db, home } = setup();
    stillQueued(raw, home, "dead-order", WINDOW_MS + 2 * MIN + 30_000);
    await pass(db, home);
    const s = state(raw, "dead-order");
    assert.ok(s.done_at, "a row nothing will answer must stop holding the slot");
    assert.match(s.result ?? "", /never ran/);
    assert.doesNotMatch(s.result ?? "", /five-minute/, "the window is the order's own, not a constant");
  });

  it("an order that was never even delivered is closed as never ran, AND claimed so it never can be", async () => {
    // The down-leg hands over any row with claimed_at NULL and does not look
    // at done_at, so a row closed without being claimed would still be
    // delivered afterwards — and a deadline-less one would then run.
    const { raw, db, home } = setup();
    const created = Date.now() - 7 * MIN - 30_000;
    raw
      .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'trade', ?, ?)")
      .run("undelivered", ACCOUNT, JSON.stringify(ORDER), created);
    // The down-leg of this same pass delivers it — so to reach the sweep
    // undelivered it has to be stuck behind five older ones, as it would be.
    for (let i = 0; i < 5; i += 1) {
      raw
        .prepare("INSERT INTO agent_commands (id, agent_id, kind, args, created_at) VALUES (?, ?, 'selftest', NULL, ?)")
        .run(`probe-${i}`, ACCOUNT, created - 1_000 - i);
    }
    await pass(db, home);
    const s = state(raw, "undelivered");
    assert.ok(s.done_at);
    assert.match(s.result ?? "", /never ran/);
    assert.ok(s.claimed_at, "claimed by the sweep, so the down-leg can never hand it over");
  });

  it("a real answer that arrives later still replaces the sweep's sentence", async () => {
    // Unchanged, and pinned because it is what keeps a late answer honest if a
    // child is slower than any window we can pick.
    const { raw, db, home } = setup();
    takenAndRunning(raw, home, "slow", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + MIN);
    await pass(db, home);
    assert.ok(state(raw, "slow").done_at);
    writeCommandResult(home, { id: "slow", ok: true, line: "bought 25.00 USDG of TSLA", at: Date.now() });
    await pass(db, home);
    assert.equal(state(raw, "slow").result, "bought 25.00 USDG of TSLA");
  });
});

describe("AN ORDER THE CHILD HAS TAKEN IS NEVER CALLED 'NEVER RAN'", () => {
  it("A .running MARKER PAST DEADLINE AND GRACE LEAVES THE ROW OPEN — it may be filling right now", async () => {
    // The reviewer's case: delivered, claimed by the child (markRunning), the
    // clock past expiresAt + 2 min. The sweep wrote "never ran … Ask again".
    const { raw, db, home } = setup();
    takenAndRunning(raw, home, "inflight", WINDOW_MS + GRACE_MS + 30_000);
    await pass(db, home);
    const s = state(raw, "inflight");
    assert.equal(s.done_at, null, "left open, so the card reads 'running' and the slot stays held");
    assert.equal(s.result, null);
  });

  it("THE FILE GONE WITH NO MARKER AND NO ANSWER IS THE SAME — the child took it", async () => {
    // A crash between the claim's unlink and the marker, or a marker that could
    // not be written: the order may have gone out either way.
    const { raw, db, home } = setup();
    delivered(raw, "gone", WINDOW_MS + GRACE_MS + 30_000);
    await pass(db, home);
    assert.equal(state(raw, "gone").done_at, null);
  });

  it("past the in-flight bound it is closed with a sentence that DOES NOT CLAIM TO KNOW", async () => {
    // A child SIGKILLed mid-trade never answers, and a row nothing answers
    // must stop holding the slot eventually. What it may not do is say the
    // order did not go out.
    const { raw, db, home } = setup();
    takenAndRunning(raw, home, "marker-late", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + 30_000);
    delivered(raw, "gone-late", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + 30_000);
    await pass(db, home);
    for (const id of ["marker-late", "gone-late"]) {
      const s = state(raw, id);
      assert.ok(s.done_at, `${id}: closed at last`);
      assert.doesNotMatch(s.result ?? "", CLAIMS_NOTHING_WENT, `${id}: ${s.result}`);
      assert.match(s.result ?? "", /may have filled|whether it filled/);
      assert.match(s.result ?? "", /trades/, "it points the owner at where the answer is");
    }
  });

  it("AN ANSWER WAITING ON DISK IS NEVER TALKED OVER, even when its row could not be written this pass", async () => {
    // The up-leg leaves a result on disk when its UPDATE fails and retries next
    // pass. The sweep runs in between, and must not put its own sentence in
    // front of the worker's real one — the card repeats whatever `done` says.
    const { raw, db, home } = setup();
    takenAndRunning(raw, home, "answered", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + MIN);
    writeCommandResult(home, { id: "answered", ok: true, line: "bought 25.00 USDG of TSLA", at: Date.now() });
    raw.exec(`CREATE TRIGGER blip BEFORE UPDATE ON agent_commands WHEN NEW.result = 'bought 25.00 USDG of TSLA'
      BEGIN SELECT RAISE(ABORT, 'connection terminated'); END`);
    await pass(db, home);
    assert.equal(state(raw, "answered").done_at, null, "the answer is the up-leg's to land");
    raw.exec("DROP TRIGGER blip");
    await pass(db, home);
    assert.equal(state(raw, "answered").result, "bought 25.00 USDG of TSLA");
  });

  it("the in-flight bound is ONE figure, read by the sweep and the route's slot alike", () => {
    assert.equal(SWEEP_IN_FLIGHT_MS, ORDER_IN_FLIGHT_MS);
    assert.equal(GRACE_MS, ORDER_STALE_GRACE_MS);
  });
});

describe("the sweep and the one-at-a-time slot agree, row by row", () => {
  // THE SLOT IS WHAT LETS A SECOND ORDER IN. So wherever the sweep leaves a row
  // open because it may still trade, the route must still refuse the next one;
  // and wherever the sweep has closed it, the route must not go on refusing.
  const cases: { name: string; place: (raw: DatabaseSync, home: string) => void }[] = [
    { name: "queued, inside the window", place: (raw, home) => stillQueued(raw, home, "o", 6 * MIN) },
    { name: "queued, in the grace", place: (raw, home) => stillQueued(raw, home, "o", WINDOW_MS + 90_000) },
    { name: "queued, past deadline and grace", place: (raw, home) => stillQueued(raw, home, "o", WINDOW_MS + GRACE_MS + MIN) },
    { name: "running, past deadline and grace", place: (raw, home) => takenAndRunning(raw, home, "o", WINDOW_MS + GRACE_MS + MIN) },
    { name: "gone, past deadline and grace", place: (raw) => void delivered(raw, "o", WINDOW_MS + GRACE_MS + MIN) },
    {
      name: "running, past the in-flight bound",
      place: (raw, home) => takenAndRunning(raw, home, "o", WINDOW_MS + GRACE_MS + ORDER_IN_FLIGHT_MS + MIN),
    },
  ];
  for (const c of cases) {
    it(`${c.name}: open ⇔ a second order is refused`, async () => {
      const { raw, db, home } = setup();
      c.place(raw, home);
      await pass(db, home);
      const open = state(raw, "o").done_at === null;
      const now = Date.now();
      const second = await placeHostedOrder(db, {
        agent: ACCOUNT,
        id: "second",
        args: { ...ORDER },
        expiresAt: now + WINDOW_MS,
        now,
      });
      assert.equal(second.ok, !open, open ? "the first may still trade, so the second must wait" : "closed, so the owner may ask again");
    });
  }
});
