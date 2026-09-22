/**
 * A SETTING CHANGED FROM CHAT HAS TO SURVIVE THE NEXT FIFTEEN SECONDS.
 *
 * `/strategy` and `/cap` called `patchSettingsFile` and nothing else. That
 * writes the CHILD's settings.json — and hosted, `writeSettingsForChild`
 * replaces that file wholesale from the tenant store on a 15-second reconcile.
 * So the bot replied "strategy → dip-hunter", the owner watched it revert, and
 * nothing anywhere said why. Self-hosted there is no orchestrator and both
 * always worked, which is how it survived.
 *
 * `/link` hit this first and solved it by writing a second, child-owned record
 * the parent promotes. These tests cover the same mechanism for the three
 * settings chat can change — /strategy, /cap and /name — and the rules that
 * keep the promotion safe: an allowlist of what a chat may touch at all, and a
 * stored marker so one change is applied once, not re-applied for ever.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rememberChatSetting, type TelegramState } from "./state";
import { CHAT_SETTABLE, promotedSettings } from "./chat-settings";

const base = { chatSettings: null } as unknown as TelegramState;

/** The `stateRef` shape the service hands its writers. */
function ref(initial: TelegramState = base) {
  let st = initial;
  return { get: () => st, set: (next: TelegramState) => { st = next; }, current: () => st };
}

describe("the child records what chat changed", () => {
  it("writes the value and the time", () => {
    const r = ref();
    rememberChatSetting(r, { strategy: "dip-hunter" }, 1_000);
    assert.deepEqual(r.current().chatSettings, { at: 1_000, patch: { strategy: "dip-hunter" } });
  });

  it("MERGES TWO CHANGES RATHER THAN KEEPING THE LAST", () => {
    // An owner who sends /strategy and then /cap has made two changes and
    // expects both. Replacing would apply one and drop the other silently.
    const r = ref();
    rememberChatSetting(r, { strategy: "dip-hunter" }, 1_000);
    rememberChatSetting(r, { telegramMaxActionUsdg: 25 }, 1_005);
    assert.deepEqual(r.current().chatSettings, {
      at: 1_005,
      patch: { strategy: "dip-hunter", telegramMaxActionUsdg: 25 },
    });
  });

  it("moves the stamp forward even when the value repeats", () => {
    // The stamp is what the parent's guard reads. "Already stored" and "changed
    // back to the same thing" are the same state, and neither needs promoting
    // twice — but the stamp must still advance or a later change is compared
    // against a stale one.
    const r = ref();
    rememberChatSetting(r, { strategy: "dip-hunter" }, 1_000);
    rememberChatSetting(r, { strategy: "dip-hunter" }, 2_000);
    assert.equal(r.current().chatSettings?.at, 2_000);
  });

  it("leaves the rest of the state alone", () => {
    const r = ref({ ...base, offset: 42, messageCount: 7 } as TelegramState);
    rememberChatSetting(r, { strategy: "even-keel" }, 1_000);
    assert.equal(r.current().offset, 42);
    assert.equal(r.current().messageCount, 7);
  });
});

/**
 * The parent half — the REAL implementation, imported.
 *
 * An earlier version of this file reproduced the logic locally because
 * orchestrator.ts is a process entry point and importing it starts a fleet.
 * That is a copy, and a copy of a security decision drifts from the thing it
 * claims to describe. The decision now lives in chat-settings.ts for exactly
 * this reason, and the orchestrator calls the same function these tests do.
 */
const promote = promotedSettings;

