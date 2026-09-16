/**
 * THE TWO CREDENTIAL SYSTEMS MUST NOT ACCEPT EACH OTHER'S KEYS.
 *
 * `mmk_` (holder) and `mmp_` (partner) live on one host and share exactly one
 * thing: the rate-limit store. They have different registries, different
 * verifiers, different scopes and different error envelopes. The failure this
 * file exists to catch is the plausible one — somebody later "unifies" the auth
 * helper and a holder token silently becomes a partner key, or the reverse.
 *
 * Both directions are asserted explicitly, because only one of them is obvious.
 *
 * `node --test partner-cross.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = await mkdtemp(path.join(tmpdir(), "merrymen-cross-"));
process.env.MERRYMEN_DATA_DIR = dir;
delete process.env.MERRYMEN_PARTNER_KEYS;

const { createPartners, hashSecret, makeKey, writeRecord } = await import("./lib/partners.mjs");
const { createPartnerApi } = await import("./lib/partner-api.mjs");
const { createGateway } = await import("./lib/core.mjs");

const SECRET = "y".repeat(40);

/** Counts hits so a test can prove metering never ran for a refused caller. */
function fakeStore() {
  const hits = [];
  return {
    hits,
    durable: false,
    async rateHit(key) {
      hits.push(key);
      return true;
    },
    async spendNonce() {
      return true;
    },
    async getBal() {
      return true; // "is a holder" — so any refusal below is about the TOKEN
    },
    async setBal() {},
  };
}

async function partnerKey(scopes = ["read:agents"]) {
  const { key, keyId, secret } = makeKey();
  await writeRecord({ keyId, name: "prism", hash: hashSecret(SECRET, secret), scopes, status: "active" });
  return key;
}

/** A real holder token, minted by the real gateway. */
function holderGateway(store) {
  return createGateway({
    secret: SECRET,
    upstreamUrl: "http://127.0.0.1:1/never",
    upstreamKey: "unused",
    model: "m",
    domain: "merrymen.dev",
    minTokens: 1n,
    tokenAddress: "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32",
    publicClient: { readContract: async () => 10n ** 30n },
    store,
  });
}

test("a HOLDER token is refused by every partner route", async () => {
  const store = fakeStore();
  const gw = holderGateway(store);
  // A GENUINE mmk_, minted by the real issuer against the SAME secret. That
  // shared secret is precisely what would make a naive "unify the auth helper"
  // change appear to work, so the test has to use a token that really verifies
  // on the holder side — a fabricated one would only prove garbage is rejected.
  const holderToken = gw._tokens.issueToken("0x" + "1".repeat(40));
  assert.equal(gw._tokens.verifyToken(holderToken), "0x" + "1".repeat(40), "precondition: a real holder token");

  const api = createPartnerApi({ partners: createPartners({ secret: SECRET }), store });
  for (const route of ["/partner/v1/meta", "/partner/v1/agents", "/partner/v1/nope"]) {
    const r = await api.handle({ method: "GET", pathname: route, authorization: `Bearer ${holderToken}`, ip: "1.2.3.4" });
    assert.equal(r.status, 404, `${route} accepted a holder token`);
    assert.equal(r.json.error.code, "not_found");
  }
  // And it never reached the meter — otherwise anyone could burn a partner's
  // quota by presenting someone else's identifier.
  assert.deepEqual(store.hits, [], "a refused credential must not consume quota");
});

test("a PARTNER key is refused by the holder verifier and by the chat route", async () => {
  const store = fakeStore();
  const gw = holderGateway(store);
  const key = await partnerKey();

  // At the primitive, not just at the route: verifyToken is what any future
  // refactor would reach for, so pin it directly.
  assert.equal(gw._tokens.verifyToken(key), null, "the holder verifier accepted a partner key");

  const r = await gw.chat({ token: key, body: { messages: [{ role: "user", content: "hi" }] }, ip: "1.2.3.4" });
  assert.equal(r.status, 401, "the LLM route accepted a partner key");
});

test("a PARTNER key is refused by the holder bitquery route", async () => {
  const store = fakeStore();
  const gw = createGateway({
    secret: SECRET,
    bitqueryKey: "present-so-the-route-is-enabled",
    upstreamUrl: "http://127.0.0.1:1/never",
    upstreamKey: "unused",
    model: "m",
    domain: "merrymen.dev",
    minTokens: 1n,
    tokenAddress: "0xa15cd06dd305269a0f48bebeb30aa3588fba7b32",
    publicClient: { readContract: async () => 10n ** 30n },
    store,
  });
  const key = await partnerKey();
  const r = await gw.bitquery({ token: key, body: { query: "launches" }, ip: "1.2.3.4" });
  assert.equal(r.status, 401, "the discovery route accepted a partner key");
});

test("the partner health check is public, and reveals nothing about keys", async () => {
  const api = createPartnerApi({ partners: createPartners({ secret: SECRET }), store: fakeStore() });
  const r = await api.handle({ method: "GET", pathname: "/partner/v1/health", authorization: undefined, ip: "1.2.3.4" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(JSON.stringify(r.json).includes("mmp_"), false);
});

test("a valid partner key gets its own metadata, and scope is enforced", async () => {
  const store = fakeStore();
  const key = await partnerKey(["read:agents"]);
  const api = createPartnerApi({ partners: createPartners({ secret: SECRET }), store });

  const meta = await api.handle({ method: "GET", pathname: "/partner/v1/meta", authorization: `Bearer ${key}`, ip: "1.2.3.4" });
  assert.equal(meta.status, 200);
  assert.deepEqual(meta.json.scopes, ["read:agents"]);
  // The secret must never come back out of any response.
  assert.equal(JSON.stringify(meta.json).includes(key.split("_")[2]), false);
  assert.ok(store.hits.some((h) => h.startsWith("p:")), "an authenticated call should meter");
});

test("partner routes are not matched under the OpenAI prefix", async () => {
  const api = createPartnerApi({ partners: createPartners({ secret: SECRET }), store: fakeStore() });
  assert.equal(api.owns("/v1/meta"), false);
  assert.equal(api.owns("/v1/chat/completions"), false);
  assert.equal(api.owns("/partner/v1/meta"), true);
  assert.equal(await api.handle({ method: "GET", pathname: "/v1/models", ip: "x" }), null);
});
