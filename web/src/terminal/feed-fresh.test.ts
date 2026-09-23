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

import { beatsOf, lanesOf, pillBeats, type FeedRow } from "./beat";
import { forgetSeenForTest, freshAmong, isFresh, markSeen } from "./feed-fresh";
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

  it("two refusals of one post under different rules are two keys, stable across a re-read", () => {
    const a = row({ outcome: "refused", outcomeText: "past today's spending cap", at: NOW });
    const b = row({ outcome: "refused", outcomeText: "past today's number of trades", at: NOW - 5 });
    const first = beatsOf([a, b], agents).map((x) => x.id);
    const again = beatsOf([{ ...b, at: NOW + 60 }, { ...a, at: NOW + 30 }], agents).map((x) => x.id);
    assert.equal(new Set(first).size, 2);
    assert.deepEqual([...first].sort(), [...again].sort(), "neither key moved with `at`");
  });

  it("lanes and lulls follow the key", () => {
    const lanes = lanesOf(beatsOf([row()], agents));
    assert.equal(lanes[0]!.id, PID);
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
    const html = renderToStaticMarkup(createElement(Wire, { lanes, tokens: [], fresh: new Set([PID]) }));
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
