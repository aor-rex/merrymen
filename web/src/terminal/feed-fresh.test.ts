/**
 * A ROW IS THE SAME ROW ACROSS REFRESHES, SO A NEW ONE CAN BE SEEN ARRIVING.
 *
 * Beat ids embedded `at` — `${symbol}-${action}-${slug}-${atSec}` — and the
 * reader groups on MAX(d.at), which a re-proposed thesis advances every tick.
 * So every refresh handed React a fresh key for a post that had not changed:
 * every row remounted, and "which of these is new?" had no answer, because by
 * id they all were.
 *
 * Keyed on `postId` — a hash of the post's own published fields that does not
 * move with `at`, `said` or the outcome (post-id.ts) — a row keeps its element
 * across refreshes, and a key the page has not seen before is genuinely a post
 * it has not shown. That is what the slide-in is drawn from.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { beatsOf, forgetKeysForTest, lanesOf, pillBeats, type Beat, type FeedRow } from "./beat";
import { forgetSeenForTest, freshAmong, freshKeyOf, isFresh, markSeen } from "./feed-fresh";
import type { LiveAgent } from "./live";

(globalThis as unknown as { React: typeof React }).React = React;

const NOW = 1_790_000_000;
const PID = "c".repeat(32);

const row = (over: Partial<FeedRow> = {}): FeedRow =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: null,
    action: "buy",
    symbol: "TSLA",
    sizeUsdg: 5,
    reason: "Adding under its average.",
    paper: false,
    head: "buy TSLA 5.00 USDG",
    outcome: "landed",
    outcomeText: "filled",
    said: 1,
    at: NOW,
    firstAt: NOW,
    unchangedSince: NOW,
    postId: PID,
    ...over,
  }) as FeedRow;

const agents = [
  { slug: "shogun", name: "Shogun", handle: null, owner: null, pnlBps: null, curve: [], landed: 0, last: null, glance: { id: "custom", label: "Strategy" }, thesis: "" },
] as unknown as LiveAgent[];

describe("C2: a beat is keyed by its postId", () => {
  beforeEach(() => forgetKeysForTest());

  it("the same post, re-read a tick later with a newer `at`, keeps its key", () => {
    const [before] = beatsOf([row({ at: NOW, said: 1 })], agents);
    const [after] = beatsOf([row({ at: NOW + 300, said: 2 })], agents);
    assert.equal(before!.id, PID);
    assert.equal(after!.id, before!.id);
  });

  it("a view is keyed the same way", () => {
    const [v] = beatsOf([row({ action: "hold", head: "hold TSLA", outcome: "view", postId: "d".repeat(32) })], agents);
    assert.equal(v!.kind, "view");
    assert.equal(v!.id, "d".repeat(32));
  });

  it("only a post with no postId falls back to the old id", () => {
    const [b] = beatsOf([row({ postId: null })], agents);
    assert.equal(b!.id, `TSLA-buy-shogun-${NOW}`);
    const [v] = beatsOf([row({ postId: undefined, action: "hold", head: "hold TSLA", outcome: "view" })], agents);
    assert.equal(v!.id, `view-shogun-${NOW}-TSLA`);
  });

  it("the like key is untouched: it is still the postId", () => {
    const [b] = beatsOf([row()], agents);
    assert.equal(b!.postId, PID);
  });

  it("TWO ROWS, ONE POSTID — still two keys, and the landed row keeps the bare id in either order", () => {
    // post-id.ts leaves outcome out on purpose (a like survives settling), so
    // the same thesis pending and landed are two rows sharing one id. Two
    // equal React keys make React drop or merge a row.
    // Whichever is newer, and whichever arrives first: neither the feed's
    // order nor the old `at`-bearing id may decide who owns the key.
    for (const pendingAt of [NOW + 10, NOW - 10]) {
      const pending = row({ outcome: "pending", at: pendingAt });
      const landed = row({ outcome: "landed", at: NOW });
      for (const order of [[pending, landed], [landed, pending]]) {
        const beats = beatsOf(order, agents);
        const ids = beats.map((b) => b.id);
        assert.equal(new Set(ids).size, 2, "unique");
        const landedBeat = beats.find((b) => b.outcome === "landed")!;
        assert.equal(landedBeat.id, PID, "the settled row owns the stable key");
      }
    }
  });

  it("two refusals of one post under different rules are two keys, and EACH KEEPS ITS OWN across a re-read", () => {
    // The review's probe (FE4): the tie-break was the `at`-bearing legacy id,
    // so re-proposing both in the other order SWAPPED their keys — and with
    // them their elements and any open "why". A sorted comparison of the two
    // keys could not see it; each row is found by its own words here.
    const cap = (at: number) => row({ outcome: "refused", outcomeText: "past today's spending cap", at });
    const ops = (at: number) => row({ outcome: "refused", outcomeText: "past today's number of trades", at });
    const keyOf = (bs: Beat[], text: string) => bs.find((x) => x.outcomeText === text)!.id;
    const first = beatsOf([cap(NOW), ops(NOW - 5)], agents);
    const again = beatsOf([cap(NOW + 30), ops(NOW + 60)], agents);
    assert.equal(new Set(first.map((x) => x.id)).size, 2);
    for (const text of ["past today's spending cap", "past today's number of trades"]) {
      assert.equal(keyOf(again, text), keyOf(first, text), text);
    }
  });

  it("the first read of a family keys it the same whatever the order or the clock", () => {
    const cap = (at: number) => row({ outcome: "refused", outcomeText: "past today's spending cap", at });
    const ops = (at: number) => row({ outcome: "refused", outcomeText: "past today's number of trades", at });
    const keyOf = (bs: Beat[], text: string) => bs.find((x) => x.outcomeText === text)!.id;
    const one = beatsOf([cap(NOW), ops(NOW - 5)], agents);
    forgetKeysForTest();
    const two = beatsOf([ops(NOW + 60), cap(NOW - 90)], agents);
    for (const text of ["past today's spending cap", "past today's number of trades"]) {
      assert.equal(keyOf(two, text), keyOf(one, text), text);
    }
  });

  it("lanes and lulls follow the key", () => {
    const lanes = lanesOf(beatsOf([row()], agents));
    assert.equal(lanes[0]!.id, PID);
  });
});

describe("a key stays with the row that had it (FE1)", () => {
  beforeEach(() => {
    forgetKeysForTest();
    forgetSeenForTest();
  });

  it("A TRADE THAT LANDS BESIDE A REFUSAL ON SCREEN IS THE NEW ROW — the refusal keeps its key", () => {
    // The review's probe: an owner re-signs a stuck leg. The refusal ("asset
    // the key does not cover") is on screen under the post's bare id; the
    // same thesis then lands. The landed row took the bare id by priority —
    // the refusal's element, already seen — so the new trade did not slide
    // in, and the refusal was re-keyed, remounted and slid in as "new".
    const refused = row({ outcome: "refused", outcomeText: "that asset is not in its signed permissions", at: NOW });
    const first = beatsOf([refused], agents);
    markSeen(first.map(freshKeyOf));
    const second = beatsOf([refused, row({ outcome: "landed", outcomeText: "landed", at: NOW + 600 })], agents);
    const fresh = freshAmong(second.map(freshKeyOf));
    const was = second.find((b) => b.outcome === "refused")!;
    const now = second.find((b) => b.outcome === "landed")!;
    assert.equal(was.id, first[0]!.id, "the refusal keeps the key it was drawn under");
    assert.notEqual(now.id, was.id);
    assert.equal(isFresh(now, fresh), true, "the trade is what arrived");
    assert.equal(isFresh(was, fresh), false, "the refusal was already on the page");
  });

  it("an order that lands keeps the element it was drawn under while in flight, and is news", () => {
    // The pending row is gone once its trade settles; the landed row is the
    // same trade, so it takes the key over — and the fill is still new (D2).
    const first = beatsOf([row({ outcome: "pending", outcomeText: "sent, waiting on the chain", at: NOW })], agents);
    markSeen(first.map(freshKeyOf));
    const second = beatsOf([row({ outcome: "landed", outcomeText: "landed", at: NOW + 20 })], agents);
    assert.equal(second[0]!.id, first[0]!.id);
    assert.equal(isFresh(second[0]!, freshAmong(second.map(freshKeyOf))), true);
  });
});

describe("a new fill is new even when it joins a row it shares with others (FE5, D2)", () => {
  beforeEach(() => {
    forgetKeysForTest();
    forgetSeenForTest();
  });
  const seenThen = (rows: FeedRow[]) => markSeen(beatsOf(rows, agents).map(freshKeyOf));
  const freshNow = (rows: FeedRow[]) => {
    const beats = beatsOf(rows, agents);
    const fresh = freshAmong(beats.map(freshKeyOf));
    return beats.map((b) => isFresh(b, fresh));
  };

  it("THE SECOND DCA LEG OF THE DAY: a landed row whose `at` moved and `said` grew is a new fill", () => {
    // Same reason, same size, so the reader groups it into the first leg's
    // row (no d.at in its GROUP BY). The row jumped to the top as "now" and
    // did not move — the key had been seen.
    seenThen([row({ said: 1, at: NOW })]);
    assert.deepEqual(freshNow([row({ said: 2, at: NOW + 3600 })]), [true]);
  });

  it("the same landed row read again is not new", () => {
    seenThen([row({ said: 1, at: NOW })]);
    assert.deepEqual(freshNow([row({ said: 1, at: NOW })]), [false]);
  });

  it("A REPEATED VIEW, A REPEATED REFUSAL AND A RE-SENT ORDER DO NOT FLASH EVERY TICK — only a fill is news", () => {
    const view = (said: number, at: number) =>
      row({ action: "hold", outcome: "view", outcomeText: "held — no trade, by choice", head: "hold TSLA", sizeUsdg: null, postId: "d".repeat(32), said, at, unchangedSince: NOW - 3600 });
    const refusal = (said: number, at: number) =>
      row({ outcome: "refused", outcomeText: "past today's spending cap", postId: "e".repeat(32), said, at, unchangedSince: NOW - 3600 });
    const sent = (said: number, at: number) =>
      row({ outcome: "pending", outcomeText: "sent, waiting on the chain", postId: "f".repeat(32), said, at });
    seenThen([view(3, NOW), refusal(3, NOW), sent(1, NOW)]);
    assert.deepEqual(freshNow([view(4, NOW + 300), refusal(4, NOW + 300), sent(2, NOW + 300)]), [false, false, false]);
  });
});

describe("what is new since the page last looked", () => {
  beforeEach(() => forgetSeenForTest());

  it("THE FIRST READ SLIDES NOTHING IN — it is the page, not news", () => {
    assert.deepEqual([...freshAmong(["a", "b"])], []);
    markSeen(["a", "b"]);
    assert.deepEqual([...freshAmong(["a", "b"])], []);
  });

  it("a key that arrives after the first read is fresh, once", () => {
    markSeen(["a", "b"]);
    assert.deepEqual([...freshAmong(["c", "a", "b"])], ["c"]);
    markSeen(["c", "a", "b"]);
    assert.deepEqual([...freshAmong(["c", "a", "b"])], [], "seen now");
  });

  it("an empty first read does not prime: the first real rows are still the page", () => {
    markSeen([]);
    assert.deepEqual([...freshAmong(["a"])], []);
  });

  it("MODULE-LEVEL: a remounted feed does not replay the rows it already showed", () => {
    // Switching tabs unmounts the Feed. The set outlives it, so coming back is
    // not a wall of slide-ins — only what arrived while away moves.
    markSeen(["a", "b"]);
    const remount = freshAmong(["a", "b", "z"]);
    assert.deepEqual([...remount], ["z"]);
  });

  it("reading does not mark: two renders before commit see the same fresh set", () => {
    markSeen(["a"]);
    assert.deepEqual([...freshAmong(["a", "n"])], ["n"]);
    assert.deepEqual([...freshAmong(["a", "n"])], ["n"], "StrictMode renders twice; the second must agree");
  });
});

describe("the row", () => {
  it("a fresh row carries wire-new; a seen one does not", async () => {
    const { Wire } = await import("./wire");
    const lanes = lanesOf(beatsOf([row(), row({ postId: "e".repeat(32), symbol: "NVDA", head: "buy NVDA 5.00 USDG", at: NOW - 60 })], agents));
    const beats = lanes.flatMap((l) => (l.kind === "beat" ? [l.beat] : []));
    const html = renderToStaticMarkup(createElement(Wire, { lanes, tokens: [], fresh: new Set([freshKeyOf(beats[0]!)]) }));
    const rows = html.split('<div class="wire-beat').slice(1);
    assert.equal(rows.length, 2);
    assert.match(rows[0]!, /^[^"]*wire-new/, "the new TSLA row");
    assert.doesNotMatch(rows[1]!, /^[^"]*wire-new/, "the NVDA row was already on the page");
  });

  it("a watch line moves when the hold it leads with is new, not because it is a summary", () => {
    const hold = (sym: string, pid: string, at: number) =>
      row({ action: "hold", outcome: "view", symbol: sym, head: `hold ${sym}`, sizeUsdg: null, reason: `watching ${sym}`, postId: pid, said: 3, at, unchangedSince: at - 3600 });
    const beats = beatsOf([hold("AAA", "1".repeat(32), NOW), hold("BBB", "2".repeat(32), NOW - 60)], agents);
    const [watch] = pillBeats(beats, "all", new Map(), {});
    assert.ok(watch && watch.kind === "watch");
    assert.equal(isFresh(watch, new Set(["1".repeat(32)])), true, "its latest member is new");
    assert.equal(isFresh(watch, new Set(["2".repeat(32)])), false, "an older member is not what it shows");
    assert.equal(isFresh(watch, new Set()), false);
  });

  it("no fresh set (an older caller): nothing animates", async () => {
    const { Wire } = await import("./wire");
    const html = renderToStaticMarkup(createElement(Wire, { lanes: lanesOf(beatsOf([row()], agents)), tokens: [] }));
    assert.ok(!html.includes("wire-new"));
  });
});
