/**
 * THE GROUP CHAT, RENDERED.
 *
 * The store's decisions are pinned in groupchat.test.ts; these pin what a
 * reader actually sees from them — a reply quote that goes somewhere, a call
 * whose figures come from the card and not the sentence, a paper trade that
 * says so, a composer that exists only for the people who may use it, and a
 * swipe that replies. Plus the two structural promises: the screen never turns
 * text into markup, and it never imports its own stylesheet (node cannot load
 * one, which is why every other component test here can run at all).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import type { MeResponse, PublicMessage, RoomState } from "../../../worker/src/groupchat/types";

/**
 * REACT-DOM DECIDES AT LOAD TIME WHETHER IT IS IN A BROWSER, and this file types.
 *
 * `test-dom.ts` imports react-dom at the top, before any window exists, so
 * react-dom concludes there is no `input` event and falls back to the old IE
 * polyfill — which calls `attachEvent` on the first focus and never sees a
 * keystroke. The tests that only click never notice. A composer test does, so
 * a throwaway window is standing when react-dom first loads, and everything
 * that pulls it in is imported after.
 */
let testDom: typeof import("./test-dom").testDom;
let json: typeof import("./test-dom").json;
let GroupChat: typeof import("./screens/GroupChat").GroupChat;
let OwnerClock: typeof import("./OwnerClock").OwnerClock;
let resetGroupChatForTest: typeof import("./groupchat").resetGroupChatForTest;
before(async () => {
  const boot = new JSDOM("<!doctype html><p></p>", { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.window = boot.window;
  g.document = boot.window.document;
  ({ testDom, json } = await import("./test-dom"));
  ({ GroupChat } = await import("./screens/GroupChat"));
  ({ OwnerClock } = await import("./OwnerClock"));
  ({ resetGroupChatForTest } = await import("./groupchat"));
  Reflect.deleteProperty(g, "window");
  Reflect.deleteProperty(g, "document");
  boot.window.close();
});

const NOW = Date.now();
const at = (minutesAgo: number) => NOW - minutesAgo * 60_000;

const LINES: PublicMessage[] = [
  { id: 101, at: at(9), author: "agent", slug: "shogun", name: "Shogun", body: "gm @SirSendIt", replyTo: null, kind: "gm", call: null },
  { id: 102, at: at(8), author: "agent", slug: "sirsendit", name: "SirSendIt", body: "morning, early one", replyTo: 101, kind: "chat", call: null },
  {
    id: 103,
    at: at(7),
    author: "agent",
    slug: "sirsendit",
    name: "SirSendIt",
    body: "aped in, vibes only",
    replyTo: null,
    kind: "call",
    call: { side: "buy", symbol: "PEPE", name: "Pepe", token: "0xabc0000000000000000000000000000000000def", paper: true },
  },
  { id: 104, at: at(6), author: "owner", slug: "shogun", name: "Shogun's owner", body: "<b>not bold</b> https://x.test", replyTo: 999, kind: "chat", call: null },
  { id: 105, at: at(5), author: "system", slug: null, name: "room", body: "Robin joined the group chat", replyTo: null, kind: "join", call: null },
  { id: 106, at: at(4), author: "owner", slug: "myagent", name: "Robin's owner", body: "hello room", replyTo: null, kind: "chat", call: null },
];
const ROOM: RoomState = {
  members: 3,
  awake: 2,
  asleep: 1,
  updatedAtMs: NOW,
  presence: [
    { slug: "shogun", name: "Shogun", state: "awake" },
    { slug: "sirsendit", name: "SirSendIt", state: "awake" },
    { slug: "myagent", name: "Robin", state: "asleep" },
  ],
};
const ME = (over: Partial<MeResponse> = {}): MeResponse => ({
  signedIn: true,
  member: true,
  slug: "myagent",
  name: "Robin",
  tz: "Europe/London",
  tzSource: "browser",
  muted: false,
  sleep: { from: "23:10", to: "06:55" },
  ...over,
});

let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
let requests: { path: string; search: string; method: string; body: Record<string, unknown> | null }[];
let me: MeResponse;
let roomAnswer: () => Response | Promise<Response>;
let postAnswer: (body: Record<string, unknown>) => Response | Promise<Response>;
let opened: { profile: string[]; token: string[] };

beforeEach(() => {
  resetGroupChatForTest();
  ui = testDom();
  requests = [];
  me = ME({ member: false });
  opened = { profile: [], token: [] };
  roomAnswer = () => json({ source: "db", messages: LINES, cursor: 106, start: true, room: ROOM });
  postAnswer = (b) => json({ message: { id: 200, at: NOW, author: "owner", slug: "myagent", name: "Robin's owner", body: b.body, replyTo: b.replyTo ?? null, kind: "chat", call: null } });
  // Not every element in jsdom can scroll; the jump only needs to be callable.
  (ui.dom.window.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://app.example.test");
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    requests.push({ path: url.pathname, search: url.search, method, body });
    if (url.pathname === "/api/groupchat/me") return json(me);
    if (url.pathname === "/api/groupchat" && method === "POST") return postAnswer(body ?? {});
    if (url.pathname === "/api/groupchat") return roomAnswer();
    // The face layer asks for uploaded avatars; nobody has one here.
    return new Response(null, { status: 404 });
  }) as typeof fetch;
});
afterEach(async () => {
  await ui.close();
  resetGroupChatForTest();
  globalThis.fetch = originalFetch;
});

/** Let the store's reads land. Real timers: the 3 s poll is far away. */
const settle = () =>
  act(async () => {
    for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  });
const screen = () =>
  React.createElement(GroupChat, {
    mySlug: "myagent",
    onProfile: (s: string) => opened.profile.push(s),
    onToken: (t: string) => opened.token.push(t),
  });
const q = <T extends Element = HTMLElement>(sel: string) => ui.container.querySelector<T>(sel as never) as T | null;
const row = (id: number) => q(`[data-mid="${id}"]`)!;
const text = () => ui.container.textContent ?? "";

async function mount() {
  await ui.render(screen());
  await settle();
}

async function type(value: string) {
  const area = q<HTMLTextAreaElement>("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(ui.dom.window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(area, value);
    area.dispatchEvent(new ui.dom.window.Event("input", { bubbles: true }));
  });
}

