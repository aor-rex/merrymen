/**
 * THE CHAT, RUN: the real Agent screen, drawn from the real App-level
 * controller, in a DOM, against a scripted network.
 *
 * W2.7 — it should feel like a messaging app: the owner's line and a typing
 * bubble at once, the reply streaming in with nothing of a command marker ever
 * on screen, one round trip per message, failures in the agent's voice with a
 * Retry, chips that never suggest a size the wall would refuse, and the cursor
 * put back only where there is a mouse.
 *
 * W2.8 — an order's answer reaches the owner wherever they are: followed by
 * the App, not the screen; resumed after a reload; rendered from the worker's
 * receipt; the agent's own fills merged into the thread; an unread dot; the
 * book read again when an outcome lands; and a snipe followed like any order.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import React, { act, createElement } from "react";
import { autonomyOf } from "@merrymen/core";
import { agentReplyResponse, type AgentChatBody } from "@/lib/agent-chat";
import { sseEvent } from "@/lib/chat-stream";
import type { LiveMine, Thesis } from "./live";
import { Agent } from "./screens/Agent";
import { useChatController, type ChatController } from "./chat-controller";
import { MAX_MESSAGES, tradeKeyOf } from "./chat-thread";
import { deferred, json, testDom } from "./test-dom";

const KEY = "merrymen.chat.self";
const ORDER_ID = "0123456789abcdef0123456789abcdef";
const noop = () => {};

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
const originalRO = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let routes: Record<string, Handler>;
let calls: { method: string; url: string; body: Record<string, unknown> | null }[];
let chat: ChatController;

beforeEach(() => {
  ui = testDom();
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  // A Next <Link> on the screen schedules its prefetch through `self`.
  (globalThis as { self?: unknown }).self = ui.dom.window;
  localStorage.clear();
  calls = [];
  routes = {
    "GET /api/settings": () => json({ values: { liveTradingEnabled: true }, defaults: { telegramMaxActionUsdg: 25 } }),
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    const handler = routes[`${method} ${url.split("?")[0]}`];
    return handler ? handler(url, init) : json({ error: "not scripted" }, 404);
  }) as typeof fetch;
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = originalRO;
  Reflect.deleteProperty(globalThis, "self");
});

const MINE: LiveMine = {
  name: "Shogun",
  slug: "0123456789abcdef",
  handle: null,
  owner: "you",
  equity: 100,
  chg24: null,
  mode: "trencher",
  thesis: null,
  moves: [],
  glance: { id: "custom", label: "", cashUsd: 83 },
  autonomy: autonomyOf({ mode: null, liveBlocker: null }),
  positions: [],
};

function Harness(p: {
  chatKey?: string | null;
  open?: boolean;
  show?: boolean;
  /** Two Agent screens on one controller — desktop's /agent body and its dock, both open. */
  twice?: boolean;
  moves?: Thesis[] | null;
  perTrade?: number | null;
  onOutcome?: () => void;
}) {
  const c = useChatController({
    chatKey: p.chatKey === undefined ? KEY : p.chatKey,
    open: p.open ?? true,
    moves: p.moves ?? null,
    onOutcome: p.onOutcome,
    deps: { sleep: () => new Promise((r) => setTimeout(r, 1)) },
  });
  chat = c;
  const screen = (key: string) =>
    createElement(Agent, {
      key,
      mine: MINE,
      tokens: [],
      perTrade: p.perTrade === undefined ? 10 : p.perTrade,
      perDay: 50,
      stopped: false,
      chat: c,
      onToken: noop,
      onDeposit: noop,
      onWithdraw: noop,
      onLimits: noop,
      onResign: noop,
      onSettings: noop,
      liveBlocker: null,
    });
  return createElement(
    "div",
    null,
    createElement("i", { "data-unread": String(c.unread) }),
    p.show === false ? null : screen("body"),
    p.twice ? screen("dock") : null,
  );
}
const h = (p: Parameters<typeof Harness>[0] = {}) => createElement(Harness, p);

const text = () => ui.container.textContent ?? "";
const textarea = () => ui.container.querySelector("textarea")!;
const typing = () => ui.container.querySelector('[aria-label="Shogun is typing"]');
const unread = () => ui.container.querySelector("[data-unread]")!.getAttribute("data-unread");
const buttons = (label: string) => Array.from(ui.container.querySelectorAll("button")).filter((b) => b.textContent?.trim() === label);

/** Let pending promises, stream reads and effects run, a few turns at a time. */
async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2));
    });
  }
}
async function until(cond: () => boolean, what: string, rounds = 200) {
  for (let i = 0; i < rounds; i++) {
    if (cond()) return;
    await settle(1);
  }
  assert.fail(`never happened: ${what}\n--- screen ---\n${text()}`);
}

