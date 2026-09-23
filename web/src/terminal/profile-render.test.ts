import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React, { act } from "react";
import { Profile } from "./screens/Profile";
import type { ProfileAgent } from "./profile-view";
import { json, testDom } from "./test-dom";

/**
 * THE PROFILE, RENDERED — what a stranger and the owner actually see.
 *
 * The rules are tested in profile-view.test.ts; this proves the page applies
 * them: the stats line, TOP TRADES, the chart's windows and the owner's switch.
 */
let ui: ReturnType<typeof testDom>;
const realFetch = globalThis.fetch;
const g = globalThis as { ResizeObserver?: unknown; self?: unknown };
const real = { observer: g.ResizeObserver, self: g.self };
beforeEach(() => {
  ui = testDom();
  // The chart observes its own size; jsdom has no layout, so nothing to observe.
  g.ResizeObserver = class { observe() {} disconnect() {} };
  // A stranger's view mounts the wire button, whose link prefetch schedules
  // idle work through `self` — the window, in a browser.
  g.self = ui.dom.window;
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = realFetch;
  g.ResizeObserver = real.observer;
  g.self = real.self;
});

const H = 3_600;
const nowSec = () => Math.floor(Date.now() / 1000);
function agent(over: Partial<ProfileAgent> = {}): ProfileAgent {
  return {
    slug: "shogun", name: "Shogun", handle: null, owner: null, pnlBps: 2_150, curve: [], landed: 4, last: null,
    glance: { id: "trencher", label: "new pairs" }, thesis: "Trades newly launched coins.", mode: "live",
    curveKind: "growth", contributionsEvidenced: true, recentTrades: [], activityRead: true, publicBook: false,
    ...over,
  } as ProfileAgent;
}
const render = (a: ProfileAgent, extra: Record<string, unknown> = {}) =>
  ui.render(React.createElement(Profile, { agent: a, theses: [], tokens: [], onBack() {}, onToken() {}, ...extra }));
const text = () => ui.container.textContent ?? "";

it("the stats line says what was read, and nothing it was not", async () => {
  await render(agent({ tradeCount: 12, tradeCountFloor: false, avgHoldSec: 3 * H + 20 * 60, joinedAt: null, gasless: true }));
  const line = ui.container.querySelector(".profile-stats")!.textContent!;
  assert.match(line, /^12 trades · avg hold 3h 20m · Gasless: every trade sponsored$/);
  // Nothing read, nothing printed — not "0 trades", not an empty line.
  await render(agent());
  assert.equal(ui.container.querySelector(".profile-stats"), null);
});

it("TOP TRADES rank by return, show dollars only when sent, and say when there are none", async () => {
  const trade = (id: string, symbol: string, bps: number, usd: number | null) =>
    ({ id, action: "sell" as const, symbol, displayName: null, at: 1, paper: false, sizeUsdg: null, realizedPnlUsdg: usd, realizedPnlBps: bps });
  await render(agent({ topTrades: [trade("1", "CASHCAT", 4_210, null), trade("2", "CHUMP", -500, null)], topTradesRead: true }));
  const rows = [...ui.container.querySelectorAll(".profile-top-trade")].map((r) => [
    r.querySelector(".profile-top-rank")!.textContent,
    r.querySelector(".profile-top-name strong")!.textContent,
    r.querySelector(".profile-top-figure")!.textContent,
  ]);
  assert.deepEqual(rows, [["#1", "CASHCAT", "+42.1%"], ["#2", "CHUMP", "−5.0%"]]);
  assert.doesNotMatch(text(), /\$/, "a private book prints no dollar anywhere in the list");
  await render(agent({ topTrades: [trade("1", "CASHCAT", 4_210, 3.1)], topTradesRead: true, publicBook: true }));
  assert.match(ui.container.querySelector(".profile-top-trade")!.textContent!, /\+42\.1% \(\+\$3\.10\)/);
  await render(agent({ topTrades: [], topTradesRead: true }));
  assert.match(text(), /No closed trades yet/);
  await render(agent({ topTrades: [], topTradesRead: false }));
  assert.match(text(), /Top trades could not be loaded/);
  assert.doesNotMatch(text(), /No closed trades yet/, "an unread list is not an empty one");
});

it("the chart opens on ALL, and a window the history cannot back is disabled", async () => {
  const now = nowSec();
  const growthPoints = [{ at: now - 9 * H, g: 1 }, { at: now - 4 * H, g: 1.1 }, { at: now, g: 1.215 }];
  await render(agent({ curve: growthPoints.map((p) => p.g), growthPoints, growthComplete: true }));
  const buttons = [...ui.container.querySelectorAll(".profile-chart-windows button")] as HTMLButtonElement[];
  assert.deepEqual(buttons.map((b) => [b.textContent, b.disabled, b.getAttribute("aria-pressed")]), [
    ["24H", true, "false"], ["7D", true, "false"], ["30D", true, "false"], ["ALL", false, "true"],
  ]);
  assert.match(text(), /over this whole trading period/);
});

it("the owner's switch is shown only on their own page, and only once the setting was read", async () => {
  await render(agent({ publicBook: false }), { isMine: false });
  assert.equal(ui.container.querySelector(".profile-book"), null, "a stranger never sees it");
  await render(agent({ publicBook: undefined }), { isMine: true });
  assert.equal(ui.container.querySelector(".profile-book"), null, "an unread setting is not drawn as off");
  await render(agent({ publicBook: false }), { isMine: true });
  const sw = ui.container.querySelector(".profile-book [role=switch]")!;
  assert.equal(sw.getAttribute("aria-checked"), "false", "off by default");
});

it("turning the book on saves a boolean, re-reads the profile, and a failure is said", async () => {
  const sent: unknown[] = [];
  let refreshed = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => { sent.push(JSON.parse(String(init?.body))); return json({ ok: true }); }) as typeof fetch;
  await render(agent({ publicBook: false }), { isMine: true, onBookChanged: () => { refreshed += 1; } });
  await act(async () => { (ui.container.querySelector(".profile-book [role=switch]") as HTMLElement).click(); });
  assert.deepEqual(sent, [{ publicBook: true }]);
  assert.equal(refreshed, 1);
  assert.equal(ui.container.querySelector(".profile-book [role=switch]")!.getAttribute("aria-checked"), "true");

  // A server that ignored the field did not save it, and the switch stays put.
  globalThis.fetch = (async () => json({ ok: true, ignored: ["publicBook"] })) as typeof fetch;
  await render(agent({ publicBook: false }), { isMine: true, onBookChanged: () => { refreshed += 1; }, key: "again" });
  await act(async () => { (ui.container.querySelector(".profile-book [role=switch]") as HTMLElement).click(); });
  assert.equal(ui.container.querySelector(".profile-book [role=switch]")!.getAttribute("aria-checked"), "false");
  assert.match(ui.container.querySelector(".profile-book [role=alert]")!.textContent!, /nothing changed/);
  assert.equal(refreshed, 1, "nothing to re-read after a save that did not happen");
});
