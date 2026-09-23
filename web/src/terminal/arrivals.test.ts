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

  it("each row of a post against itself: a new copy moves the post's newest time, and a row leaving or coming back is not news", () => {
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
    assert.deepEqual(a.take([small, newer], NOW), { rows: [], fills: 0 }, "and it came back with the copy it always had: no fill");
  });

  // Folded into one total (round 4), a row with no count made the whole
  // post's growth unknown. Measured row by row, it only hides its own.
  it("a row of unknown count grows by nothing, and hides no other row's growth — a newer time on it is one fill", () => {
    const a = createArrivals();
    const id = "e".repeat(32);
    a.take([row({ postId: id, at: NOW - 400, said: 2 }), row({ postId: id, at: NOW - 300, said: undefined })], NOW);
    assert.deepEqual(a.take([row({ postId: id, at: NOW - 400, said: 2 }), row({ postId: id, at: NOW - 300, said: undefined })], NOW).fills, 0);
    assert.deepEqual(a.take([row({ postId: id, at: NOW - 400, said: 5 }), row({ postId: id, at: NOW - 300, said: undefined })], NOW).fills, 3, "three late landings in the counted row");
    assert.deepEqual(a.take([row({ postId: id, at: NOW - 400, said: 5 }), row({ postId: id, at: NOW - 100, said: undefined })], NOW).fills, 1);
  });
});

/**
 * A ROW THAT LEAVES THE READ AT ITS BOUND AND COMES BACK IS NOT NEWS (R4W-1).
 * The action lane serves only its newest rows (read-theses.ts SHOW), so an
 * older size row of a post falls off the read whenever other activity pushes
 * it past the bound — another agent's order in flight is enough — and comes
 * back when that order resolves into a row it already has. Folded into the
 * post's total, the return counted every copy the row had as fills and chimed
 * for the post's newest row. Built from the real reader over the real ledger
 * schema, with the older row sitting exactly at the bound.
 */