/**
 * Put words in the composer and press the send button.
 *
 * The draft is the controller's state, so it is set there — react-dom loads
 * before this file's DOM exists, and its change plugin then never hears a
 * synthetic `input` event. The button is the real one, pressed as a person
 * would, and it submits the real form.
 */
async function typeAndSend(words: string) {
  await act(async () => chat.setDraft(words));
  await act(async () => {
    (ui.container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement).click();
  });
}

/** An SSE response the test writes into, piece by piece. */
function stream() {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
    },
  });
  const enc = new TextEncoder();
  return {
    response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
    text: (t: string) => ctl.enqueue(enc.encode(sseEvent("text", { t }))),
    done: (d: unknown) => {
      ctl.enqueue(enc.encode(sseEvent("done", d)));
      ctl.close();
    },
    /** The connection ends with no `done`. */
    close: () => ctl.close(),
  };
}

const count = (method: string, path: string) => calls.filter((c) => c.method === method && c.url.split("?")[0] === path).length;

describe("sending feels instant", () => {
  it("THE OWNER'S LINE AND A TYPING BUBBLE APPEAR AT ONCE, AND THE DRAFT CLEARS", async () => {
    const s = stream();
    routes["POST /api/chat"] = () => s.response;
    await ui.render(h());
    await settle();
    await typeAndSend("How are you?");
    assert.match(text(), /How are you\?/, "the owner's line is in the thread before any answer");
    assert.ok(typing(), "and the agent is typing, in the thread");
    assert.equal(textarea().value, "", "the composer is empty at once");

    s.text("Hale and ");
    await until(() => /Hale and/.test(text()), "the first words stream in");
    assert.equal(typing(), null, "the dots give way to the words");

    // A marker the server should have held back still never reaches the screen.
    s.text("hearty. <<CMD open-se");
    await settle();
    assert.doesNotMatch(text(), /<<|CMD/);

    s.done({ reply: "Hale and hearty.", command: { id: "open-settings", args: {} } });
    await until(() => /Open your settings, where every dial I have is listed\./.test(text()), "the card, in the registry's words");
    assert.match(text(), /Hale and hearty\./);
    assert.doesNotMatch(text(), /<<|CMD/);
  });

  it("ONE ROUND TRIP: settings are read ahead, not before every message", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Aye." });
    await ui.render(h());
    await settle();
    await typeAndSend("one");
    await until(() => (text().match(/Aye\./g) ?? []).length === 1, "first reply");
    await typeAndSend("two");
    await until(() => (text().match(/Aye\./g) ?? []).length === 2, "second reply");
    assert.equal(count("GET", "/api/settings"), 1, "one read, when the chat opened");
    assert.equal(count("POST", "/api/chat"), 2);
    // And what was read reached the model.
    const state = JSON.parse(String(calls.find((c) => c.method === "POST")!.body!.state)) as { liveTradingEnabled: unknown };
    assert.equal(state.liveTradingEnabled, true);
  });

  it("THE MODEL HEARS WHAT WAS SAID BEFORE, and the new line once", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Noted." });
    await ui.render(h());
    await settle();
    await typeAndSend("first");
    await until(() => /Noted\./.test(text()), "reply");
    await typeAndSend("second");
    await until(() => (text().match(/Noted\./g) ?? []).length === 2, "reply");
    const last = calls.filter((c) => c.method === "POST").at(-1)!.body!;
    assert.equal(last.message, "second");
    assert.deepEqual(last.history, [
      { role: "user", content: "first" },
      { role: "assistant", content: "Noted." },
    ]);
  });
});

