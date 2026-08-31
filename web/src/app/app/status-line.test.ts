import assert from "node:assert/strict";
import test from "node:test";
import { statusLine, type AgentSnapshot } from "./status-line";

/**
 * A user with $318 in the account asked, in the group chat, "Will it now start
 * trading" — looking at a screen that led with Total equity, "building today ·
 * no deposit on record yet", and a cash/vault/positions split. All true, none
 * of it an answer. These tests are about whether the sentence answers him.
 */

const base: AgentSnapshot = {
  name: "Robin",
  mode: "live",
  testnet: false,
  hasGas: true,
  cashUsdg: 318,
  positionsUsdg: 0,
  positionCount: 0,
  tradableCount: 3,
  landedToday: 0,
  refusedToday: 0,
  daysLeft: 29,
  lastError: null,
};

test("HIS EXACT SITUATION gets an answer, not a balance sheet", () => {
  const l = statusLine(base);
  assert.match(l.headline, /Robin is live and watching/);
  assert.match(l.next, /hasn't found a trade worth making/);
  // And it says the quiet state is normal, because the honest answer to "will
  // it trade" is often "not yet, and that is fine" — which reads as broken
  // unless somebody says so.
  assert.match(l.next, /normal state most of the time/);
  assert.equal(l.tone, "good");
});

test("A STUCK AGENT SAYS SO, above everything else", () => {
  // The failure that hid a fleet-wide outage for hours: ten agents unable to
  // arm, every dashboard showing a calm page of stale numbers.
  const l = statusLine({
    ...base,
    lastError: "this key was signed before a wall fix and CANNOT trade: it carries a rate-limit policy whose contract has no code on this chain. Re-signing is free.",
  });
  assert.equal(l.tone, "stuck");
  assert.match(l.headline, /stopped and can't start again/);
  // The reason reaches the user, trimmed to the part that says what is wrong.
  assert.match(l.next, /signed before a wall fix/);
  assert.equal(l.next.includes("Re-signing is free"), false, "one sentence, not the whole paragraph");
});

test("a stuck agent outranks every happier truth", () => {
  // It is holding money, it traded today, it has gas — and none of that matters
  // if it cannot start. Ordering is the design.
  const l = statusLine({
    ...base,
    positionCount: 2,
    positionsUsdg: 200,
    landedToday: 4,
    lastError: "boom",
  });
  assert.equal(l.tone, "stuck");
});

test("NEVER CLAIMS THE MARKET IS CLOSED, because it cannot see a clock", () => {
  // The tempting sentence is "the market is closed, it trades at 2:30pm". This
  // module has no calendar and no timezone, so saying that would be inventing —
  // the same class of mistake as reporting unknown as zero.
  for (const s of [base, { ...base, cashUsdg: 0 }, { ...base, mode: "paper" as const }]) {
    const l = statusLine(s);
    assert.equal(/market is closed|opens at|market hours/i.test(l.headline + l.next), false);
  }
});

test("practice is called practice, in words a person uses", () => {
  const paper = statusLine({ ...base, mode: "paper" });
  assert.match(paper.headline, /practising/);
  assert.match(paper.headline, /pretend money/);

  const testnet = statusLine({ ...base, testnet: true });
  assert.match(testnet.headline, /none of this is real money/);
  assert.match(testnet.next, /free and takes one signature/);
});

test("no gas is distinguished from no capital — different problems, different fixes", () => {
  const noGas = statusLine({ ...base, hasGas: false });
  assert.match(noGas.headline, /no ETH for fees/);
  assert.match(noGas.next, /Send a little ETH/);

  const noCash = statusLine({ ...base, cashUsdg: 0 });
  assert.match(noCash.headline, /nothing to trade with/);
  assert.match(noCash.next, /Send USDG/);
});

test("refusals are reported as the product working, not as failures", () => {
  // A tape full of red "refused" rows is the wall doing its job, and it reads
  // as breakage unless the summary says otherwise.
  const l = statusLine({ ...base, refusedToday: 7 });
  assert.match(l.headline, /turned them down/);
  assert.match(l.next, /Passing is normal/);
  assert.equal(l.tone, "good");
});

test("an expiring key is surfaced without hijacking the headline", () => {
  const l = statusLine({ ...base, positionCount: 1, positionsUsdg: 120, daysLeft: 1 });
  assert.match(l.headline, /holding \$120/, "what it is doing still comes first");
  assert.match(l.next, /expires in 1 day/);
  assert.equal(l.tone, "waiting");
  // And it does not nag when there is plenty of time.
  assert.equal(/expires/.test(statusLine({ ...base, daysLeft: 29 }).next), false);
});

test("money reads the way people write it", () => {
  assert.match(statusLine({ ...base, positionCount: 1, positionsUsdg: 1234.56 }).headline, /\$1,235/);
  assert.match(statusLine({ ...base, positionCount: 1, positionsUsdg: 12.5 }).headline, /\$12\.5/);
});

test("NO JARGON anywhere in any branch", () => {
  // The words the old screen used, which is what made it unreadable.
  //
  // USDG SURVIVES THIS LIST, deliberately. It is the name of the thing the user
  // has to send, and "send money" would be ambiguous with ETH — a different
  // problem with a different fix, distinguished two tests above precisely
  // because confusing them wastes somebody an afternoon. What IS banned is USDG as
  // a trailing unit on a number: "318.00 USDG" is what made a balance look like
  // telemetry.
  const banned = /equity|session key|steady-basket|weekend-gap|bps|wall|grant|positions/i;
  const unitSuffix = /[d.,]s*USDG/;
  const cases: AgentSnapshot[] = [
    base,
    { ...base, mode: "paper" },
    { ...base, mode: "idle" },
    { ...base, testnet: true },
    { ...base, hasGas: false },
    { ...base, cashUsdg: 0 },
    { ...base, positionCount: 3, positionsUsdg: 500 },
    { ...base, landedToday: 2 },
    { ...base, refusedToday: 5 },
    { ...base, daysLeft: 0 },
  ];
  for (const c of cases) {
    const l = statusLine(c);
    assert.equal(banned.test(l.headline), false, `jargon in headline: ${l.headline}`);
    assert.equal(banned.test(l.next), false, `jargon in next: ${l.next}`);
    assert.equal(unitSuffix.test(l.headline + l.next), false, `USDG as a unit: ${l.headline}`);
  }
});

test("every branch says what happens next — a status with no next step is a support ticket", () => {
  const cases: AgentSnapshot[] = [
    base,
    { ...base, mode: "paper" },
    { ...base, mode: "idle" },
    { ...base, testnet: true },
    { ...base, hasGas: false },
    { ...base, cashUsdg: 0 },
    { ...base, positionCount: 1, positionsUsdg: 50 },
    { ...base, landedToday: 3 },
    { ...base, refusedToday: 2 },
    { ...base, lastError: "something specific went wrong here." },
  ];
  for (const c of cases) {
    const l = statusLine(c);
    assert.ok(l.headline.length > 10, "a headline");
    assert.ok(l.next.length > 20, `a next step for: ${l.headline}`);
    assert.match(l.headline, /\.$/, "a full sentence, ending in a full stop");
  }
});
