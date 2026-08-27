/**
 * The per-tenant grant store — durable, isolated, and encrypted at rest.
 *
 * Proven against a real temp filesystem: two tenants never see each other's
 * grant, the session key on disk is CIPHERTEXT not plaintext, a grant carrying
 * an owner key is refused, and a grant whose owner isn't the tenant is refused.
 * Each of those is a fund-safety property, so each gets its own assertion.
 *
 * MERRYMEN_HOME is set before the store resolves its dir; node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-gstore-"));
process.env.MERRYMEN_HOME = HOME;
// A 32-byte base64 DEK so the file backend seals the session key at rest.
process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 7).toString("base64");

const { FileGrantStore } = await import("./grant-store");
const { sealSecret, openSecret } = await import("./store-crypto");

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* windows temp lock; disposable */
  }
});

const SESSION = ("0x" + "cd".repeat(32)) as `0x${string}`;
const grantFor = (owner: string): never =>
  ({
    smartAccount: "0x00000000000000000000000000000000000000a1",
    owner,
    serialized: "eyJ-a-zerodev-blob",
    chainId: 4663,
    grantFeatures: ["tradeable-v2"],
    grantTokens: [],
    demoSessionPrivateKey: SESSION,
  }) as never;

describe("store-crypto", () => {
  const dek = Buffer.alloc(32, 9);
  it("seals and opens a round trip", () => {
    const sealed = sealSecret(SESSION, dek);
    assert.notEqual(sealed, SESSION, "the sealed form is not the plaintext");
    assert.equal(openSecret(sealed, dek), SESSION);
  });
  it("a tampered ciphertext THROWS rather than returns a mangled key", () => {
    const sealed = sealSecret(SESSION, dek);
    const [iv, tag, ct] = sealed.split(".") as [string, string, string];
    const flipped = `${iv}.${tag}.${ct.slice(0, -2)}00`;
    assert.throws(() => openSecret(flipped, dek), "a signed UserOp must never be built from a mangled key");
  });
  it("the wrong key throws, not silently wrong output", () => {
    const sealed = sealSecret(SESSION, dek);
    assert.throws(() => openSecret(sealed, Buffer.alloc(32, 1)));
  });
});

describe("FileGrantStore", () => {
  const store = new FileGrantStore();
  const ALICE = "0x00000000000000000000000000000000000000a1" as const;
  const BOB = "0x00000000000000000000000000000000000000b2" as const;

  it("stores and returns a tenant's grant, session key intact", async () => {
    await store.put(ALICE, grantFor(ALICE));
    const g = await store.get(ALICE);
    assert.ok(g);
    assert.equal(g!.demoSessionPrivateKey, SESSION, "the session key round-trips through encryption");
    assert.equal(g!.owner, ALICE);
  });

  it("ENCRYPTS the session key at rest — the file must not contain the plaintext", async () => {
    await store.put(ALICE, grantFor(ALICE));
    const raw = readFileSync(path.join(HOME, "tenants", `${ALICE}.json`), "utf8");
    assert.ok(!raw.includes(SESSION), "the plaintext session key must never touch disk");
    assert.ok(raw.includes("sealedSessionKey"), "…it is stored sealed");
  });

  it("isolates tenants — one never sees another's grant", async () => {
    await store.put(ALICE, grantFor(ALICE));
    await store.put(BOB, grantFor(BOB));
    assert.equal((await store.get(ALICE))!.owner, ALICE);
    assert.equal((await store.get(BOB))!.owner, BOB);
    const tenants = (await store.listTenants()).sort();
    assert.deepEqual(tenants, [ALICE, BOB].sort());
  });

  it("REFUSES a grant carrying an owner key — defence in depth behind the route", async () => {
    await assert.rejects(
      () => store.put(ALICE, { ...(grantFor(ALICE) as object), demoOwnerPrivateKey: "0x" + "ab".repeat(32) } as never),
      /owner key/,
    );
  });

  it("REFUSES a grant whose owner is not the tenant — no cross-tenant install", async () => {
    await assert.rejects(() => store.put(ALICE, grantFor(BOB)), /does not match tenant/);
  });

  it("remove forgets exactly one tenant", async () => {
    await store.put(ALICE, grantFor(ALICE));
    await store.put(BOB, grantFor(BOB));
    await store.remove(ALICE);
    assert.equal(await store.get(ALICE), null);
    assert.ok(await store.get(BOB), "removing Alice leaves Bob");
  });

  it("get on an unknown tenant is null, never a throw", async () => {
    assert.equal(await store.get("0x00000000000000000000000000000000000000ff"), null);
  });
});
