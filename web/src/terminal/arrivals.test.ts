/**
 * WHAT COUNTS AS NEWS: a real-money trade that landed, seen for the first time.
 *
 * The chime and the tab title both count these, and both would be worse than
 * silence if they counted wrong — a chime on every page load, a title that
 * climbs on the feed's scheduled holds, a paper fill announced like money.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { outcomeOf } from "../../../worker/src/thesis-policy";
import type { Thesis } from "./live";
import { createArrivals, isLandedTrade } from "./arrivals";

const NOW = 1_800_000_000;
let n = 0;
const row = (over: Partial<Thesis> = {}): Thesis =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action: "buy",
    symbol: "CASHCAT",
    sizeUsdg: 5,
    reason: "r",
    paper: false,
    head: "bought CASHCAT",
    outcome: "landed",
    at: NOW - 30,
    postId: (++n).toString(16).padStart(32, "0"),
    ...over,
  }) as Thesis;

describe("a landed trade", () => {
  it("is a real-money buy or sell that landed, with an id to remember it by", () => {
    assert.equal(isLandedTrade(row()), true);
    assert.equal(isLandedTrade(row({ action: "sell" })), true);
  });

  it("is not a hold, a refusal, a pending order, a paper fill, a shadow, or a post with no id", () => {
    assert.equal(isLandedTrade(row({ action: "hold" })), false);
    assert.equal(isLandedTrade(row({ outcome: "refused" })), false);
    assert.equal(isLandedTrade(row({ outcome: "pending" })), false);
    assert.equal(isLandedTrade(row({ paper: true })), false, "a paper fill is simulated money");
    assert.equal(isLandedTrade(row({ shadow: true })), false);
    assert.equal(isLandedTrade(row({ outcome: "shadow" })), false);
    assert.equal(isLandedTrade(row({ postId: null })), false, "nothing stable to diff it by");
  });

  it("a paper fill is not money even after its agent has gone live", () => {
    // `paper` on a post is the AUTHOR'S mode at its last heartbeat
    // (thesis-policy.ts), not the fill's. A fill booked on paper minutes before
    // the owner switched the agent to live arrives with paper:false — and was
    // never announced while it was paper, so the first read after the switch
    // would chime it as a real trade. The fill's own status still says it.
    // Pinned to the producer's own words, so a rephrasing there fails here.
    assert.equal(isLandedTrade(row({ paper: false, outcomeText: outcomeOf("paper", null).text })), false);
    assert.equal(isLandedTrade(row({ paper: false, outcomeText: outcomeOf("landed", null).text })), true);
  });
});

describe("arrivals, read by read", () => {
  it("NEVER ON FIRST LOAD: everything already on the feed is what the reader walked in on", () => {
    const a = createArrivals();
    assert.deepEqual(a.take([row(), row()], NOW), { rows: [], fills: 0 });
  });

  it("a landed trade that was not there before is news, once", () => {
    const a = createArrivals();
    const old = row();
    a.take([old], NOW);
    const fresh = row({ action: "sell" });
    assert.deepEqual(a.take([fresh, old], NOW).rows.map((t) => t.postId), [fresh.postId]);
    assert.deepEqual(a.take([fresh, old], NOW + 10).rows, [], "the next read has nothing new");
  });

  it("a pending trade that lands is news when it lands — the id is the same, the outcome is not", () => {
    const a = createArrivals();
    const pending = row({ outcome: "pending" });
    a.take([pending], NOW);
    assert.deepEqual(a.take([{ ...pending, outcome: "landed" }], NOW).rows.length, 1);
  });

  it("THE SAME SHAPE FILLING AGAIN IS NEWS — a post id names a thesis, not a trade", () => {
    // postId hashes slug, action, symbol, size, reason and shadow, and the feed
    // groups every landed copy of one post into a single row whose `at` is the
    // newest copy. A steady-basket leg says the same sentence on every tick, so
    // its second fill arrives as the SAME id with a newer `at` (and a bigger
    // `said`) — and keyed on the id alone it was never announced again.
    const a = createArrivals();
    const earlier = NOW - 4 * 3600;
    a.take([], earlier);
    const leg = row({ at: earlier - 10, said: 1 });
    assert.equal(a.take([leg], earlier).rows.length, 1, "the first fill is news");
    const again = { ...leg, at: NOW - 10, said: 2 };
    assert.deepEqual(a.take([again], NOW).rows.map((t) => t.at), [NOW - 10], "and so is the next fill of the same shape");
    assert.deepEqual(a.take([again], NOW + 10).rows, [], "the same copy read again is not");
  });

  it("a leg that filled before the page opened still announces its next fill", () => {
    const a = createArrivals();
    const leg = row({ at: NOW - 2 * 3600, said: 3 });
    a.take([leg], NOW - 60);
    assert.deepEqual(a.take([{ ...leg, at: NOW - 5, said: 4 }], NOW).rows.length, 1);
  });

  it("AN OLDER ORDER THAT LANDS AFTER A NEWER COPY IS NEWS — `at` stands still, `said` grew", () => {
    // The row's `at` is MAX(d.at) over its landed copies: the newest DECISION,
    // not the newest fill. An order sent earlier that lands after a later copy
    // already has joins the row without moving `at`; only `said` says so.
    const a = createArrivals();
    const leg = row({ at: NOW - 3000, said: 1 });
    a.take([leg], NOW);
    const newer = { ...leg, at: NOW - 20, said: 2 };
    assert.deepEqual(a.take([newer], NOW), { rows: [newer], fills: 1 });
    const older = { ...leg, at: NOW - 20, said: 3 };
    assert.deepEqual(a.take([older], NOW + 10), { rows: [older], fills: 1 }, "the order that landed late");
    assert.deepEqual(a.take([older], NOW + 20), { rows: [], fills: 0 }, "and read again it is not");
  });

  it("TWO FILLS OF ONE POST BETWEEN TWO READS ARE TWO FILLS — the title counts both", () => {
    const a = createArrivals();
    const leg = row({ at: NOW - 3000, said: 1 });
    a.take([leg], NOW);
    const two = { ...leg, at: NOW - 5, said: 3 };
    assert.deepEqual(a.take([two], NOW), { rows: [two], fills: 2 }, "one row, one tone, two fills");
  });

  it("a row seen for the first time is one fill, whatever its count — its older copies may predate the page", () => {
    const a = createArrivals();
    a.take([], NOW);
    const first = row({ at: NOW - 10, said: 3 });
    assert.deepEqual(a.take([first], NOW), { rows: [first], fills: 1 });
  });

  it("COPIES LEAVING THE WINDOW ARE NOT NEWS — `said` shrinks with time and must not re-announce", () => {
    const a = createArrivals();
    const leg = row({ at: NOW - 60, said: 5 });
    a.take([leg], NOW);
    assert.deepEqual(a.take([{ ...leg, said: 4 }], NOW + 10).rows, [], "an old copy left the 24h window");
    assert.deepEqual(a.take([{ ...leg, said: 3 }], NOW + 20).rows, [], "and another");
    const late = { ...leg, said: 4 };
    assert.deepEqual(a.take([late], NOW + 30), { rows: [late], fills: 1 }, "grown against the last read, it is a fill");
    const next = { ...leg, at: NOW + 35, said: 4 };
    assert.deepEqual(a.take([next], NOW + 40), { rows: [next], fills: 1 }, "a new copy while an old one left is still one fill");
  });

  it("a row whose time went BACK is a different grouping of the same post, not news — and not news when it comes back", () => {
    const a = createArrivals();
    const leg = row({ at: NOW - 30, said: 4 });
    a.take([leg], NOW);
    assert.deepEqual(a.take([{ ...leg, at: NOW - 200, said: 1 }], NOW + 10).rows, []);
    assert.deepEqual(a.take([leg], NOW + 20).rows, [], "the row it was, read again");
  });

  it("`said` growing on a row whose last copy is long past is not announced — nor is one with no count", () => {
    const a = createArrivals();
    const stale = row({ at: NOW - 3 * 3600, said: 1 });
    const bare = row({ at: NOW - 30, said: undefined });
    a.take([stale, bare], NOW);
    assert.deepEqual(a.take([{ ...stale, said: 2 }], NOW + 10).rows, [], "a deploy that widens the window must not chime old rows");
    assert.deepEqual(a.take([{ ...bare }], NOW + 20).rows, [], "no count, no growth to read");
  });

  it("a fill first seen long after it happened is not news — a reader re-ranking old rows must not chime", () => {
    const a = createArrivals();
    a.take([], NOW);
    assert.deepEqual(a.take([row({ at: NOW - 3 * 3600 })], NOW).rows, []);
    assert.deepEqual(a.take([row({ at: undefined })], NOW).rows, [], "and one with no time has no age to judge");
  });

  it("several at once come back oldest first", () => {
    const a = createArrivals();
    a.take([], NOW);
    const later = row({ at: NOW - 5 });
    const earlier = row({ at: NOW - 50 });
    assert.deepEqual(a.take([later, earlier], NOW).rows.map((t) => t.at), [NOW - 50, NOW - 5]);
  });

  it("remembers a bounded number of ids", () => {
    const a = createArrivals({ cap: 3 });
    a.take([row(), row(), row(), row(), row()], NOW);
    assert.equal(a.size(), 3);
  });
});

/**
 * ONE POST, SEVERAL LANDED ROWS IN ONE READ (R3L-1). The feed groups by size
 * as well as words, and a private book publishes no size, so its post id
 * (which hashes the published size) is one id for every size: a steady-basket
 * leg clamped by cash or the day's headroom lands in a second row under the
 * same id. Remembering one {at, said} per id compared one row's count with
 * another's: one new fill counted as the difference of two groups' counts,
 * and an order that landed late into the older group was never counted.
 * Built from the real reader over the real ledger schema.
 */