describe("a row that leaves the read at its bound and comes back (R4W-1)", () => {
  const A = "0xAaAa000000000000000000000000000000000001";
  const B = "0xBbBb000000000000000000000000000000000002";
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
    for (const [account, name] of [[A, "Shogun"], [B, "SirSendIt"]] as const)
      raw
        .prepare(
          `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at, status, created_at, name, mode, beat_at)
           VALUES (?, '0x0000000000000000000000000000000000000abc', '0x0000000000000000000000000000000000000def', 4663, '{}', ?, ?, 'armed', ?, ?, 'live', ?)`,
        )
        .run(account, now - 86400, now + 86400, now - 86400, name, now - 30);
    const decide = (agent: string, id: string, symbol: string, size: number, ago: number, status: string, reason: string) => {
      raw
        .prepare(`INSERT INTO decisions (id, agent_id, source, action, symbol, size_usdg, reason, at) VALUES (?, ?, 'strategy:steady-basket', 'buy', ?, ?, ?, ?)`)
        .run(id, agent, symbol, size, reason, now - ago);
      raw
        .prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, decision_id, created_at) VALUES (?, 'swap', '0x0', ?, ?, ?, ?, ?, ?)`)
        .run(agent, USDG, TSLA, size, status, id, now - ago);
    };
    const resolve = (agent: string, id: string, status: string) =>
      raw
        .prepare(`INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, status, decision_id, created_at) VALUES (?, 'swap', '0x0', ?, ?, 1, ?, ?, ?)`)
        .run(agent, USDG, TSLA, status, id, now);
    const { readTheses } = await import("../lib/read-theses");
    const identities = async () => [
      { tenant: "0x1" as const, slug: "ems76d3cncwbt3dz", accounts: [A.toLowerCase() as `0x${string}`], createdAt: 1, updatedAt: 1 },
      { tenant: "0x2" as const, slug: "hr5k2m9q4w7x3z8n", accounts: [B.toLowerCase() as `0x${string}`], createdAt: 1, updatedAt: 1 },
    ];
    const privateBook = (async () => ({ strategy: "steady" })) as never;
    const read = async () => (await readTheses({}, (fn) => fn(db), identities, privateBook)).theses as unknown as Thesis[];
    return { raw, decide, resolve, read, now };
  }

  for (const how of ["landed", "reverted"] as const) {
    it(`another agent's order in flight pushes it out, and ${how === "landed" ? "lands" : "reverts"} into a row it already has: ${how === "landed" ? "one fill, that order's" : "no fill at all"}`, async () => {
      const L = await ledger();
      try {
        const leg = (s: number) => `the schedule says buy — ${s.toFixed(2)} USDG into TSLA, its 50% of a 2-leg basket`;
        // Shogun's TSLA post: the 10.00 row, two minutes old, and an older
        // 3.70 row of three copies — under one post id, as a private book is.
        L.decide(A, "p10", "TSLA", 10, 120, "landed", leg(10));
        for (let i = 0; i < 3; i++) L.decide(A, `p37-${i}`, "TSLA", 3.7, 3000 + i, "landed", leg(3.7));
        // Thirty-seven of SirSendIt's rows between them, and one NVDA row of
        // its own for its next order to resolve into: the 3.70 row is 40th.
        for (let k = 0; k < 37; k++) L.decide(B, `b${k}`, `S${String(k).padStart(2, "0")}`, 5, 200 + k * 60, "landed", `buying S${k}`);
        L.decide(B, "old", "NVDA", 5, 2_900, how, "buying NVDA");
        const tsla = (theses: Thesis[]) => theses.filter(isLandedTrade).filter((t) => t.symbol === "TSLA").map((t) => t.said);
        const a = createArrivals();

        const first = await L.read();
        assert.deepEqual(tsla(first), [1, 3], "both of the post's rows are on the first read, the older one at the bound");
        assert.deepEqual(a.take(first, L.now), { rows: [], fills: 0 }, "the first read is the page");

        L.decide(B, "new", "NVDA", 5, 10, "submitted", "buying NVDA");
        const inFlight = await L.read();
        assert.deepEqual(tsla(inFlight), [1], "the order in flight pushed the older row past the bound");
        assert.deepEqual(a.take(inFlight, L.now), { rows: [], fills: 0 }, "a pending order is not a fill");

        L.resolve(B, "new", how);
        const back = await L.read();
        assert.deepEqual(tsla(back), [1, 3], "the older row is back, with the copies it always had");
        const news = a.take(back, L.now);
        if (how === "landed") {
          assert.equal(news.fills, 1, "SirSendIt's order is the one fill");
          assert.deepEqual(news.rows.map((t) => [t.symbol, L.now - (t.at ?? 0)]), [["NVDA", 10]], "and the only row chimed for");
        } else {
          assert.deepEqual(news, { rows: [], fills: 0 }, "nothing landed, so nothing is news");
        }

        assert.deepEqual(a.take(await L.read(), L.now), { rows: [], fills: 0 }, "and read again, nothing");
      } finally {
        L.raw.close();
      }
    });
  }

  const id = "d".repeat(32);
  const at = (ago: number, said?: number) => row({ postId: id, at: NOW - ago, said, sizeUsdg: null });

  it("two rows moving past the post's newest in one read are one fill each — neither is measured against the row that left", () => {
    // Which of them the old newest row became, nothing on the read says; an
    // older row the bound had kept off may be the other, with every copy it had.
    const a = createArrivals();
    a.take([at(300, 1)], NOW);
    assert.deepEqual(a.take([at(100, 2), at(50, 6)], NOW).fills, 2);
  });

  it("a row whose time went back is not news, even when an older row left the read at the same time", () => {
    const a = createArrivals();
    a.take([at(100, 5), at(3000, 2)], NOW);
    assert.deepEqual(a.take([at(200, 4)], NOW), { rows: [], fills: 0 });
  });

  it("a row the bound kept off every read so far is not news when it arrives below the post's newest", () => {
    const a = createArrivals();
    a.take([at(120, 1)], NOW);
    assert.deepEqual(a.take([at(120, 1), at(600, 3)], NOW), { rows: [], fills: 0 });
  });

  it("two rows of one post in the same second are one reading, in whichever order they are read", () => {
    const a = createArrivals();
    a.take([at(100, 5), at(100, 1)], NOW);
    assert.deepEqual(a.take([at(100, 1), at(100, 5)], NOW).fills, 0);
  });

  it("an old row's count growing is judged by that row's age, not by the post's newest row", () => {
    // A deploy that widened the feed's window grows every old row at once.
    const a = createArrivals();
    a.take([at(60, 1), at(3 * 3600, 1)], NOW);
    assert.deepEqual(a.take([at(60, 1), at(3 * 3600, 2)], NOW), { rows: [], fills: 0 });
  });

  it("a post seen for the first time is one fill, on its newest row", () => {
    const a = createArrivals();
    a.take([], NOW);
    const newest = at(60, 1);
    assert.deepEqual(a.take([at(3000, 4), newest], NOW), { rows: [newest], fills: 1 });
  });

  it("a post remembers a bounded number of its rows, the oldest off the read forgotten first", () => {
    const a = createArrivals();
    a.take([at(500, 1), at(400, 1)], NOW);
    // A steady leg moving on read after read, while the 500 s row is off the read.
    for (let k = 1; k <= 70; k++) a.take([at(400 - k, 1 + k)], NOW);
    // Remembered, a row back with one copy more would be one late fill; the
    // bound forgot it, and a row it does not know below the newest is nothing.
    assert.deepEqual(a.take([at(500, 2), at(330, 71)], NOW).fills, 0);
  });
});
