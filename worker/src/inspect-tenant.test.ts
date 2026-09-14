/**
 * A DIAGNOSTIC THAT READS A SEALED SETTINGS BLOB MUST NOT BE ABLE TO PRINT ONE.
 *
 * The settings object this data comes from can hold a Telegram bot token, an
 * allowlist, an LLM key and a grant's worth of addresses. The protection is
 * structural rather than careful: `describeTenant` is handed a flat record of
 * the named fields and never the object, so nothing else is in scope where the
 * strings are built. These tests pin that, and pin the null-versus-default
 * distinction the report exists to preserve.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { describeTenant, type TenantFacts } from "./inspect-tenant";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const facts = (over: Partial<TenantFacts> = {}): TenantFacts => ({
  tenant: "0x4b6dcd559c82ea897c34dacfb785fb0c8f85d4c5",
  smartAccount: "0xa96Bf429888e1aAb4255762d17d29C53f6a0370d",
  grantClassVault: null,
  derivedClassVault: "0xC8776FAFf15212C359b23BAe531fF3aC7d760E0F",
  vaultDeployed: false,
  assetMode: null,
  liveTradingEnabled: true,
  classSnipeEnabled: null,
  classPerEntryUsdg: null,
  classMaxPositions: null,
  scoutEnabled: null,
  scoutBudgetUsdg: null,
  scoutPerTokenUsdg: null,
  classMinDepthUsdg: null,
  maxImpactBps: null,
  slippageBps: null,
  classMaxHoldSec: null,
  classExitAtGraduationPct: null,
  settingsMissing: false,
  settingsError: null,
  ...over,
});

describe("the report says what is set and what is merely defaulted", () => {
  it("marks an unset field as unset AND names the default", () => {
    // These resolve identically at runtime and mean opposite things to somebody
    // deciding what to change: one is a choice, the other is a gap.
    const out = describeTenant(facts()).join("\n");
    assert.match(out, /classSnipeEnabled\s+\(unset\) -> default false/);
    assert.match(out, /classMinDepthUsdg\s+\(unset\) -> default 250/);
  });

  it("and prints a set field as its actual value", () => {
    const out = describeTenant(facts({ classPerEntryUsdg: 5, assetMode: "all" })).join("\n");
    assert.match(out, /classPerEntryUsdg\s+5/);
    assert.match(out, /assetMode\s+"all"/);
  });

  it("reports an unreadable settings row as UNKNOWN, never as default", () => {
    const out = describeTenant(facts({ settingsError: "decrypt failed" })).join("\n");
    assert.match(out, /settings UNREADABLE/);
    assert.match(out, /unknown, NOT default/);
    assert.doesNotMatch(out, /\(unset\)/, "a failed read must not be dressed as an absent field");
  });

  it("and an absent vault-code read as UNKNOWN, not NO", () => {
    const out = describeTenant(facts({ vaultDeployed: null })).join("\n");
    assert.match(out, /deployed on-chain: UNKNOWN \(could not read\)/);
  });
});

describe("sealed and deployed are answered separately", () => {
  it("says NO to sealed when the grant carries no vault", () => {
    const out = describeTenant(facts({ grantClassVault: null })).join("\n");
    assert.match(out, /class vault sealed in grant:\s+NO/);
    // And still names the vault, so a NO can be discussed concretely.
    assert.match(out, /0xC8776FAFf15212C359b23BAe531fF3aC7d760E0F/);
  });

  it("says YES when it does, and reports deployment independently", () => {
    const out = describeTenant(
      facts({ grantClassVault: "0xC8776FAFf15212C359b23BAe531fF3aC7d760E0F", vaultDeployed: false }),
    ).join("\n");
    assert.match(out, /class vault sealed in grant:\s+YES/);
    assert.match(out, /deployed on-chain: NO/);
  });
});

describe("it names the blocker rather than leaving it to be inferred", () => {
  it("lists every closed gate", () => {
    const out = describeTenant(facts()).join("\n");
    assert.match(out, /class route BLOCKED BY/);
    assert.match(out, /no class vault sealed/);
    assert.match(out, /classSnipeEnabled is not true/);
    assert.match(out, /classPerEntryUsdg is 0/);
  });

  it("and says so when every gate it can see is open", () => {
    const out = describeTenant(
      facts({
        grantClassVault: "0xC8776FAFf15212C359b23BAe531fF3aC7d760E0F",
        classSnipeEnabled: true,
        classPerEntryUsdg: 5,
        classMaxPositions: 3,
        liveTradingEnabled: true,
        assetMode: "all",
      }),
    ).join("\n");
    assert.match(out, /every gate this module can see is OPEN/);
  });

  it("and counts assetMode 'stocks' as a blocker, because it excludes the route", () => {
    const out = describeTenant(facts({ assetMode: "stocks" })).join("\n");
    assert.match(out, /assetMode is "stocks"/);
  });
});

describe("IT CANNOT PRINT A SECRET", () => {
  it("takes named fields, never the settings object", () => {
    /**
     * The structural guarantee. If this function ever accepted the blob, a
     * formatter would be the only thing standing between a bot token and a log
     * line — and the first person to add a field would not know that.
     */
    const src = readFileSync(path.join(__dirname, "inspect-tenant.ts"), "utf8");
    const body = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const forbidden of [
      "telegramBotToken",
      "anthropicApiKey",
      "groqApiKey",
      "telegramAllowlist",
      "grant_json",
      "DATABASE_URL",
      "MERRYMEN_STORE_DEK",
      "privateKey",
      "sessionKey",
    ]) {
      assert.ok(!body.includes(forbidden), `${forbidden} must not appear in the reporter`);
    }
    // And it must not iterate an arbitrary record into output.
    assert.doesNotMatch(body, /Object\.entries\(s\)|Object\.keys\(s\)/);
    assert.doesNotMatch(body, /JSON\.stringify\(settings/);
  });

  it("and the orchestrator hook hands it one field at a time", () => {
    const orch = readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
    const body = orch.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    // The whole settings object must never be spread into the facts record.
    assert.doesNotMatch(body, /describeTenant\(\s*\{[^}]*\.\.\.s\b/);
    assert.match(body, /pick\("classSnipeEnabled"\)/, "fields are named individually");
  });

  it("and refuses a tenant value that is not an address", () => {
    const orch = readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
    assert.match(orch, /\^0x\[0-9a-f\]\{40\}\$/, "the env value is validated before any read");
    assert.match(orch, /refusing to guess/);
  });

  it("and runs once per process, not once per pass", () => {
    const orch = readFileSync(path.join(__dirname, "orchestrator.ts"), "utf8");
    assert.match(orch, /if \(tenantInspectRan\) return;/);
  });
});
