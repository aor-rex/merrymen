import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * THE NAME MUST BE READ BACK FROM WHERE IT WAS WRITTEN.
 *
 * The bug, written down because the owner hit it four times and reasonably
 * concluded the save was broken. It never was.
 *
 * Hosted, a tenant's settings are written to the per-tenant sealed store
 * (`getSettingsStore().put(tenant, …)` in api/settings). The web container's own
 * `~/.merrymen/settings.json` is written by nothing, and could not hold a
 * particular tenant's settings even if it existed — it is one file per
 * container, shared by every tenant. /api/feed read exactly that file, so the
 * read always threw and every hosted tenant got the fallback: the name went
 * null and the console fell back to the ledger's "Robin", while strategy and
 * basket showed house defaults regardless of what had been configured.
 *
 * It passed local testing because self-hosted the file IS the store, so the two
 * halves agree there and only there.
 */

const FEED = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const SETTINGS = readFileSync(new URL("../settings/route.ts", import.meta.url), "utf8");
const WORKER = readFileSync(new URL("../../../../../worker/src/index.ts", import.meta.url), "utf8");

describe("the feed reads identity from the tenant's own store", () => {
  it("hosted goes to the settings store, never to a file", () => {
    assert.match(FEED, /import \{ getSettingsStore \} from "@merrymen\/settings-store"/);
    assert.match(FEED, /if \(isHostedMode\(\)\)[\s\S]{0,300}?getSettingsStore\(\)\.get\(tenant\)/);
  });

  it("a signed-out hosted caller does NOT fall through to the file read", () => {
    // Load-bearing: falling through would show a signed-out visitor whatever
    // container-global config happened to be on disk.
    assert.match(FEED, /if \(!tenant\) return IDENTITY_FALLBACK;/);
  });

  it("identity is threaded with the tenant at every call site", () => {
    // The whole failure was one function that could not see who was asking.
    assert.match(FEED, /async function readIdentitySettings\(tenant: `0x\$\{string\}` \| null\)/);
    assert.match(FEED, /async function identityOf\(fromLedger: string, tenant: `0x\$\{string\}` \| null\)/);
    for (const m of FEED.matchAll(/identityOf\(([^)]*)\)/g)) {
      if (m[1]!.includes(":")) continue; // the declaration itself
      assert.match(m[0], /,\s*tenant\)|,\s*null\)/, `identityOf must be given a tenant: ${m[0]}`);
    }
  });

  it("the basket falls back to what the WORKER actually trades", () => {
    // TRADEABLE_SYMBOLS is the registry of what CAN be traded (14 symbols), not
    // the default holding (3). A tenant on defaults was shown a basket their
    // agent was never going to trade.
    assert.match(FEED, /const DEFAULT_BASKET = \[\.\.\.SETTINGS_DEFAULTS\.basketSymbols\]/);
    // Anchored to the IMPORT, not any mention — the comment above the constant
    // explains what it replaced, and matching prose would fail forever.
    assert.ok(!/^import[\s\S]*?TRADEABLE_SYMBOLS[\s\S]*?from "@merrymen\/core"/m.test(FEED));
  });
});

describe("the two name normalisers agree", () => {
  it("the API stores the SAME shape the soul does", () => {
    // The soul does `raw.trim().replace(/\s+/g, " ")`; the API did a bare
    // `.trim()`. The shared regex admits internal double spaces, so
    // "Little  John" was stored verbatim and collapsed by the soul — and the
    // reconcile's `cfg.agentName !== getName()` then stayed true forever. That
    // was one wasted write per re-arm before; once the reconcile runs every
    // tick it would be an identity-file rewrite every tick, silently, because
    // setName returns ok and logs nothing.
    assert.match(SETTINGS, /v\.trim\(\)\.replace\(\/\\s\+\/g, " "\)/);
  });
});

describe("the worker reconciles a rename while it is already armed", () => {
  it("the reconcile runs BEFORE the unchanged short-circuit", () => {
    // A name is in neither connectionKey nor strategyKey, so renaming forces no
    // re-arm; for an already-armed agent `unchanged` is true on every tick
    // forever, and the reconcile below it never ran again. The owner could save
    // a name, have it accepted and stored, and the soul would stay "Robin" for
    // the life of the process.
    const reconcile = WORKER.indexOf("RECONCILE THE NAME BEFORE THE SHORT-CIRCUIT");
    const shortCircuit = WORKER.indexOf("if (unchanged) return true;");
    assert.ok(reconcile > 0, "the reconcile must be present");
    assert.ok(shortCircuit > 0, "the short-circuit must be present");
    assert.ok(reconcile < shortCircuit, "the name reconcile must run before the short-circuit returns");
  });

  it("it is guarded on a real difference, so a normal tick writes nothing", () => {
    assert.match(WORKER, /if \(want && want !== getName\(\)\)/);
  });

  it("it normalises the same way the soul does before comparing", () => {
    assert.match(WORKER, /cfg\.agentName\.trim\(\)\.replace\(\/\\s\+\/g, " "\)/);
  });
});