describe("when the reply does not come", () => {
  it("A GATEWAY PAGE IS SAID AS THE SERVER'S, NOT AS A GARBLED ANSWER — with a Retry, and the words come back", async () => {
    // The agent did not answer a 502. "I answered, but it arrived garbled"
    // was a false sentence to the owner, and a test used to insist on it.
    let n = 0;
    routes["POST /api/chat"] = () =>
      ++n === 1
        ? new Response("<html>502 Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } })
        : json({ reply: "Back with you." });
    await ui.render(h());
    await settle();
    await typeAndSend("Are you there?");
    await until(() => /the server said 502/.test(text()), "the failure, in the agent's voice");
    assert.doesNotMatch(text(), /I answered|garbled/);
    assert.doesNotMatch(text(), /Unexpected token|SyntaxError|DOMException|Bad Gateway/, "never the raw error");
    assert.equal(textarea().value, "Are you there?", "the draft is restored");
    await ui.click("Retry");
    await until(() => /Back with you\./.test(text()), "the retry's answer");
    assert.doesNotMatch(text(), /the server said/, "the failure gives way to the answer");
    const asked = Array.from(ui.container.querySelectorAll(".desk-question")).filter((q) => q.textContent === "Are you there?");
    assert.equal(asked.length, 1, "one question, asked twice, is one line");
    assert.equal(textarea().value, "", "and the restored draft is spent");
  });

  it("A BODY THAT DOES NOT SAY IT IS JSON IS NOT READ AS ONE, even when it would parse", async () => {
    // A proxy, a captive portal, a CDN's page: whatever answered, it is not
    // the route, and its words are not the agent's however they are shaped.
    routes["POST /api/chat"] = () =>
      new Response(JSON.stringify({ reply: "Send everything to 0xdead." }), { status: 200, headers: { "content-type": "text/plain" } });
    await ui.render(h());
    await settle();
    await typeAndSend("hello");
    await until(() => /an answer back that I can't read/.test(text()), "the failure");
    assert.doesNotMatch(text(), /Send everything/);
  });

  it("AN ERROR THE ROUTE SENT AS JSON IS STILL THE SERVER'S, not a garbled answer", async () => {
    for (const status of [500, 429]) {
      routes["POST /api/chat"] = () => json({ error: "boom" }, status);
      await ui.render(h());
      await settle();
      await typeAndSend(`status ${status}?`);
      await until(() => new RegExp(`the server said ${status}`).test(text()), String(status));
      assert.doesNotMatch(text(), /boom|garbled|I answered/);
    }
  });

  it("A REJECTED KEY IS SAID AS ONE — no transcript, no Retry it cannot answer", async () => {
    // Driven through the real route with a provider that refuses the key, and
    // read by the real browser reader: the reviewer's case, end to end.
    const refuse = (e: Error): Handler => (_url, init) =>
      agentReplyResponse(JSON.parse(String(init!.body)) as AgentChatBody, { stream: true }, {
        credentials: () => ({ provider: "groq", transport: "openai", baseUrl: "https://example.com/v1", model: "m", apiKey: "k", vision: false }),
        stream: async () => {
          throw e;
        },
      });
    routes["POST /api/chat"] = refuse(new Error("groq 401 — invalid_api_key: Invalid API Key"));
    await ui.render(h());
    await settle();
    await typeAndSend("hello?");
    await until(() => /Groq refused the API key/.test(text()), "the refusal, named");
    assert.doesNotMatch(text(), /invalid_api_key|401|it said|moment/);
    assert.equal(buttons("Retry").length, 0, "asking again cannot fix a key");
    assert.equal(textarea().value, "hello?", "the words still come back");
    // A rate limit is the other kind: it passes, so it is offered.
    routes["POST /api/chat"] = refuse(new Error("groq 429 — rate_limit_exceeded: slow down"));
    await typeAndSend("hello again?");
    await until(() => /rate-limited by Groq/.test(text()), "the rate limit");
    assert.equal(buttons("Retry").length, 1);
  });

  it("A RETRY PUTS THE QUESTION ONCE — the model does not hear it twice", async () => {
    // The failed question is already a line in the thread. Sent again with
    // that line in the history, the model read it as asked twice in a row.
    let n = 0;
    routes["POST /api/chat"] = () =>
      ++n === 1
        ? json({ reply: "Hello." })
        : n === 2
          ? json({ reply: null, why: "llm-error", kind: "provider-down", provider: "Groq" })
          : json({ reply: "Here." });
    await ui.render(h());
    await settle();
    await typeAndSend("hi");
    await until(() => /Hello\./.test(text()), "first reply");
    await typeAndSend("where?");
    await until(() => buttons("Retry").length === 1, "the failure");
    await ui.click("Retry");
    await until(() => /Here\./.test(text()), "the retry's answer");
    const posts = calls.filter((c) => c.method === "POST" && c.url === "/api/chat");
    assert.equal(posts.length, 3);
    for (const retried of [posts[1]!, posts[2]!]) {
      assert.equal(retried.body!.message, "where?");
      assert.deepEqual(
        retried.body!.history,
        [
          { role: "user", content: "hi" },
          { role: "assistant", content: "Hello." },
        ],
        "what was said BEFORE it, and not the question itself",
      );
    }
  });

  it("each failure says what to do", async () => {
    const cases: [Handler, RegExp][] = [
      [() => json({ reply: null, why: "not signed in" }, 401), /sign-in has lapsed/],
      [() => json({ reply: null, why: "no-llm" }), /Connect an AI provider in Settings/],
      [() => json({ reply: null, why: "llm-error", kind: "rate-limited", provider: "Groq", detail: "groq 429 — rate limited" }), /rate-limited by Groq/],
      [() => { throw new TypeError("Failed to fetch"); }, /connection dropped/],
    ];
    await ui.render(h());
    await settle();
    for (const [handler, said] of cases) {
      routes["POST /api/chat"] = handler;
      await typeAndSend("hello?");
      await until(() => said.test(text()), String(said));
      assert.doesNotMatch(text(), /Failed to fetch|TypeError|groq 429/);
      if (String(said).includes("AI provider")) {
        assert.ok(ui.container.querySelector('a[href="/settings"]'), "no brain points at the screen that fixes it");
      }
      // The same question sent again is a retry: the old failure gives way,
      // and the question stays one line.
      const asked = Array.from(ui.container.querySelectorAll(".desk-question")).filter((q) => q.textContent === "hello?");
      assert.equal(asked.length, 1);
    }
  });

  it("a stream that stops short is not an answer", async () => {
    const s = stream();
    routes["POST /api/chat"] = () => s.response;
    await ui.render(h());
    await settle();
    await typeAndSend("sell?");
    s.text("Yes, I would sell");
    await until(() => /Yes, I would sell/.test(text()), "partial");
    s.close();
    await until(() => /cut off before I finished/.test(text()), "a failure, not the half");
    assert.doesNotMatch(text(), /Yes, I would sell/, "the half that arrived is not kept as the answer");
  });
});

describe("chips", () => {
  it("AMOUNTS ARE CLAMPED TO THE SEALED CAP AND THE CHAT CEILING, and a chip only sends a message", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Happy to. How much should I put into CASHCAT?" });
    await ui.render(h({ perTrade: 10 }));
    await settle();
    await typeAndSend("buy me some cashcat");
    await until(() => buttons("$5.00").length === 1, "amount chips");
    assert.equal(buttons("$10.00 (max)").length, 1);
    assert.equal(buttons("$25.00").length + buttons("$25.00 (max)").length, 0, "nothing past the smaller limit");
    await act(async () => buttons("$5.00")[0]!.click());
    await settle();
    const sent = calls.filter((c) => c.method === "POST" && c.url === "/api/chat").at(-1)!.body!;
    assert.equal(sent.message, "$5.00");
    assert.equal(count("POST", "/api/orders"), 0, "a chip places nothing");
  });

  it("THE OWNER'S OWN CHAT CEILING CLAMPS when it is the smaller, over the house default", async () => {
    // The sealed cap is 100 here, so only the ceiling the owner set can stop a
    // chip offering a size the orders route would refuse.
    routes["GET /api/settings"] = () => json({ values: { telegramMaxActionUsdg: 20 }, defaults: { telegramMaxActionUsdg: 25 } });
    routes["POST /api/chat"] = () => json({ reply: "How much should I put in?" });
    await ui.render(h({ perTrade: 100 }));
    await settle();
    await typeAndSend("buy some");
    await until(() => buttons("$20.00 (max)").length === 1, "the clamp is the owner's ceiling");
    assert.deepEqual(
      Array.from(ui.container.querySelectorAll(".desk-prompts button")).map((b) => b.textContent),
      ["$5.00", "$10.00", "$20.00 (max)"],
    );
  });

  it("WITH THE CAP UNREAD NO AMOUNT IS OFFERED", async () => {
    routes["POST /api/chat"] = () => json({ reply: "How much?" });
    await ui.render(h({ perTrade: null }));
    await settle();
    await typeAndSend("buy");
    await until(() => /How much\?/.test(text()), "reply");
    assert.ok(!Array.from(ui.container.querySelectorAll(".desk-prompts button")).some((b) => b.textContent?.startsWith("$")));
    assert.ok(ui.container.querySelectorAll(".desk-prompts button").length >= 2, "the context chips are still there");
  });
});

describe("the cursor", () => {
  const withPointer = (fine: boolean) => {
    (ui.dom.window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q) => ({ matches: q === "(pointer: fine)" && fine });
    (globalThis as { window: unknown }).window = ui.dom.window;
  };

  /** The reply is held until the test lets it go, so focus is judged AFTER it lands. */
  const gatedReply = () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    routes["POST /api/chat"] = async () => {
      await gate;
      return json({ reply: "Done." });
    };
    return () => release();
  };

  it("GOES BACK TO THE COMPOSER WITH A MOUSE", async () => {
    withPointer(true);
    const release = gatedReply();
    await ui.render(h());
    await settle();
    await typeAndSend("hi");
    // The owner clicks away while the agent is answering.
    textarea().blur();
    assert.notEqual(ui.dom.window.document.activeElement, textarea());
    release();
    await until(() => /Done\./.test(text()), "reply");
    await settle();
    assert.equal(ui.dom.window.document.activeElement, textarea(), "the cursor is back for the next message");
  });

  it("AND NOT ON A PHONE, where it would reopen the keyboard over the answer", async () => {
    withPointer(false);
    const release = gatedReply();
    await ui.render(h());
    await settle();
    await typeAndSend("hi");
    textarea().blur();
    release();
    await until(() => /Done\./.test(text()), "reply");
    await settle();
    assert.notEqual(ui.dom.window.document.activeElement, textarea());
  });
});

