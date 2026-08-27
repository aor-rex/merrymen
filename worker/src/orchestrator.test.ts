/**
 * Orchestrator env curation — the security-critical part a unit test can pin.
 *
 * A child worker holds one tenant's SESSION key. It must inherit the platform's
 * HOUSE keys (bundler/LLM) — that is hosted-mode's whole design — but never the
 * material that would let it decrypt OTHER tenants' stored keys (the store DEK),
 * forge any session (the signing secret), or reach the shared grant database
 * (the URL). This proves the strip keeps the first and drops the second.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";

process.env.MERRYMEN_HOME = path.join(process.cwd(), ".test-orch-home");
process.env.MERRYMEN_HOSTED = "1";
process.env.MERRYMEN_BUNDLER_API_KEY = "house-bundler-key";
process.env.GROQ_API_KEY = "house-groq-key";
process.env.MERRYMEN_STORE_DEK = "SECRET-dek-never-to-a-child";
process.env.MERRYMEN_SESSION_SECRET = "SECRET-session-never-to-a-child";
process.env.DATABASE_URL = "postgres://SECRET-never-to-a-child";

const { childHome, childEnv, fleetHaltFile } = await import("./orchestrator");

const T = "0xABCDef0000000000000000000000000000000001" as const;

describe("orchestrator env curation", () => {
  it("childHome is per-tenant, lowercased, under children/", () => {
    assert.equal(childHome(T), path.join(process.env.MERRYMEN_HOME!, "children", T.toLowerCase()));
  });

  it("childEnv injects the house keys but STRIPS the orchestrator-only secrets", () => {
    const env = childEnv(T);
    // house keys — injected on purpose (house-keys-server-only)
    assert.equal(env.MERRYMEN_BUNDLER_API_KEY, "house-bundler-key");
    assert.equal(env.GROQ_API_KEY, "house-groq-key");
    // per-child steering
    assert.equal(env.MERRYMEN_HOSTED, "1");
    assert.equal(env.MERRYMEN_HOME, childHome(T));
    // the three a child must NEVER see
    assert.equal(env.MERRYMEN_STORE_DEK, undefined, "the DEK decrypts every tenant's key");
    assert.equal(env.MERRYMEN_SESSION_SECRET, undefined, "the secret forges any session");
    assert.equal(env.DATABASE_URL, undefined, "the url reaches every tenant's grant");
  });

  it("fleetHaltFile sits under the orchestrator home", () => {
    assert.equal(fleetHaltFile(), path.join(process.env.MERRYMEN_HOME!, "FLEET_HALT"));
  });
});
