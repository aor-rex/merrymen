import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React, { act } from "react";
import { FirstVisit } from "./FirstVisit";
import { deferred, json, testDom } from "./test-dom";

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
const KEY = "merrymen.tour.v2";
const A = "0xaaaa", B = "0xbbbb";
let requests: { url: string; method: string; body: Record<string, unknown> | null }[];
let response: (url: string, init?: RequestInit) => Promise<Response>;
const tour = (tenant: string | null = null, onScreen = (_: unknown) => {}, onQuestion = () => {}) => React.createElement(FirstVisit, { tenant, onScreen, onQuestion });
const result = (tenant: string, done: boolean) => ({ tenant, version: 2, signedIn: true, done });

beforeEach(() => {
  ui = testDom(); requests = [];
  response = async (url, init) => json(result(init?.method === "POST" ? JSON.parse(String(init.body)).tenant : new URL(url, "https://test").searchParams.get("tenant")!, init?.method === "POST"));
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
    return response(String(input), init);
  };
});
afterEach(async () => { await ui.close(); globalThis.fetch = originalFetch; });

it("signed-out visitors can finish seven stops and remain dismissed after reload", async () => {
  await ui.render(tour());
  for (let step = 1; step <= 7; step++) {
    assert.equal(ui.container.querySelector(".tour-count")?.textContent, `${step} / 7`);
    await ui.click(step === 7 ? "Finish" : "Next");
  }
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  await ui.remount(tour());
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  assert.equal(requests.length, 0);
});
it("claims an anonymous dismissal once on sign-in, without hiding the next account's tour", async () => {
  await ui.render(tour()); await ui.click("Skip tour"); await ui.render(tour(A));
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
  assert.equal(requests.find(r => r.method === "POST")?.body?.tenant, A);
  assert.equal(JSON.parse(localStorage.getItem(`${KEY}:${A}`)!).pending, false);
  await ui.render(tour(B));
  assert.ok(ui.container.querySelector('[role="dialog"]'));
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
  await ui.render(tour(A));
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
});
it("server dismissal does not close explicit replay, including after reload", async () => {
  response = async () => json(result(A, true));
  await ui.render(tour(A)); await ui.click("Show me around");
  assert.ok(ui.container.querySelector('[role="dialog"]'));
  await ui.click("Next"); await ui.remount(tour(A));
  assert.equal(ui.container.querySelector(".tour-count")?.textContent, "2 / 7");
});
it("a late response cannot undo replay or affect another account", async () => {
  const late = deferred<Response>(); response = async () => late.promise;
  localStorage.setItem(`${KEY}:${A}`, JSON.stringify({ done: true, step: 0 }));
  await ui.render(tour(A)); await ui.click("Show me around");
  await act(async () => late.resolve(json(result(A, true))));
  assert.ok(ui.container.querySelector('[role="dialog"]'));
  const old = deferred<Response>();
  response = async url => url.includes(A) ? old.promise : json(result(B, false));
  await ui.remount(tour(A)); await ui.render(tour(B));
  await act(async () => old.resolve(json(result(A, true))));
  assert.ok(ui.container.querySelector('[role="dialog"]'));
  assert.equal(JSON.parse(localStorage.getItem(`${KEY}:${B}`)!).done, false);
});
it("failed persistence stays pending without loops and retries on reload or reconnect", async () => {
  response = async (_, init) => init?.method === "POST" ? json({ error: "down" }, 503) : json(result(A, false));
  await ui.render(tour(A)); await ui.click("Skip tour");
  assert.equal(ui.container.querySelector('[role="dialog"]'), null);
  assert.match(ui.container.textContent!, /Retry account sync/);
  assert.equal(requests.filter(r => r.method === "POST").length, 1);
  await ui.remount(tour(A));
  assert.equal(requests.filter(r => r.method === "POST").length, 2);
  response = async () => json(result(A, true));
  await act(async () => { window.dispatchEvent(new Event("online")); });
  assert.equal(requests.filter(r => r.method === "POST").length, 3);
  assert.equal(JSON.parse(localStorage.getItem(`${KEY}:${A}`)!).pending, false);
  await act(async () => { window.dispatchEvent(new Event("online")); });
  assert.equal(requests.filter(r => r.method === "POST").length, 3);
});
it("resumes navigation and prepares the example question only once", async () => {
  localStorage.setItem(KEY, JSON.stringify({ done: false, step: 3 }));
  const screens: unknown[] = []; let questions = 0;
  await ui.render(tour(null, s => screens.push(s), () => { questions++; }));
  assert.deepEqual(screens, [{ kind: "tab", tab: "agent" }]); assert.equal(questions, 1);
  await ui.click("Back"); await ui.click("Next"); assert.equal(questions, 1);
});