describe("the parent promotes it once", () => {
  it("writes a chat change into the stored settings", () => {
    const out = promote({ strategy: "steady-basket" }, { at: 1_000, patch: { strategy: "dip-hunter" } });
    assert.equal(out?.strategy, "dip-hunter");
    assert.equal(out?.telegramSettingsAt, 1_000);
  });

  it("DOES NOT RE-APPLY IT ON THE NEXT PASS", () => {
    // The reconcile runs every 15 seconds. Without the guard the parent would
    // rewrite the same value for ever — and overwrite anything the owner saved
    // on the dashboard in between, which is the failure `put` replacing the
    // whole blob makes possible.
    const stored = { strategy: "dip-hunter", telegramSettingsAt: 1_000 };
    assert.equal(promote(stored, { at: 1_000, patch: { strategy: "dip-hunter" } }), null);
  });

  it("lets the dashboard win afterwards, and the next chat change win after that", () => {
    const afterChat = promote({}, { at: 1_000, patch: { strategy: "dip-hunter" } })!;
    // The owner then saves something else on the web. The parent must not undo it.
    const afterWeb = { ...afterChat, strategy: "even-keel" };
    assert.equal(promote(afterWeb, { at: 1_000, patch: { strategy: "dip-hunter" } }), null);
    // A NEW chat change does apply.
    assert.equal(promote(afterWeb, { at: 2_000, patch: { strategy: "trencher" } })?.strategy, "trencher");
  });

  it("promotes nothing when there is nothing recorded", () => {
    assert.equal(promote({ strategy: "steady-basket" }, null), null);
  });
});

describe("what a chat may not change", () => {
  it("REFUSES EVERY FIELD OUTSIDE THE ALLOWLIST", () => {
    // An allowlist, not a denylist, because the two mistakes do not cost the
    // same: a field missing from an allowlist does not take effect, while a
    // field missing from a denylist takes effect with full force. A child is
    // reached through a BEARER link code.
    const out = promote({}, {
      at: 1_000,
      patch: {
        strategy: "dip-hunter",
        telegramPcControlEnabled: true,
        telegramAgentEnabled: true,
        telegramAgentAutoShell: true,
        telegramShellAllowlist: ["rm"],
        telegramFilesRoot: "/",
        liveTradingEnabled: true,
        bundlerApiKey: "stolen",
      },
    })!;
    assert.equal(out.strategy, "dip-hunter");
    for (const k of [
      "telegramPcControlEnabled",
      "telegramAgentEnabled",
      "telegramAgentAutoShell",
      "telegramShellAllowlist",
      "telegramFilesRoot",
      "liveTradingEnabled",
      "bundlerApiKey",
    ]) {
      assert.ok(!(k in out), `${k} reached the stored settings from a chat`);
    }
  });

  it("still burns the marker when the patch carried nothing acceptable", () => {
    // Otherwise a value this build does not accept is retried every fifteen
    // seconds for the life of the tenant, and the log says so every time.
    const out = promote({}, { at: 1_000, patch: { telegramAgentEnabled: true } })!;
    assert.equal(out.telegramSettingsAt, 1_000);
    assert.ok(!("telegramAgentEnabled" in out));
  });

  it("does not let a chat change turn into remote execution", () => {
    // The specific escalation the allowlist exists to stop: these three are
    // forced off hosted by worker/src/settings.ts precisely because a chat can
    // reach them, and a promotion path that wrote them would route around that.
    const out = promote({}, {
      at: 1,
      patch: { telegramPcControlEnabled: true, telegramAgentEnabled: true, telegramAgentAutoShell: true },
    })!;
    assert.deepEqual(Object.keys(out).sort(), ["telegramSettingsAt"]);
  });
});

describe("a rename from chat survives the next tick", () => {
  it("is a setting a chat may change", () => {
    // /name was the worst of the three. /strategy and /cap lasted the fifteen
    // seconds until the orchestrator's reconcile; a rename lasted ONE TICK,
    // because index.ts rewrites the identity file from cfg.agentName whenever
    // the two differ — a reconciliation that exists so the dashboard wins, and
    // which therefore undid the chat rename immediately.
    const out = promote({}, { at: 1_000, patch: { agentName: "Shogun" } });
    assert.equal(out?.agentName, "Shogun");
  });

  it("carries a rename alongside the other two", () => {
    const out = promote({}, {
      at: 1_000,
      patch: { agentName: "Shogun", strategy: "trencher", telegramMaxActionUsdg: 25 },
    })!;
    assert.equal(out.agentName, "Shogun");
    assert.equal(out.strategy, "trencher");
    assert.equal(out.telegramMaxActionUsdg, 25);
  });

  it("stores exactly three settable fields, and no more", () => {
    // The allowlist is the boundary a bearer link code runs into. Widening it
    // is a security decision; this fails loudly when someone widens it without
    // reading why, rather than quietly accepting the new field.
    assert.deepEqual([...CHAT_SETTABLE].sort(), ["agentName", "strategy", "telegramMaxActionUsdg"]);
  });
});