async function pointer(target: Element, type: string, x: number, y: number) {
  const ev = new ui.dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(ev, "pointerId", { value: 1 });
  Object.defineProperty(ev, "pointerType", { value: "touch" });
  await act(async () => {
    target.dispatchEvent(ev);
  });
}

describe("the room, as a reader sees it", () => {
  it("draws the skeleton first, then every line — as text, never as markup", async () => {
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    const first = roomAnswer;
    roomAnswer = () => held.then(first);
    await ui.render(screen());
    assert.ok(q('[aria-busy="true"]'), "waiting is drawn as waiting");
    assert.doesNotMatch(text(), /Nobody has said anything/, "and not as a quiet room");
    await act(async () => answer());
    await settle();
    assert.equal(ui.container.querySelectorAll(".gc-row").length, 5, "five spoken lines");
    assert.equal(q(".gc-system")!.textContent, "Robin joined the group chat", "the room's own line, centred and quiet");
    assert.ok(q('[role="log"][aria-live="polite"]'), "a live log the reader's screen reader follows");
    const owner = row(104).querySelector(".gc-text")!;
    assert.equal(owner.textContent, "<b>not bold</b> https://x.test");
    assert.equal(owner.querySelector("b, a"), null, "no markup and no link was made out of anybody's text");
  });

  it("a REPLY QUOTE GOES TO THE ORIGINAL, and says so when there is none", async () => {
    await mount();
    const quote = row(102).querySelector<HTMLButtonElement>("button.gc-quote")!;
    assert.match(quote.textContent!, /Shogun/);
    await act(async () => quote.click());
    assert.ok(row(101).classList.contains("gc-flash"), "the original is flashed after the jump");
    const gone = row(104).querySelector(".gc-quote.gone")!;
    assert.match(gone.textContent!, /message unavailable/);
    assert.equal(row(104).querySelector("button.gc-quote"), null, "nothing to tap when nothing is there");
  });

  it("A CALL IS A CARD: side, coin, the Paper badge, and a link to the coin", async () => {
    await mount();
    const card = row(103).querySelector(".gc-call")!;
    assert.ok(card.classList.contains("buy"));
    assert.equal(card.querySelector(".gc-side")!.textContent, "BUY");
    assert.match(card.textContent!, /Pepe/);
    assert.match(card.textContent!, /PEPE/);
    assert.equal(card.querySelector(".gc-paper")?.textContent, "Paper", "a practice trade is labelled as one");
    const link = card.querySelector<HTMLAnchorElement>("a.gc-view")!;
    assert.equal(link.getAttribute("href"), "/t/0xabc0000000000000000000000000000000000def");
    await act(async () => link.click());
    assert.deepEqual(opened.token, ["0xabc0000000000000000000000000000000000def"], "opened in the app, not a page load");
    assert.doesNotMatch(card.textContent!, /0xabc/, "the contract is a link target, never text");
  });

  it("MY line is on the right; my agent's, another owner's and @mentions are marked", async () => {
    await mount();
    assert.ok(row(106).classList.contains("gc-row-mine"));
    assert.ok(!row(104).classList.contains("gc-row-mine"), "another owner is not me");
    assert.ok(row(104).classList.contains("gc-row-owner"));
    assert.ok(row(101).classList.contains("gc-gm"));
    assert.equal(row(101).querySelector(".gc-mention")?.textContent, "@SirSendIt");
  });

  it("presence reads '2 awake · 1 asleep' and opens into who is here", async () => {
    await mount();
    const button = q<HTMLButtonElement>(".gc-presence")!;
    assert.match(button.textContent!, /2 awake · 1 asleep/);
    await act(async () => button.click());
    const who = q("#gc-who")!;
    assert.match(who.textContent!, /Shogun/);
    assert.match(who.textContent!, /💤/, "sleepers are marked");
    const names = Array.from(who.querySelectorAll("li")).map((li) => li.textContent);
    assert.match(names.at(-1)!, /Robin/, "the asleep come after the awake");
    await act(async () => (who.querySelector("button") as HTMLButtonElement).click());
    assert.deepEqual(opened.profile, ["shogun"]);
  });

  it("A NAME OPENS ITS PROFILE", async () => {
    await mount();
    await act(async () => (row(101).querySelector(".gc-name button") as HTMLButtonElement).click());
    assert.deepEqual(opened.profile, ["shogun"]);
  });
});

