import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * THE PROMISE A SKIP MAKES, pinned in the source.
 *
 * "Do not interrupt me again" is the entire feature. It is also the kind of
 * promise that survives review and dies in a refactor, because every way of
 * breaking it looks reasonable in isolation: awaiting the server before hiding
 * the card, trusting the newer of two stores, reading `done:false` as "not
 * seen". Each of those is one line, and each one reopens a tour somebody closed.
 *
 * Source-scanned rather than rendered, which is this repo's existing idiom for
 * a claim about how a component is wired (see confirm-card.test.ts). The
 * behaviour itself was exercised in a browser against the dev server; what these
 * tests hold is the shape that made it true.
 */

const COMPONENT = readFileSync(new URL("./FirstVisit.tsx", import.meta.url), "utf8");
const CSS = readFileSync(new URL("./first-visit.css", import.meta.url), "utf8");
const ROUTE = readFileSync(new URL("../app/api/tour/route.ts", import.meta.url), "utf8");
const APP = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

describe("the tour is shown once, to everyone", () => {
  it("THE SERVER MAY ONLY ADD A DISMISSAL, NEVER TAKE ONE AWAY", () => {
    // The single most important line in the component. `/api/tour` answers
    // `done:false, signedIn:false` to a signed-out visitor — which is most
    // visitors — and reading that as "you have not seen it" would reopen the
    // tour on every load for exactly the people who had just closed it.
    assert.match(
      COMPONENT,
      /if \(!alive \|\| !s\?\.signedIn \|\| !s\.done\) return;/,
      "the server response must be ignored unless it is a signed-in YES",
    );
    // And there must be no path that sets done back to false from a fetch.
    const serverBlock = COMPONENT.slice(COMPONENT.indexOf('fetch("/api/tour", { cache'));
    const upToNextFetch = serverBlock.slice(0, serverBlock.indexOf("const finish"));
    assert.ok(
      !/setDone\(false\)/.test(upToNextFetch),
      "nothing in the server read may clear a dismissal",
    );
  });

  it("the browser is written BEFORE the server is told, and the UI never waits", () => {
    // A dismissal that depended on a round trip would come back whenever the
    // round trip failed. Local first means a failed POST costs a re-show on a
    // DIFFERENT device and nothing at all on this one.
    const finish = COMPONENT.slice(COMPONENT.indexOf("const finish"), COMPONENT.indexOf("const goto"));
    const local = finish.indexOf("writeLocal({ done: true");
    const post = finish.indexOf('fetch("/api/tour", { method: "POST" })');
    assert.ok(local > -1 && post > -1, "finish must write locally and tell the server");
    assert.ok(local < post, "the local write must come first");
    assert.ok(!/await .*\/api\/tour/.test(finish), "the card must not wait on the network to close");
  });

  it("`done` starts TRUE, so a returning visitor never sees a flash of it", () => {
    // Between mount and the first effect there is one paint. Starting at false
    // would show the card to somebody who dismissed it last week, for that
    // frame, on every single load.
    assert.match(COMPONENT, /useState\(true\);\s*\n\s*const \[step/, "done must default to true");
  });

  it("the storage key is VERSIONED, which is how a rewritten tour reaches everybody once", () => {
    assert.match(COMPONENT, /const KEY = "merrymen\.tour\.v\d+";/);
    // v1 was the panel this replaced. Reusing its key would have silently
    // suppressed the new tour for every existing user — the opposite of the ask.
    assert.ok(!COMPONENT.includes("merrymen.guide.v1"), "the old panel's key must not be reused");
  });

  it("THERE IS NO ACCOUNT GATE — the tour is for people who have not signed up yet", () => {
    // The panel it replaced rendered nothing until an account loaded, so the
    // one person a first visit is for never saw it.
    assert.ok(!/if \(!account\) return null/.test(COMPONENT), "an account gate would exclude new visitors");
    assert.ok(!/account:\s*AccountState/.test(COMPONENT), "the component should not take an account at all");
    assert.match(APP, /<FirstVisit onScreen=/, "App must pass only what the tour uses");
  });

  it("escape closes it, because a full-screen overlay that traps you is a bug", () => {
    assert.match(COMPONENT, /e\.key === "Escape"/);
  });
});

describe("the card is the shape that was asked for", () => {
  it("carries a step counter, a way out, a dot per stop, and Back/Next", () => {
    assert.match(COMPONENT, /\{step \+ 1\} \/ \{STOPS\.length\}/, "a step counter");
    assert.match(COMPONENT, /Skip tour/, "a way out that is always in the same place");
    assert.match(COMPONENT, /STOPS\.map\(\(_, i\) => \(/, "one dot per stop");
    assert.match(COMPONENT, /className="tour-back"/, "Back");
    assert.match(COMPONENT, /\{last \? "Finish" : "Next"\}/, "Next, and a different word on the last stop");
  });

  it("Back is DISABLED on the first stop rather than hidden", () => {
    // A control that disappears moves the one beside it, and Next is the button
    // people aim for.
    assert.match(COMPONENT, /className="tour-back"[\s\S]{0,120}disabled=\{step === 0\}/);
    assert.match(CSS, /\.tour-back:disabled/);
  });

  it("the accent is the house accent, not the price-direction green", () => {
    // `--up` is also green and would have looked right. It means "the price
    // went up"; borrowing it for a Next button makes the one colour in this
    // product that carries a fact start carrying a decoration too.
    assert.match(CSS, /\.tour-next \{[\s\S]*?background: var\(--lime\)/);
    assert.match(CSS, /\.tour-dots i\.on \{[\s\S]*?background: var\(--lime\)/);
    assert.ok(!/var\(--up\)/.test(CSS), "the tour must not borrow the price-up colour");
  });

  it("a stop with no target, or one that is hidden, degrades to a centred card", () => {
    // The tab bar is display:none on desktop, where a sidebar takes over. A
    // spotlight ring around a zero-size box would be a bright rectangle in the
    // corner of the screen.
    assert.ok(
      COMPONENT.includes("if (r.width > 0 && r.height > 0) {"),
      "a zero-size target is not a target",
    );
    // And the candidates are tried in ORDER, so the phone anchor wins on a
    // phone and the desktop one wins on a laptop — decided by what is actually
    // on screen rather than by a viewport-width guess.
    assert.ok(
      COMPONENT.includes("for (const sel of target) {"),
      "each stop tries its candidates in order",
    );
    assert.ok(
      COMPONENT.includes(`['[data-tour="tab-home"]', "#explore-tab-markets"]`),
      "a stop should name both the mobile tab and its desktop equivalent",
    );
    assert.match(COMPONENT, /spot \? "tour-card" : "tour-card centred"/);
  });

  it("reduced motion is honoured", () => {
    assert.match(CSS, /@media \(prefers-reduced-motion: reduce\)/);
  });
});

describe("the route answers a signed-out visitor without calling it an error", () => {
  it("both verbs return 200 with signedIn:false rather than 401", () => {
    // Every other hosted-only route 401s a signed-out caller, and that is right
    // for them. The tour is shown to everyone, so its own ordinary case must not
    // arrive as a failure the client has to special-case — the first thing
    // anyone does with a failing fetch is stop calling it.
    const gets = ROUTE.slice(ROUTE.indexOf("export async function GET"));
    assert.match(gets, /if \(!tenant\) return NextResponse\.json\(\{ done: false, signedIn: false \}/);
    const post = ROUTE.slice(ROUTE.indexOf("export async function POST"));
    assert.match(post, /if \(!tenant\) return NextResponse\.json\(\{ done: false, signedIn: false \}/);
    assert.ok(!/status: 401/.test(ROUTE), "a signed-out visitor is not an error here");
  });

  it("A STORE THAT WILL NOT ANSWER IS NOT A 'NO'", () => {
    // Reporting done:false on a database hiccup would reopen the tour for
    // everyone who had dismissed it, which is the complaint this exists to end.
    const catches = ROUTE.match(/\} catch \{[\s\S]*?\}/g) ?? [];
    assert.ok(catches.length >= 2, "both verbs must handle a store failure");
    for (const c of catches) {
      assert.match(c, /signedIn: false/, "a failed read must say 'could not ask', not 'has not seen'");
    }
  });

  it("there is no route that can UN-dismiss somebody else's tour", () => {
    assert.ok(!/export async function DELETE/.test(ROUTE));
    assert.ok(!/\bclear\(/.test(ROUTE), "clear() is for the kill path and tests, not a public verb");
  });
});
