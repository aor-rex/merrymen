/**
 * THE CUSTODY GUARD — the one check that stands between a hosted server and
 * becoming custodian of every tenant's fund-custody key.
 *
 * Pass this incorrectly and one database dump drains everyone, so it is tested
 * for what a real attacker or a careless client actually sends: the named
 * field, a renamed field, a raw key nested anywhere, a mnemonic — and it must
 * NOT trip on the session key, which the worker legitimately needs.
 *
 * carriesOwnerKey lives in packages/core so the grant API and the boot check
 * share one definition; this exercises it directly.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assertNoOwnerKeysAtRest, carriesOwnerKey } from "../../packages/core/src/index";

const KEY = "0x" + "ab".repeat(32); // a 32-byte private key
const sessionOnlyGrant = {
  smartAccount: "0x00000000000000000000000000000000000000a1",
  owner: "0x00000000000000000000000000000000000000b1",
  serialized: "eyJ...a-long-zerodev-blob...",
  chainId: 4663,
  grantFeatures: ["tradeable-v2"],
  grantTokens: ["0x00000000000000000000000000000000000000c1"],
  demoSessionPrivateKey: "0x" + "cd".repeat(32), // the worker needs this — NOT custody
};

test("a session-key-only grant is clean — the shape the hosted signer produces", () => {
  assert.equal(carriesOwnerKey(sessionOnlyGrant), false);
});

test("the named owner-key field is caught", () => {
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, demoOwnerPrivateKey: KEY }), true);
});

test("a RENAMED field hiding a raw 32-byte key is still caught", () => {
  // A future bug or a hostile client could call it anything.
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, ownerBackup: KEY }), true);
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, sudo: KEY.slice(2) }), true, "no 0x prefix, still a key");
});

test("a key nested deep in the payload is caught", () => {
  assert.equal(carriesOwnerKey({ ...sessionOnlyGrant, meta: { backup: { k: KEY } } }), true);
});

test("a mnemonic is caught — the other shape of an owner key", () => {
  const grant = { ...sessionOnlyGrant, phrase: "legal winner thank year wave sausage worth useful legal winner thank yellow" };
  assert.equal(carriesOwnerKey(grant), true);
});

test("the session key ALONE never trips the guard — the worker legitimately holds it", () => {
  // This is the false-positive that would break every hosted grant. The
  // session key is a 64-hex value too, so the guard must exempt its field.
  assert.equal(carriesOwnerKey(sessionOnlyGrant), false);
  assert.equal(carriesOwnerKey({ demoSessionPrivateKey: KEY }), false);
});

test("null / non-object / empty are clean, never a throw", () => {
  for (const x of [null, undefined, "", 42, [], {}]) assert.equal(carriesOwnerKey(x), false);
});

test("assertNoOwnerKeysAtRest is inert when hosted mode is off", () => {
  delete process.env.MERRYMEN_HOSTED;
  // Even a dirty grant does not throw when self-hosted — the owner key on disk
  // is the user's own, on their own machine.
  assert.doesNotThrow(() => assertNoOwnerKeysAtRest([{ ...sessionOnlyGrant, demoOwnerPrivateKey: KEY }]));
});

test("assertNoOwnerKeysAtRest REFUSES to boot in hosted mode on a dirty grant", () => {
  process.env.MERRYMEN_HOSTED = "1";
  try {
    assert.doesNotThrow(() => assertNoOwnerKeysAtRest([sessionOnlyGrant, sessionOnlyGrant]), "clean grants boot");
    assert.throws(
      () => assertNoOwnerKeysAtRest([sessionOnlyGrant, { ...sessionOnlyGrant, demoOwnerPrivateKey: KEY }]),
      /refuses to start/,
      "one dirty grant halts the whole boot",
    );
  } finally {
    delete process.env.MERRYMEN_HOSTED;
  }
});
