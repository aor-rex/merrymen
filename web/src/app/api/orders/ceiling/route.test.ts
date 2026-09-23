/**
 * THE CEILING THE CHIPS OFFER IS THE ONE THE ORDERS ROUTE ENFORCES.
 *
 * The chat's amount chips clamp to min(sealed per-trade cap, the chat-order
 * ceiling). They read that ceiling from /api/settings — the owner's value
 * over SETTINGS_DEFAULTS (25) — while the orders route falls back to
 * resolveConfig(): the web process's own settings file and its env,
 * MERRYMEN_TELEGRAM_MAX_ACTION_USDG. A house below 25 therefore offered a
 * "(max)" chip the route refused, hosted as well as self-hosted.
 *
 * This route answers with the same resolution POST applies (lib/order-ceiling),
 * and these tests run it: the real handler, real sessions, the real settings
 * store on disk, the real env.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { GET } from "./route";

const TENANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "MERRYMEN_SETTINGS_FILE", "MERRYMEN_TELEGRAM_MAX_ACTION_USDG", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-ceiling-"));
  process.env.MERRYMEN_HOME = dir;
  // No house settings file: the env and the defaults decide, as on a fresh box.
  process.env.MERRYMEN_SETTINGS_FILE = path.join(dir, "no-such-settings.json");
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
});
afterEach(() => {
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG;
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const ask = (tenant: `0x${string}` | null) =>
  GET(new Request("https://app.example.test/api/orders/ceiling", tenant ? { headers: { cookie: `mm_session=${mintSession(tenant)}` } } : {}));
const ceiling = async (tenant: `0x${string}` | null) => {
  const res = await ask(tenant);
  assert.equal(res.status, 200);
  return ((await res.json()) as { ceilingUsdg: unknown }).ceilingUsdg;
};

describe("the ceiling a chat order is held to", () => {
  it("SELF-HOSTED, A HOUSE ENV BELOW THE DEFAULT IS THE CEILING — not the 25 the settings screen shows", async () => {
    process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG = "10";
    assert.equal(await ceiling(null), 10);
    delete process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG;
    assert.equal(await ceiling(null), 25, "and the default when nothing overrides it");
  });

  it("HOSTED, THE TENANT'S OWN VALUE, else the house's — env included", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    process.env.MERRYMEN_TELEGRAM_MAX_ACTION_USDG = "10";
    await getSettingsStore().put(TENANT, { telegramMaxActionUsdg: 7 });
    assert.equal(await ceiling(TENANT), 7, "their own");
    assert.equal(await ceiling(OTHER), 10, "nothing stored: the house's, which the chips used to read as 25");
  });

  it("hosted and signed out, there is no ceiling to tell", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    assert.equal((await ask(null)).status, 401);
  });
});
