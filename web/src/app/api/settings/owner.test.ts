/**
 * A SETTING CHANGED FROM THE CHAT IS CHANGED FOR THE OWNER WHO CONFIRMED IT, OR NOT AT ALL.
 *
 * The order and the snipe already name the owner who tapped (orders/owner.test.ts),
 * because another tab can sign a different wallet in without the tab that
 * tapped ever knowing. A settings card did not: a "go live" card in A's thread,
 * tapped after B signed in on another tab, went out under B's cookie with
 * nobody named, this route turned B's agent live, and A's thread said "Done".
 * The card now names its owner, and these run the real PUT: a session that is
 * not that owner's changes nothing, and `owner` is never a setting.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";

const TENANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let PUT: (req: Request) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-owner-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  // After the env: the route resolves its settings path when it loads.
  ({ PUT } = await import("./route"));
});
afterEach(() => {
  delete process.env.MERRYMEN_HOSTED;
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** PUT /api/settings under `session`, as the chat's card sends it. */
async function put(session: `0x${string}` | null, body: Record<string, unknown>) {
  const res = await PUT(
    new Request("https://app.example.test/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json", ...(session ? { cookie: `mm_session=${mintSession(session)}` } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[]; ignored?: string[] } };
}

describe("PUT /api/settings from a chat card", () => {
  it("HOSTED, A SESSION THAT IS NOT THE OWNER WHO CONFIRMED CHANGES NOTHING — and says why", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const other = await put(OTHER, { liveTradingEnabled: true, owner: TENANT });
    assert.equal(other.status, 409);
    assert.match(other.body.errors?.join(" ") ?? "", /different wallet now than the one that confirmed this, so nothing was changed/);
    assert.equal(await getSettingsStore().get(OTHER), null, "the other wallet's agent was not turned live");
    // Before validation: a refusal about a field would be about a change that
    // was never the other wallet's to make.
    assert.equal((await put(OTHER, { buyPerTickUsdg: -5, owner: TENANT })).status, 409);
    assert.equal((await put(OTHER, { liveTradingEnabled: true, owner: 42 })).status, 409, "a claim that is not an address is nobody's");
    assert.equal(await getSettingsStore().get(OTHER), null);
  });

  it("the owner who confirmed is saved as before, however the address is cased — and `owner` is not a setting", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    for (const owner of [TENANT, TENANT.toUpperCase().replace("0X", "0x")]) {
      const own = await put(TENANT, { liveTradingEnabled: true, owner });
      assert.equal(own.status, 200, JSON.stringify(own.body));
      assert.equal(own.body.ignored, undefined, "not reported as an unknown key");
      const stored = (await getSettingsStore().get(TENANT)) as Record<string, unknown>;
      assert.equal(stored.liveTradingEnabled, true);
      assert.equal("owner" in stored, false, "and never stored");
    }
  });

  it("a save that names nobody is judged by its session, as before", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const own = await put(TENANT, { liveTradingEnabled: false });
    assert.equal(own.status, 200, JSON.stringify(own.body));
    assert.equal((await getSettingsStore().get(TENANT))?.liveTradingEnabled, false);
    assert.equal((await put(null, { liveTradingEnabled: true, owner: TENANT })).status, 401, "signed out is still signed out");
  });

  it("self-hosted there is no sign-in to hold it against, and the change is saved without it", async () => {
    const file = path.join(dir, "settings.json");
    writeFileSync(file, JSON.stringify({}));
    const res = await put(null, { liveTradingEnabled: true, owner: TENANT });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ignored, undefined);
    const stored = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    assert.equal(stored.liveTradingEnabled, true);
    assert.equal("owner" in stored, false);
  });
});