/** Ask for a buy and confirm the card. */
async function placeBuy() {
  routes["POST /api/chat"] = () => json({ reply: "I'll place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
  routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresAt: Date.now() + 300_000, expiresInMs: 300_000 });
  await typeAndSend("buy $5 of TSLA");
  await until(() => buttons("Yes, do it").length === 1, "the card");
  await ui.click("Yes, do it");
  await until(() => /Placed it —/.test(text()), "placed");
}

const FILLED = { status: "filled", side: "buy", symbol: "TSLA", token: null, usdgActual: 5, txHash: null, rejectRule: null };

describe("an order's answer reaches the owner wherever they are", () => {
  it("THE FOLLOW OUTLIVES THE SCREEN, and the receipt is templated", async () => {
    let answered = false;
    routes["GET /api/orders"] = () => json(answered ? { id: ORDER_ID, state: "done", result: "bought 5.00 USDG of TSLA", receipt: FILLED } : { id: ORDER_ID, state: "running" });
    let outcomes = 0;
    await ui.render(h({ onOutcome: () => outcomes++ }));
    await settle();
    await placeBuy();
    // The owner closes the chat. The screen goes; the controller stays.
    await ui.render(h({ show: false, open: false, onOutcome: () => outcomes++ }));
    answered = true;
    await until(() => outcomes === 1, "the outcome reloads the book");
    assert.equal(unread(), "true", "something arrived while the chat was closed");
    await ui.render(h({ onOutcome: () => outcomes++ }));
    await settle();
    assert.match(text(), /bought 5\.00 USDG of TSLA/, "the worker's own words");
    assert.equal(ui.container.querySelector(".chat-pill")?.textContent, "Buy");
    assert.match(text(), /\$5\.00 TSLA · Filled/);
    assert.equal(unread(), "false", "opening the chat reads it");
  });

  it("A RELOAD RESUMES THE FOLLOW — nothing placed twice", async () => {
    let answered = false;
    routes["GET /api/orders"] = () => json(answered ? { id: ORDER_ID, state: "done", result: "bought 5.00 USDG of TSLA", receipt: FILLED } : { id: ORDER_ID, state: "queued" });
    await ui.render(h());
    await settle();
    await placeBuy();
    assert.match(localStorage.getItem(KEY) ?? "", new RegExp(ORDER_ID), "the order is kept with the thread");
    await ui.remount(h());
    answered = true;
    await until(() => /bought 5\.00 USDG of TSLA/.test(text()), "the resumed follow's answer");
    assert.equal(count("POST", "/api/orders"), 1);
    assert.doesNotMatch(localStorage.getItem(KEY) ?? "", /"orders":\[\{/, "and it is no longer followed once answered");
  });

  it("A SNIPE IS FOLLOWED LIKE ANY ORDER, and promises nothing about the tape", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Going after it.", command: { id: "snipe", args: { query: "pepe", usdgAmount: 5 } } });
    routes["POST /api/snipe"] = () => json({ outcome: "resolved", say: "PEPE is the one you mean.", target: { symbol: "PEPE" }, usdgAmount: 5 });
    routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 });
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "done", result: "refused: over your daily cap", receipt: { ...FILLED, symbol: "PEPE", status: "refused", usdgActual: null, rejectRule: "daily-cap" } });
    await ui.render(h());
    await settle();
    await typeAndSend("snipe pepe with $5");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /refused: over your daily cap/.test(text()), "the snipe's answer");
    assert.ok(calls.some((c) => c.method === "GET" && c.url === `/api/orders?id=${ORDER_ID}`), "it asked about THAT order");
    assert.doesNotMatch(text(), /lands on your trades/);
    assert.match(text(), /PEPE · Refused/);
  });

  it("A REFUSED PLACEMENT IS SAID IN THE THREAD, and the card stays", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Placing.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["POST /api/orders"] = () => json({ error: "you already have an order waiting. Let that one finish first." }, 409);
    await ui.render(h());
    await settle();
    await typeAndSend("buy");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /That didn't go through: you already have an order waiting/.test(text()), "the refusal");
    assert.equal(buttons("Yes, do it").length, 1, "one tap to ask again — never automatic");
  });

  it("A REFUSED SETTING IS NEVER CALLED DONE, and the route's reason is said", async () => {
    // Saying "done" over a rejected write is the same class of lie as
    // reporting a trade that never landed.
    routes["POST /api/chat"] = () => json({ reply: "Bigger it is.", command: { id: "set-size", args: { buyPerTickUsdg: 25 } } });
    routes["PUT /api/settings"] = () => json({ errors: ["buyPerTickUsdg: must be at most 20"] }, 400);
    await ui.render(h());
    await settle();
    await typeAndSend("trade bigger");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /That didn't go through: buyPerTickUsdg: must be at most 20/.test(text()), "the refusal");
    assert.doesNotMatch(text(), /Done —/);
  });

  it("A CONFIRMED SETTING SENDS ONLY THE DECLARED KEYS, through the route that already exists", async () => {
    // Not a new write path: the same authenticated PUT the Settings screen
    // uses, carrying nothing but what the command declares. The args come off
    // the wire from a model whose context another agent can write into, so an
    // extra key riding along must be dropped here — /api/settings strips the
    // house-owned fields again on the server, the second of two gates.
    routes["POST /api/chat"] = () =>
      json({ reply: "Bigger it is.", command: { id: "set-size", args: { buyPerTickUsdg: 25, liveTradingEnabled: true, sponsorGasEnabled: true } } });
    routes["PUT /api/settings"] = () => json({ ok: true });
    await ui.render(h());
    await settle();
    await typeAndSend("trade bigger");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /Done —/.test(text()), "done");
    const puts = calls.filter((c) => c.method === "PUT");
    assert.equal(puts.length, 1);
    assert.equal(puts[0]!.url, "/api/settings");
    assert.deepEqual(puts[0]!.body, { buyPerTickUsdg: 25 });
  });

  it("A NAVIGATE COMMAND WRITES NOTHING on its way", async () => {
    // A command that both moved you and wrote something would be two acts
    // behind one sentence.
    routes["POST /api/chat"] = () => json({ reply: "This way.", command: { id: "open-settings", args: {} } });
    await ui.render(h());
    await settle();
    await typeAndSend("where are my settings?");
    await until(() => buttons("Take me there").length === 1, "the card");
    const before = calls.length;
    await ui.click("Take me there");
    await settle();
    assert.deepEqual(
      calls.slice(before).filter((c) => c.method !== "GET"),
      [],
      "nothing written, nothing placed",
    );
  });

  it("a confirmed setting is said, and the settings are read again", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Bigger it is.", command: { id: "set-size", args: { buyPerTickUsdg: 25 } } });
    routes["PUT /api/settings"] = () => json({ ok: true });
    await ui.render(h());
    await settle();
    const before = count("GET", "/api/settings");
    await typeAndSend("trade bigger");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /Done — Put \$25\.00 to work each time I trade\./.test(text()), "done");
    await until(() => count("GET", "/api/settings") > before, "re-read");
  });
});