describe("one post, several landed rows in one read (R3L-1)", () => {
  const SLUG = "ems76d3cncwbt3dz";
  const A = "0xAaAa000000000000000000000000000000000001";
  const USDG = "0x05d0000000000000000000000000000000000005";
  const TSLA = "0x7e5a000000000000000000000000000000007e5a";

  async function ledger() {
    const { DatabaseSync } = await import("node:sqlite");
    const { wrapSqlite } = await import("../../../worker/src/db");
    const { applyLedgerSchema } = await import("../../../worker/src/store");
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    await applyLedgerSchema(db);
    const now = Math.floor(Date.now() / 1000);
    raw
      .prepare(
        `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, created_at, name, mode, beat_at)
         VALUES (?, '0x0000000000000000000000000000000000000abc', '0x0000000000000000000000000000000000000def', 4663, '{}', ?, ?, 'armed', ?, 'Shogun', 'live', ?)`,
      )
      .run(A, now - 86400, now + 86400, now - 86400, now - 30);
    // The public sentence the dca leg wrote before CF1 — the reader scrubs a
    // private book's figure out of it, so every size reads the same.
    const decide = (id: string, size: number, ago: number, status: "landed" | "submitted") => {
      raw
        .prepare(`INSERT INTO decisions (id, agent_id, source, action, symbol, size_usdg, reason, at) VALUES (?, ?, 'strategy:steady-basket', 'buy', 'TSLA', ?, ?, ?)`)
        .run(id, A, size, `the schedule says buy — ${size.toFixed(2)} USDG into TSLA, its 50% of a 2-leg basket`, now - ago);
      raw
        .prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, decision_id, created_at) VALUES (?, 'swap', '0x0', ?, ?, ?, ?, ?, ?)`)
        .run(A, USDG, TSLA, size, status, id, now - ago);
    };
    const land = (id: string) => raw.prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, decision_id, created_at) VALUES (?, 'swap', '0x0', ?, ?, 1, 'landed', ?, ?)`).run(A, USDG, TSLA, id, now);
    const { readTheses } = await import("../lib/read-theses");
    const identities = async () => [{ tenant: "0x1" as const, slug: SLUG, accounts: [A.toLowerCase() as `0x${string}`], createdAt: 1, updatedAt: 1 }];
    const privateBook = (async () => ({ strategy: "steady" })) as never;
    const read = async () => (await readTheses({}, (fn) => fn(db), identities, privateBook)).theses as unknown as Thesis[];
    return { raw, decide, land, read, now };
  }

  it("A NEW FILL IS ONE FILL, AND AN ORDER LANDING LATE INTO THE OTHER SIZE'S ROW IS ONE FILL — nothing is none", async () => {
    const L = await ledger();
    try {
      for (let i = 0; i < 5; i++) L.decide(`a${i}`, 10, 600 - i * 60, "landed");
      L.decide("b0", 3.7, 300, "landed");
      L.decide("c0", 3.7, 250, "submitted");
      const a = createArrivals();
      const seed = await L.read();
      const landed = seed.filter(isLandedTrade);
      assert.equal(landed.length, 2, "two landed rows");
      assert.equal(new Set(landed.map((t) => t.postId)).size, 1, "under one post id");
      assert.deepEqual(a.take(seed, L.now), { rows: [], fills: 0 }, "the first read is the page");

      L.decide("a5", 10, 200, "landed");
      const one = a.take(await L.read(), L.now);
      assert.equal(one.fills, 1, "one new 10.00 leg is one fill");
      assert.equal(one.rows.length, 1);
      assert.equal(one.rows[0]!.at, L.now - 200, "chimed for the post's newest row");

      L.land("c0"); // the 3.70 order decided at -250 lands after the -200 leg
      const late = a.take(await L.read(), L.now);
      assert.equal(late.fills, 1, "the order that landed late, in the other size's row");
      assert.equal(late.rows.length, 1);

      assert.deepEqual(a.take(await L.read(), L.now), { rows: [], fills: 0 }, "and read again, nothing");
    } finally {
      L.raw.close();
    }
  });

  it("folded by post: two rows' counts add, the newest time leads, and one row leaving is not news", () => {
    const a = createArrivals();
    const id = "f".repeat(32);
    const big = row({ postId: id, at: NOW - 400, said: 5, sizeUsdg: null });
    const small = row({ postId: id, at: NOW - 300, said: 1, sizeUsdg: null });
    a.take([big, small], NOW);
    // Read in either order, a fill in the older row is one fill.
    assert.deepEqual(a.take([small, { ...big, said: 6 }], NOW).fills, 1);
    assert.deepEqual(a.take([{ ...big, said: 6 }, small], NOW).fills, 0, "the same read again");
    const newer = { ...big, at: NOW - 100, said: 7 };
    assert.deepEqual(a.take([small, newer], NOW), { rows: [newer], fills: 1 }, "a new copy moves the post's newest time");
    assert.deepEqual(a.take([newer], NOW).fills, 0, "the other size's row left the read: fewer copies, no fill");
  });

  it("a folded post with any row of unknown count grows by nothing — only a newer time is a fill", () => {
    const a = createArrivals();
    const id = "e".repeat(32);
    a.take([row({ postId: id, at: NOW - 400, said: 2 }), row({ postId: id, at: NOW - 300, said: undefined })], NOW);
    assert.deepEqual(a.take([row({ postId: id, at: NOW - 400, said: 5 }), row({ postId: id, at: NOW - 300, said: undefined })], NOW).fills, 0);
    assert.deepEqual(a.take([row({ postId: id, at: NOW - 100, said: 5 }), row({ postId: id, at: NOW - 300, said: undefined })], NOW).fills, 1);
  });
});
