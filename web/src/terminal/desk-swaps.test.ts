/**
 * THE OWNER'S TRADES LIST IS THE SWAPS TABLE, and refusals stop drowning it.
 *
 * The desk listed every row of any status, so a paper agent at its ops cap
 * showed its owner thirty identical refusals and pushed the fills off the
 * screen — while "Trades · 30" counted the refusals as trades. The owner must
 * still be told every refusal and why (the forbidden list: never hide
 * refusals from the owner), so they fold into one line per reason instead.
 *
 * Rendered for real, because the list sits behind a tab a static render never
 * reaches.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React, { act } from "react";
import { autonomyOf } from "@merrymen/core";
import { Agent } from "./screens/Agent";
import type { LiveMine, Thesis } from "./live";
import { json, testDom } from "./test-dom";

let ui: ReturnType<typeof testDom>;
const realFetch = globalThis.fetch;
const g = globalThis as { ResizeObserver?: unknown; self?: unknown };
const realObserver = g.ResizeObserver;
const realSelf = g.self;
beforeEach(() => {
  ui = testDom();
  // The desk asks for the owner's tier on mount; nothing here depends on it.
  globalThis.fetch = (async () => json({}, 404)) as typeof fetch;
  // The balance chart observes its size; jsdom has no layout to observe.
  g.ResizeObserver = class { observe() {} disconnect() {} };
  // Links schedule their prefetch through `self` — the window, in a browser.
  g.self = ui.dom.window;
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = realFetch;
  g.ResizeObserver = realObserver;
  g.self = realSelf;
});

const now = () => Math.floor(Date.now() / 1000);
const move = (over: Partial<Thesis>): Thesis => ({
  name: "Shogun", slug: "shogun", handle: null, action: "buy", symbol: "CASHCAT", sizeUsdg: 5, reason: "momentum", paper: false,
  head: "swap", at: now() - 60, outcome: "landed", outcomeText: null, ...over,
});
const mine = (moves: Thesis[]): LiveMine => ({
  name: "Shogun", slug: "shogun", handle: null, owner: "you", equity: 100, chg24: null, mode: "trencher", thesis: null,
  moves, glance: { id: "trencher", label: "", cashUsd: 50 }, autonomy: autonomyOf({ mode: null, liveBlocker: null }), positions: [],
});
const noop = () => {};
const render = (moves: Thesis[]) =>
  ui.render(React.createElement(Agent, {
    mine: mine(moves), tokens: [], perTrade: 10, perDay: 50, stopped: false, turns: [], draft: "",
    onDraft: noop, onTurn: noop, onToken: noop, onDeposit: noop, onWithdraw: noop, onLimits: noop, onResign: noop, onSettings: noop,
  } as never));

it("fills show as rows, refusals fold into one line per reason, and the count is of trades", async () => {
  const ops = "past today's number of trades";
  await render([
    move({ at: now() - 60 }),
    move({ at: now() - 120, outcome: "refused", outcomeText: ops }),
    move({ at: now() - 180, outcome: "refused", outcomeText: ops }),
    move({ at: now() - 240, action: "sell", outcome: "pending", sizeUsdg: 4 }),
    move({ at: now() - 300, outcome: "refused", outcomeText: ops }),
  ]);
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  assert.equal(tab.textContent, "Trades · 2", "a refusal is not a trade");
  await act(async () => { tab.click(); });
  const table = ui.container.querySelector(".desk-trades .swaps")!;
  const lines = [...table.querySelectorAll(".swap-row")].map((r) => r.querySelector(".swap-pill")!.textContent + " " + (r.querySelector(".swap-tried")?.textContent ?? r.querySelector(".swap-coin strong")!.textContent));
  assert.deepEqual(lines, ["Buy CASHCAT", `Tried Refused 3× today: ${ops}`, "Sell CASHCAT"]);
  assert.match(table.textContent!, /\$5\.00/, "the owner sees their own sizes");
  assert.match(table.textContent!, /Pending/);
  assert.match(table.textContent!, /momentum/, "and why the agent did it");
});

it("a full tape's counts are floors, because there may be more past its end", async () => {
  const ops = "past today's number of trades";
  // A paper agent at its cap: the whole tape is this morning's refusals.
  await render(Array.from({ length: 30 }, (_, i) => move({ at: now() - 60 * (i + 1), outcome: "refused", outcomeText: ops })));
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  assert.equal(tab.textContent, "Trades · 0+");
  await act(async () => { tab.click(); });
  const line = ui.container.querySelector(".desk-trades .swap-tried")!.textContent!;
  // Today, unless the test runs in the first half hour after midnight.
  assert.match(line, /^Refused 30\+× (today|since .+): past today's number of trades$/);
});

it("an empty tape says so", async () => {
  await render([]);
  const tab = Array.from(ui.container.querySelectorAll("button")).find((b) => /^Trades · /.test(b.textContent ?? ""))!;
  assert.equal(tab.textContent, "Trades · 0");
  await act(async () => { tab.click(); });
  assert.match(ui.container.querySelector(".desk-trades")!.textContent!, /No trades yet\./);
});