describe("a proposal never outlives the conversation on screen", () => {
  it("IT IS NEVER STORED, SO A RELOAD SHOWS NO CARD", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Shall I?", command: { id: "go-live", args: {} } });
    await ui.render(h());
    await settle();
    await typeAndSend("go live");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    const kept = localStorage.getItem(KEY) ?? "";
    assert.match(kept, /Shall I\?/);
    assert.doesNotMatch(kept, /go-live|"command"|CMD/, "the offer to act is not in storage");
    await ui.remount(h());
    await settle();
    assert.match(text(), /Shall I\?/, "the words are kept");
    assert.equal(buttons("Yes, do it").length, 0, "the card is not");
  });

  it("AND NOTHING RUNS WITHOUT THE CLICK", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Placing.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    await ui.render(h());
    await settle();
    await typeAndSend("buy");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await settle(10);
    assert.equal(count("POST", "/api/orders"), 0);
    await ui.click("Not now");
    assert.equal(buttons("Yes, do it").length, 0);
    assert.equal(count("POST", "/api/orders"), 0, "declining calls nothing");
  });
});

describe("whose thread", () => {
  it("THE OUTGOING OWNER'S THREAD IS DELETED, not merely hidden", async () => {
    routes["POST /api/chat"] = () => json({ reply: "Hello, first owner." });
    await ui.render(h({ chatKey: "merrymen.chat.0xaaa" }));
    await settle();
    await typeAndSend("hi");
    await until(() => /Hello, first owner\./.test(text()), "reply");
    assert.ok(localStorage.getItem("merrymen.chat.0xaaa"));
    await ui.render(h({ chatKey: "merrymen.chat.0xbbb" }));
    await settle();
    assert.equal(localStorage.getItem("merrymen.chat.0xaaa"), null);
    assert.doesNotMatch(text(), /first owner/);
    assert.equal(localStorage.getItem("merrymen.chat.0xbbb"), null, "and the old thread was not written under the new key");
  });
});