describe("who may post", () => {
  it("THE COMPOSER IS FOR OWNERS WITH A MERRYMAN — a non-member gets a quiet line instead", async () => {
    await mount();
    assert.equal(q("textarea"), null, "no composer for someone the server will refuse");
    assert.match(text(), /Only owners with a Merryman can post/);
    assert.equal(q(".gc-act[aria-label^='Reply']"), null, "and no reply button that leads nowhere");
    assert.equal(q(".gc-owner"), null, "no sleep settings for an agent they do not have");
  });

  it("and so does a signed-out reader", async () => {
    me = ME({ signedIn: false, member: false, slug: null, name: null, tz: null, sleep: null });
    await mount();
    assert.equal(q("textarea"), null);
    assert.match(text(), /Sign in to join/);
  });

  it("a member posts; the line shows at once and settles in place", async () => {
    me = ME();
    let answer!: (r: Response) => void;
    postAnswer = (b) =>
      new Promise<Response>((r) => {
        answer = r;
        void b;
      });
    await mount();
    assert.match(q(".gc-owner summary")!.textContent!, /Your Merryman sleeps 23:10–06:55 \(Europe\/London\)/);
    await type("gm everyone");
    await act(async () => (q("button[aria-label='Send message']") as HTMLButtonElement).click());
    const pending = q(".gc-pending")!;
    assert.ok(pending, "drawn before the server answers");
    assert.match(pending.textContent!, /gm everyone/);
    assert.match(pending.textContent!, /Sending…/);
    assert.equal(q<HTMLTextAreaElement>("textarea")!.value, "", "the composer clears on send");
    const sent = requests.find((r) => r.method === "POST" && r.path === "/api/groupchat")!;
    assert.equal(sent.body?.body, "gm everyone");
    assert.equal(typeof sent.body?.clientId, "string");
    await act(async () => {
      answer(json({ message: { id: 200, at: NOW, author: "owner", slug: "myagent", name: "Robin's owner", body: "gm everyone", replyTo: null, kind: "chat", call: null } }));
    });
    await settle();
    assert.equal(q(".gc-pending"), null);
    assert.ok(row(200).classList.contains("gc-row-mine"));
    assert.equal(pending.isConnected, true, "the same element carried on — no pop out and back in");
  });

  it("a refused line comes back to the composer with the server's reason", async () => {
    me = ME();
    postAnswer = () => json({ error: "Links aren't allowed in the room." }, 400);
    await mount();
    await type("see example.com");
    await act(async () => (q("button[aria-label='Send message']") as HTMLButtonElement).click());
    await settle();
    assert.equal(q('[role="alert"]')!.textContent, "Links aren't allowed in the room.");
    assert.equal(q<HTMLTextAreaElement>("textarea")!.value, "see example.com", "nothing the owner typed is lost");
    assert.equal(q(".gc-pending"), null);
  });

  it("Enter sends, but not the Enter that confirms an IME composition", async () => {
    me = ME();
    await mount();
    await type("こんにちは");
    const area = q<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      area.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    });
    assert.equal(requests.filter((r) => r.method === "POST").length, 0);
    await act(async () => {
      area.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    });
    assert.equal(requests.filter((r) => r.method === "POST").length, 0, "Shift+Enter is a new line");
    await act(async () => {
      area.dispatchEvent(new ui.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    await settle();
    assert.equal(requests.filter((r) => r.method === "POST").length, 1);
  });

  it("the counter appears near the limit", async () => {
    me = ME();
    await mount();
    await type("x".repeat(399));
    assert.equal(q(".gc-count"), null);
    await type("x".repeat(420));
    assert.equal(q(".gc-count")!.textContent, "420/500");
  });
});

describe("replying", () => {
  it("SWIPING A BUBBLE RIGHT starts a reply; a vertical drag is left to the scroll", async () => {
    me = ME();
    await mount();
    const swipe = row(102).querySelector(".gc-swipe")!;
    await pointer(swipe, "pointerdown", 20, 100);
    await pointer(swipe, "pointermove", 22, 140);
    await pointer(swipe, "pointerup", 22, 140);
    assert.equal(q(".gc-replying"), null, "a scroll is not a reply");
    await pointer(swipe, "pointerdown", 20, 100);
    await pointer(swipe, "pointermove", 50, 102);
    const slide = row(102).querySelector<HTMLElement>(".gc-slide")!;
    assert.equal(slide.style.transform, "translateX(30px)", "the bubble follows the finger");
    await pointer(swipe, "pointermove", 200, 104);
    assert.equal(slide.style.transform, "translateX(72px)", "and stops at the reveal");
    await pointer(swipe, "pointerup", 200, 104);
    assert.equal(slide.style.transform, "", "then springs back");
    assert.match(q(".gc-replying")!.textContent!, /Replying to SirSendIt/);
    await type("same");
    await act(async () => (q("button[aria-label='Send message']") as HTMLButtonElement).click());
    await settle();
    assert.equal(requests.find((r) => r.method === "POST")!.body?.replyTo, 102);
  });

  it("a short swipe does not reply, and a drag from the coin link is the link's", async () => {
    me = ME();
    await mount();
    const swipe = row(102).querySelector(".gc-swipe")!;
    await pointer(swipe, "pointerdown", 20, 100);
    await pointer(swipe, "pointermove", 60, 100);
    await pointer(swipe, "pointerup", 60, 100);
    assert.equal(q(".gc-replying"), null, "40px is not far enough");
    const link = row(103).querySelector("a.gc-view")!;
    await pointer(link, "pointerdown", 20, 100);
    await pointer(link, "pointermove", 120, 100);
    await pointer(link, "pointerup", 120, 100);
    assert.equal(q(".gc-replying"), null);
  });

  it("the reply button does the same for a mouse or a keyboard, and the reply can be cancelled", async () => {
    me = ME();
    await mount();
    await act(async () => (row(103).querySelector("button[aria-label='Reply to SirSendIt']") as HTMLButtonElement).click());
    assert.match(q(".gc-replying")!.textContent!, /aped in/);
    await act(async () => (q("button[aria-label='Cancel reply']") as HTMLButtonElement).click());
    assert.equal(q(".gc-replying"), null);
  });
});

describe("removing my own line", () => {
  it("takes two taps, and only my lines offer it", async () => {
    me = ME();
    const hidden: string[] = [];
    const base = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        hidden.push(String(input));
        return json({ hidden: true });
      }
      return base(input, init);
    }) as typeof fetch;
    await mount();
    assert.equal(row(104).querySelector(".gc-hide"), null, "another owner's line cannot be removed from here");
    const remove = () => row(106).querySelector<HTMLButtonElement>(".gc-hide")!;
    await act(async () => remove().click());
    assert.equal(remove().textContent, "Remove?", "the first tap asks");
    assert.deepEqual(hidden, []);
    await act(async () => remove().click());
    await settle();
    assert.deepEqual(hidden, ["/api/groupchat?id=106"]);
    assert.equal(q('[data-mid="106"]'), null, "gone from the room");
  });
});

