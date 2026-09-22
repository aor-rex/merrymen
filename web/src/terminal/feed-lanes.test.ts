/**
 * THE FEED IS TRADES AND CHANGED MINDS, NOT A CLOCK.
 *
 * The reader now returns trades on their own budget and one view per agent and
 * name. This is the other half: how those rows are laid out. A view that has
 * only been repeated sits where it FIRST arrived, and "All" says each agent's
 * holds once. Every case goes through `beatsOf` from rows in publisher units,
 * the way `/api/theses` serves them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { beatsOf, compactHolds, lanesOf, whenLabel, type FeedRow } from "./beat";
import type { LiveAgent } from "./live";
import { alertsOf, alertsRead, RAIL_ALERTS } from "../lib/rail-alerts";

const NOW_MS = Date.UTC(2026, 8, 22, 12, 0, 0);
const NOW = Math.floor(NOW_MS / 1000);

const row = (over: Partial<FeedRow> = {}): FeedRow =>
  ({
    name: "Shogun",
    slug: "shogun",
    handle: "@shogun",
    action: "hold",
    symbol: "TSLA",
    sizeUsdg: null,
    reason: "Depth is thin; nothing worth taking.",
    paper: false,
    head: "hold TSLA",
    outcome: "view",
    said: 1,
    at: NOW,
    firstAt: NOW,
    ...over,
  }) as FeedRow;

const agents: LiveAgent[] = ["shogun", "sirsendit"].map(
  (slug) =>
    ({
      slug,
      name: slug,
      handle: `@${slug}`,
      owner: null,
      pnlBps: null,
      curve: [],
      landed: 0,
      last: null,
      glance: { id: "custom", label: "Strategy" },
      thesis: "",
    }) as LiveAgent,
);

const buy = (over: Partial<FeedRow> = {}) =>
  row({ action: "buy", symbol: "NVDA", sizeUsdg: 5, head: "buy NVDA 5.00 USDG", outcome: "landed", reason: "Adding under its average.", at: NOW - 3600, firstAt: NOW - 3600, ...over });

describe("a repeated view keeps the time it first arrived", () => {
  it("×24 since 2h sits BELOW a trade from an hour ago, not on top of it", () => {
    const repeated = row({ said: 24, at: NOW - 60, firstAt: NOW - 2 * 3600 });
    const beats = beatsOf([repeated, buy()], agents);
    assert.deepEqual(beats.map((b) => b.kind), ["trade", "view"]);
    const view = beats[1]!;
    assert.equal(view.sinceMs, (NOW - 2 * 3600) * 1000);
    assert.equal(whenLabel(view, NOW_MS), "×24 · since 2h");
  });

  it("a first-time view is news, and says how old it is", () => {
    const [fresh] = beatsOf([row({ at: NOW - 120, firstAt: NOW - 120 })], agents);
    assert.equal(fresh!.sinceMs, null);
    assert.equal(whenLabel(fresh!, NOW_MS), "2m");
  });

  it("a row with no firstAt is never given a guessed one", () => {
    const [old] = beatsOf([row({ said: 5, at: NOW - 120, firstAt: undefined })], agents);
    assert.equal(old!.sinceMs, null);
    assert.equal(whenLabel(old!, NOW_MS), "2m");
  });

  it("a repeated TRADE still sits where it happened — it is an event, not a view", () => {
    const [trade] = beatsOf([buy({ said: 8, at: NOW - 60, firstAt: NOW - 7200, outcome: "refused" })], agents);
    assert.equal(trade!.rankMs, (NOW - 60) * 1000);
    assert.equal(trade!.sinceMs, null);
  });

  it("a lull is measured between where rows sit", () => {
    const beats = beatsOf([buy({ at: NOW }), row({ said: 3, at: NOW - 30, firstAt: NOW - 4 * 3600 })], agents);
    const lanes = lanesOf(beats);
    assert.deepEqual(lanes.map((l) => l.kind), ["beat", "lull", "beat"]);
  });
});

describe("All says each agent's holds once", () => {
  const trencher = Array.from({ length: 100 }, (_, i) =>
    row({ symbol: `T${String(i % 12).padStart(11, "0")}`, head: `hold T${String(i % 12).padStart(11, "0")}`, reason: `review ${i}`, at: NOW - i * 30, firstAt: NOW - i * 30 }),
  );

  it("A HUNDRED HOLDS AND ONE TRADE — the trade is on the page", () => {
    const all = compactHolds(beatsOf([...trencher, buy({ at: NOW - 3 * 3600, firstAt: NOW - 3 * 3600 })], agents));
    assert.equal(all.filter((b) => b.kind === "trade").length, 1);
    assert.equal(all.length, 2, "one trade and one summary line");
  });

  it("the summary counts every name and carries the newest hold in full", () => {
    const [watch] = compactHolds(beatsOf(trencher, agents));
    assert.ok(watch && watch.kind === "watch");
    assert.equal(watch.count, 12);
    assert.equal(watch.members.length, 100, "counted, not dropped");
    assert.equal(watch.latest.reason, "review 0");
    assert.equal(watch.postId, null, "a summary is not a post and cannot be liked");
  });

  it("one hold stays a normal row, and another agent keeps its own", () => {
    const other = row({ slug: "sirsendit", name: "SirSendIt", handle: "@sirsendit", symbol: "AAPL", head: "hold AAPL", at: NOW - 5 * 3600, firstAt: NOW - 5 * 3600 });
    const all = compactHolds(beatsOf([...trencher, other], agents));
    assert.deepEqual(
      all.map((b) => `${b.kind}:${b.actor.slug}`),
      ["watch:shogun", "view:sirsendit"],
    );
  });

  it("a view that is not a hold is never folded into the summary", () => {
    const thesis = row({ action: null, symbol: null, head: "", reason: "Cash is the position until breadth returns.", at: NOW - 10, firstAt: NOW - 10 });
    const all = compactHolds(beatsOf([...trencher, thesis], agents));
    assert.ok(all.some((b) => b.kind === "view" && b.reason.startsWith("Cash is the position")));
  });
});

describe("the alerts rail is trades", () => {
  it("holds are left to the feed; a refusal is still an alert", () => {
    const rows = [
      row({ at: NOW }),
      buy({ outcome: "refused", outcomeText: "past today's spending cap" }),
      row({ action: null, symbol: null }),
      buy({ action: "sell", outcome: "landed" }),
    ];
    const alerts = alertsOf(rows);
    assert.deepEqual(alerts.map((a) => `${a.action}:${a.outcome}`), ["buy:refused", "sell:landed"]);
  });

  it("and it fits the rail", () => {
    assert.equal(alertsOf(Array.from({ length: 40 }, () => buy())).length, RAIL_ALERTS);
  });

  it("an unreadable read is not a quiet day", () => {
    assert.equal(alertsRead({ source: "none" }), "unreadable");
    assert.equal(alertsRead(null), "unreadable");
    assert.equal(alertsRead({ source: "sqlite" }), "ok");
  });
});