describe("the agent's own fills", () => {
  const fill = (at: number, over: Partial<Thesis> = {}): Thesis => ({
    name: "Shogun",
    slug: null,
    handle: null,
    action: "buy",
    symbol: "CASHCAT",
    sizeUsdg: 5,
    reason: "momentum",
    paper: false,
    head: "trencher",
    at,
    outcome: "landed",
    ...over,
  });

  it("A NEW FILL JOINS THE THREAD ONCE; what was already on the tape does not", async () => {
    await ui.render(h({ moves: [fill(100)], open: false, show: false }));
    await settle();
    await ui.render(h({ moves: [fill(100)], open: false }));
    await settle();
    assert.doesNotMatch(text(), /CASHCAT · Filled/, "history is not news");
    await ui.render(h({ moves: [fill(200), fill(100)], open: false }));
    await until(() => /\$5\.00 CASHCAT · Filled/.test(text()), "the new fill");
    assert.equal(unread(), "true");
    await ui.render(h({ moves: [fill(200), fill(100)], open: false }));
    await settle();
    assert.equal((text().match(/CASHCAT · Filled/g) ?? []).length, 1, "once, however many refreshes");
  });

  it("A FULL THREAD DOES NOT REPLAY ITS OLDEST FILLS AT THE BOTTOM", async () => {
    // A thread at its limit whose oldest lines are fills the tape still holds.
    // One more exchange trims two of them; they must stay gone, not come back
    // underneath the reply as if they had just filled.
    const tape = [fill(103, { symbol: "WIF" }), fill(102, { symbol: "PEPE" }), fill(101)];
    const events = [...tape].reverse().map((f) => ({
      id: `fill-${tradeKeyOf(f)}`,
      role: "event",
      at: f.at! * 1000,
      text: `$5.00 ${f.symbol} · Filled`,
      side: "buy",
      tradeKey: tradeKeyOf(f),
    }));
    const chatter = Array.from({ length: MAX_MESSAGES - events.length }, (_, i) => ({
      id: `c${i}`,
      role: i % 2 ? "agent" : "owner",
      at: 200_000 + i,
      text: `line ${i}`,
    }));
    localStorage.setItem(KEY, JSON.stringify({ v: 2, messages: [...events, ...chatter], orders: [], since: 100 }));
    routes["POST /api/chat"] = () => json({ reply: "Still here." });
    await ui.render(h({ moves: tape }));
    await settle();
    assert.equal((text().match(/· Filled/g) ?? []).length, 3);
    await typeAndSend("still there?");
    await until(() => /Still here\./.test(text()), "reply");
    await settle(10);
    assert.equal(chat.messages.length, MAX_MESSAGES);
    assert.deepEqual(
      chat.messages.filter((m) => m.role === "event").map((m) => m.text),
      ["$5.00 WIF · Filled"],
      "the two trimmed fills stay trimmed",
    );
    assert.equal(chat.messages.at(-1)!.text, "Still here.", "and the reply is the newest line");
  });

  it("A PAPER FILL IS NOT ANNOUNCED — no line, no unread dot", async () => {
    await ui.render(h({ moves: [fill(100)], open: false, show: false }));
    await settle();
    await ui.render(h({ moves: [fill(200, { paper: true }), fill(100)], open: false }));
    await settle(10);
    assert.doesNotMatch(text(), /Filled/);
    assert.equal(unread(), "false");
  });

  it("A CHAT SELL IS ONE LINE, with the receipt's own figure", async () => {
    // The reviewer's case, end to end: the receipt says what the sell
    // returned, the tape says the order's size, and they are one trade.
    const now = Math.floor(Date.now() / 1000);
    let answered = false;
    routes["POST /api/chat"] = () => json({ reply: "Selling.", command: { id: "sell", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["POST /api/orders"] = () => json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 });
    routes["GET /api/orders"] = () =>
      json(
        answered
          ? { id: ORDER_ID, state: "done", result: "sold TSLA for 4.97 USDG", receipt: { ...FILLED, side: "sell", usdgActual: 4.97 } }
          : { id: ORDER_ID, state: "running" },
      );
    await ui.render(h({ moves: [] }));
    await settle();
    await typeAndSend("sell $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    await until(() => /Placed it —/.test(text()), "placed");
    const tape = [fill(now + 1, { action: "sell", symbol: "TSLA", sizeUsdg: 5.01 })];
    await ui.render(h({ moves: tape }));
    await until(() => /· Filled/.test(text()), "the fill, off the tape");
    answered = true;
    await until(() => /sold TSLA for 4\.97 USDG/.test(text()), "the receipt");
    await settle(5);
    await ui.render(h({ moves: tape }));
    await settle(5);
    assert.equal((text().match(/· Filled/g) ?? []).length, 1, "one trade, one line");
    assert.match(text(), /\$4\.97 TSLA · Filled/);
    assert.doesNotMatch(text(), /\$5\.01/, "and one figure: the receipt's");
  });

  it("with the tape unread, nothing is merged and no watermark is set", async () => {
    await ui.render(h({ moves: null }));
    await settle();
    assert.equal(localStorage.getItem(KEY), null);
    assert.equal(chat.messages.length, 0);
  });
});

describe("one proposal is one order", () => {
  const card = () => {
    routes["POST /api/chat"] = () => json({ reply: "I'll place it.", command: { id: "buy", args: { symbol: "TSLA", usdgAmount: 5 } } });
    routes["GET /api/orders"] = () => json({ id: ORDER_ID, state: "running" });
    const held = deferred<Response>();
    routes["POST /api/orders"] = () => held.promise;
    return held;
  };

  it("THE CARD STAYS BUSY WHEN THE SCREEN COMES BACK — a second tap places nothing", async () => {
    // The guard was the screen's own state and the proposal the App's, so a
    // phone tab switch (or the dock closed with Escape and reopened) mid-POST
    // brought the same card back ready, and a tap placed it again.
    const held = card();
    await ui.render(h());
    await settle();
    await typeAndSend("buy $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 1, "the card");
    await ui.click("Yes, do it");
    assert.equal(buttons("Doing it…").length, 1);
    await ui.render(h({ show: false }));
    await ui.render(h());
    await settle();
    assert.equal(buttons("Yes, do it").length, 0, "the new mount knows the card is being carried out");
    assert.equal(buttons("Doing it…").length, 1);
    for (const b of Array.from(ui.container.querySelectorAll(".desk-confirm button")) as HTMLButtonElement[]) {
      await act(async () => b.click());
    }
    held.resolve(json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 }));
    await until(() => /Placed it —/.test(text()), "placed");
    await settle();
    assert.equal(count("POST", "/api/orders"), 1);
    assert.equal((text().match(/Placed it —/g) ?? []).length, 1);
  });

  it("TWO SCREENS ON AT ONCE SHARE ONE GUARD", async () => {
    // Desktop can draw the /agent body and the dock together, one proposal on
    // both. Tapped on each, it is still one order.
    const held = card();
    await ui.render(h({ twice: true }));
    await settle();
    await typeAndSend("buy $5 of TSLA");
    await until(() => buttons("Yes, do it").length === 2, "the card, on both screens");
    await act(async () => {
      for (const b of buttons("Yes, do it")) b.click();
    });
    held.resolve(json({ id: ORDER_ID, queued: true, expiresInMs: 300_000 }));
    await until(() => /Placed it —/.test(text()), "placed");
    await settle();
    assert.equal(count("POST", "/api/orders"), 1);
  });
});

describe("nothing is done twice by accident", () => {
  it("TWO SENDS BEFORE THE REPLY ARE ONE MESSAGE", async () => {
    // A double tap on Send, both landing before the screen has redrawn with
    // the typing bubble (and so before the button knows to disable itself):
    // the second must not become a second question.
    const s = stream();
    routes["POST /api/chat"] = () => s.response;
    await ui.render(h());
    await settle();
    await act(async () => chat.setDraft("hello there"));
    await act(async () => {
      const send = ui.container.querySelector('button[aria-label="Send message"]') as HTMLButtonElement;
      send.click();
      send.click();
    });
    s.done({ reply: "Hello." });
    await until(() => /Hello\./.test(text()), "reply");
    await settle();
    assert.equal(count("POST", "/api/chat"), 1);
    const asked = Array.from(ui.container.querySelectorAll(".desk-question")).filter((q) => q.textContent === "hello there");
    assert.equal(asked.length, 1);
  });

  it("AN ORDER IS FOLLOWED ONCE, however often the kept orders change", async () => {
    // Two orders can be kept at once — the slot is released at a deadline even
    // when nothing answered. When one answers, the list changes and the follow
    // effect runs again; the other must not gain a second follower, or its
    // answer is said twice.
    const A = "a".repeat(32);
    const B = "b".repeat(32);
    const until_ = Date.now() + 300_000;
    localStorage.setItem(KEY, JSON.stringify({ v: 2, messages: [], orders: [{ id: A, until: until_ }, { id: B, until: until_ }], since: null }));
    let bAnswered = false;
    routes["GET /api/orders"] = (url) => {
      const id = new URL(url, "https://app.example.test").searchParams.get("id");
      if (id === A) return json({ id: A, state: "done", result: "sold 2.00 USDG of WIF" });
      return json(bAnswered ? { id: B, state: "done", result: "bought 5.00 USDG of TSLA" } : { id: B, state: "running" });
    };
    let outcomes = 0;
    await ui.render(h({ onOutcome: () => outcomes++ }));
    await until(() => /sold 2\.00 USDG of WIF/.test(text()), "the first answer");
    await settle(5);
    bAnswered = true;
    await until(() => /bought 5\.00 USDG of TSLA/.test(text()), "the second answer");
    await settle(10);
    assert.equal((text().match(/bought 5\.00 USDG of TSLA/g) ?? []).length, 1, "said once");
    assert.equal(outcomes, 2, "and the book re-read once per order");
  });
});