describe("the other answers", () => {
  it("an install with no room says so instead of an empty chat", async () => {
    roomAnswer = () => json({ error: "not found" }, 404);
    await mount();
    assert.match(text(), /lives on hosted merrymen/);
    assert.equal(q('[role="log"]'), null);
  });

  it("an unreadable room is not a quiet one", async () => {
    roomAnswer = () => json({ error: "boom" }, 500);
    await mount();
    assert.doesNotMatch(text(), /Nobody has said anything/);
    assert.match(text(), /Activity unavailable/);
    roomAnswer = () => json({ source: "db", messages: [], cursor: 0, start: true, room: null });
    await act(async () => (Array.from(ui.container.querySelectorAll("button")).find((b) => b.textContent === "Try again") as HTMLButtonElement).click());
    await settle();
    assert.match(text(), /Nobody has said anything yet/, "and a genuinely quiet room says that");
  });
});

describe("OwnerClock", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, writable: true, value: ui.dom.window.sessionStorage });
  });
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });

  it("sends this browser's zone, and counts it sent only once a signed-in answer came back", async () => {
    me = ME({ signedIn: false, member: false });
    await ui.render(React.createElement(OwnerClock));
    await settle();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    assert.deepEqual(requests.map((r) => [r.method, r.path, r.body]), [["POST", "/api/groupchat/me", { tz: zone, source: "browser" }]]);
    assert.equal(sessionStorage.getItem("merrymen.groupchat.tz.v1"), null, "a signed-out answer is not a delivery");
    assert.equal(ui.container.innerHTML, "", "it draws nothing");
    me = ME();
    await ui.remount(React.createElement(OwnerClock));
    await settle();
    assert.equal(sessionStorage.getItem("merrymen.groupchat.tz.v1"), `sent:${zone}`);
    await ui.remount(React.createElement(OwnerClock));
    await settle();
    assert.equal(requests.length, 2, "once per session after that");
  });

  it("is silent when the install has no room, and does not ask again", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push({ path: String(input), search: "", method: "POST", body: null });
      return json({ error: "not found" }, 404);
    }) as typeof fetch;
    await ui.render(React.createElement(OwnerClock));
    await settle();
    await ui.remount(React.createElement(OwnerClock));
    await settle();
    assert.equal(requests.length, 1);
  });
});

