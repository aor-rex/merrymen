import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REPEAT_SEC,
  SETTLE_SEC,
  signDecision,
  signKeyboard,
  signNeed,
  signPromptText,
  signUrl,
} from "./sign-prompt";

const NOW = 1_800_000_000;
const DAY = 86_400;
const grant = { grantedAt: NOW - 10 * DAY, grantExpiresAt: NOW + 20 * DAY };

describe("signNeed — when a signature is the fix", () => {
  it("asks for the three blockers only a signature clears", () => {
    for (const blocker of ["dead-policy", "wrong-chain", "grant-too-wide"]) {
      const n = signNeed({ blocker, ...grant, now: NOW });
      assert.equal(n?.reason, blocker);
      assert.equal(n?.settles, true, `${blocker} waits out the ferry lag`);
    }
  });

  it("never asks for a signature that would change nothing", () => {
    for (const blocker of ["no-gas", "no-cash", "no-executor", "live-not-enabled", "not-armed", null]) {
      assert.equal(signNeed({ blocker, ...grant, now: NOW }), null, String(blocker));
    }
  });

  it("no grant at all is onboarding, not a stall — no prompt", () => {
    assert.equal(signNeed({ blocker: "dead-policy", grantedAt: null, grantExpiresAt: null, now: NOW }), null);
  });

  it("an expired permission is spoken at once, and outranks any blocker", () => {
    const n = signNeed({ blocker: "dead-policy", grantedAt: NOW - DAY, grantExpiresAt: NOW - 1, now: NOW });
    assert.equal(n?.reason, "expired");
    assert.equal(n?.settles, false);
  });

  it("running out within a day is its own reason, but a blocker is the one thing to ask for", () => {
    const soon = { grantedAt: NOW - DAY, grantExpiresAt: NOW + 3600 * 5 };
    assert.equal(signNeed({ blocker: null, ...soon, now: NOW })?.reason, "expiring");
    assert.equal(signNeed({ blocker: "wrong-chain", ...soon, now: NOW })?.reason, "wrong-chain");
  });

  it("keys on the grant, so a NEW grant that is still wrong asks again", () => {
    const a = signNeed({ blocker: "grant-too-wide", ...grant, now: NOW })!;
    const b = signNeed({ blocker: "grant-too-wide", grantedAt: NOW, grantExpiresAt: NOW + 30 * DAY, now: NOW })!;
    assert.notEqual(a.key, b.key);
  });
});

describe("signDecision — once, settled, then daily", () => {
  const blocked = { key: "sign:dead-policy:1-2", settles: true };

  it("does not speak a blocker the moment it appears — the child may not have seen the new grant yet", () => {
    const first = signDecision(blocked, null, undefined, NOW);
    assert.equal(first.send, false);
    assert.deepEqual(first.watch, { key: blocked.key, since: NOW });
    const early = signDecision(blocked, first.watch, undefined, NOW + SETTLE_SEC - 1);
    assert.equal(early.send, false);
    const settled = signDecision(blocked, first.watch, undefined, NOW + SETTLE_SEC);
    assert.equal(settled.send, true);
  });

  it("a blocker that clears inside the settle window is never spoken", () => {
    const first = signDecision(blocked, null, undefined, NOW);
    const cleared = signDecision(null, first.watch, undefined, NOW + 60);
    assert.deepEqual(cleared, { send: false, watch: null });
  });

  it("repeats once a day while it stays true, not every pass", () => {
    const watch = { key: blocked.key, since: NOW - SETTLE_SEC };
    assert.equal(signDecision(blocked, watch, NOW - 60, NOW).send, false);
    assert.equal(signDecision(blocked, watch, NOW - REPEAT_SEC, NOW).send, true);
  });

  it("expiry needs no settling", () => {
    const d = signDecision({ key: "sign:expired:x", settles: false }, null, undefined, NOW);
    assert.equal(d.send, true);
  });

  it("a different key restarts the settle clock", () => {
    const watch = { key: "sign:dead-policy:old", since: NOW - DAY };
    const d = signDecision(blocked, watch, undefined, NOW);
    assert.equal(d.send, false);
    assert.equal(d.watch?.since, NOW);
  });
});

describe("the message and the button", () => {
  it("says free, names the agent, and never uses the internal words", () => {
    for (const reason of ["dead-policy", "wrong-chain", "grant-too-wide", "expiring", "expired"] as const) {
      const text = signPromptText(reason, { blocker: null, ...grant, grantExpiresAt: NOW + 3600 * 5, now: NOW }, "Shogun");
      assert.match(text, /Shogun/);
      assert.match(text, /free/i, reason);
      assert.doesNotMatch(text, /\bgrant\b|policy|wall|session key|bundler|smart account/i, reason);
    }
  });

  it("escapes the agent's name — it is owner-chosen text inside HTML", () => {
    assert.match(signPromptText("expired", { blocker: null, ...grant, now: NOW }, "<b>x</b>"), /&lt;b&gt;x&lt;\/b&gt;/);
  });

  it("opens the dashboard's own re-sign anchor, and pins the network only for a wrong-chain fix", () => {
    assert.equal(signUrl("https://app.merrymen.dev/", "dead-policy"), "https://app.merrymen.dev/grant#resign");
    assert.equal(signUrl("https://app.merrymen.dev", "wrong-chain"), "https://app.merrymen.dev/grant?chain=4663#resign");
    assert.deepEqual(signKeyboard("https://x/grant#resign"), [[{ text: "✍️ Sign now", url: "https://x/grant#resign" }]]);
  });
});