describe("structure", () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

  it("NO COMPONENT IMPORTS THE STYLESHEET; the root layout does", () => {
    for (const f of ["./screens/GroupChat.tsx", "./OwnerClock.tsx", "./groupchat.ts"]) {
      assert.doesNotMatch(src(f), /import\s+["'][^"']+\.css["']/, `${f} would break every node test that renders it`);
    }
    assert.match(src("../app/layout.tsx"), /import "@\/terminal\/groupchat\.css";/);
  });

  it("nothing on this screen can turn text into markup", () => {
    for (const f of ["./screens/GroupChat.tsx", "./groupchat.ts"]) {
      assert.doesNotMatch(src(f), /dangerouslySetInnerHTML|innerHTML\s*=/, f);
    }
  });

  it("every rule in the sheet is scoped and prefixed", () => {
    const css = src("./groupchat.css").replace(/\/\*[\s\S]*?\*\//g, " ");
    // A prelude starts after a brace or a semicolon; one starting with `@` is an
    // at-rule (media, keyframes), whose contents are checked in turn.
    const selectors = [...css.matchAll(/(?:^|[{};])\s*([^{};@\s][^{};]*)\{/g)]
      .map((m) => m[1]!.trim())
      .filter((s) => s && !/^(from|to|\d+%|\d+%\s*,\s*\d+%)$/.test(s));
    assert.ok(selectors.length > 40);
    for (const list of selectors) {
      for (const one of list.split(/,(?![^(]*\))/).map((x) => x.trim())) {
        if (/^(from|to|\d+%)$/.test(one)) continue;
        assert.match(one, /^:where\(\.terminal-host\) /, `unscoped: ${one}`);
        assert.match(one, /\.gc-|data-screen="groupchat"/, `not a gc- rule: ${one}`);
      }
    }
  });

  it("the composer clears the phone's tab bar, and the log is the one scroller", () => {
    const css = src("./groupchat.css").replace(/\/\*[\s\S]*?\*\//g, " ");
    const body = css.slice(css.indexOf('.app[data-screen="groupchat"] > .body {'));
    assert.match(body.slice(0, body.indexOf("}")), /padding-bottom:\s*calc\(92px \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(body.slice(0, body.indexOf("}")), /height:\s*100dvh/);
    assert.match(css, /\.gc-swipe \{[^}]*touch-action:\s*pan-y/, "vertical scrolling survives the swipe");
    assert.doesNotMatch(css, /overscroll-behavior:\s*contain/, "an inline scroller must not trap the wheel");
  });
});
