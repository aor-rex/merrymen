/**
 * The public identity of an agent — the thing a link points at and a follow
 * targets.
 *
 * The properties that matter here are all about PERMANENCE. A slug appears in
 * shared URLs and in every follow edge, so re-minting one silently orphans both,
 * and no error is raised anywhere: the old link simply 404s and the edge points
 * at nothing. So the tests below are mostly about what must NOT change.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-istore-"));
process.env.MERRYMEN_HOME = HOME;

const { FileIdentityStore, mintSlug, SLUG_RE, SLUG_LENGTH } = await import("./identity-store");

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* windows temp lock; disposable */
  }
});

const ALICE = "0x00000000000000000000000000000000000000a1" as const;
const BOB = "0x00000000000000000000000000000000000000b2" as const;
const ACCT_1 = "0x1111111111111111111111111111111111111111" as const;
const ACCT_2 = "0x2222222222222222222222222222222222222222" as const;

describe("the slug itself", () => {
  it("is 16 characters of Crockford base32, and never i l o or u", () => {
    // Read aloud or retyped from a screenshot, those four are the characters
    // that turn one agent into a different one.
    for (let i = 0; i < 2_000; i++) {
      const s = mintSlug();
      assert.equal(s.length, SLUG_LENGTH);
      assert.match(s, SLUG_RE);
      assert.doesNotMatch(s, /[ilou]/);
    }
  });

  it("does not collide", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i++) seen.add(mintSlug());
    assert.equal(seen.size, 20_000, "80 bits of randomness, no duplicates");
  });

  it("rejects a shape that is not a slug BEFORE any lookup", () => {
    // An unauthenticated caller can ask for any slug it likes. A regex is very
    // much cheaper than a query, and this is what keeps a flood of nonsense
    // slugs off the database entirely.
    for (const bad of ["", "short", "0x1234", "ABCDEFGHJKMNPQRS", "iiiiiiiiiiiiiiii", "a".repeat(17)]) {
      assert.doesNotMatch(bad, SLUG_RE, bad);
    }
  });
});

describe("FileIdentityStore", () => {
  const store = new FileIdentityStore();

  it("mints once and never again", async () => {
    // THE PROPERTY EVERYTHING ELSE DEPENDS ON. Published links and follow edges
    // both point at this value; changing it orphans them with no error anywhere.
    const first = await store.ensure(ALICE, ACCT_1);
    assert.match(first.slug, SLUG_RE);
    const again = await store.ensure(ALICE, ACCT_1);
    assert.equal(again.slug, first.slug);
  });

  it("A RE-GRANT KEEPS THE SLUG and remembers the old account", async () => {
    // The reason this is keyed on the tenant rather than the smart account. A
    // re-grant mints a new account; if the public id moved with it, every link
    // anybody had shared would break the moment an owner re-signed.
    const before = await store.get(ALICE);
    const after2 = await store.ensure(ALICE, ACCT_2);
    assert.equal(after2.slug, before!.slug, "the public id survived the re-grant");
    assert.deepEqual(after2.accounts, [ACCT_2, ACCT_1], "newest first, both kept");
  });

  it("gives different tenants different slugs", async () => {
    const a = await store.get(ALICE);
    const b = await store.ensure(BOB, ACCT_1);
    assert.notEqual(a!.slug, b.slug);
  });

  it("resolves a slug back to its accounts without the grant store", async () => {
    // A public page must never need the DEK. The account history lives here
    // precisely so slug -> ledger rows is answerable from a plaintext record.
    const a = await store.get(ALICE);
    const found = await store.bySlug(a!.slug);
    assert.equal(found!.tenant, ALICE);
    assert.ok(found!.accounts.includes(ACCT_2));
  });

  it("returns null for a slug nobody holds, and for a malformed one", async () => {
    assert.equal(await store.bySlug("0123456789abcdef"), null);
    assert.equal(await store.bySlug("not-a-slug"), null);
  });

  it("is stored plaintext, deliberately, and is still 0600", async () => {
    // Sealing it would mean a public page could not render without the key that
    // decrypts money. The file permissions are the protection here, not a DEK.
    const file = path.join(HOME, "agent-identity", `${ALICE}.json`);
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { slug: string };
    assert.match(parsed.slug, SLUG_RE, "readable without a key");
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
  });
});

describe("linking a social account", () => {
  const store = new FileIdentityStore();
  const CAROL = "0x00000000000000000000000000000000000000c3" as const;
  const DAVE = "0x00000000000000000000000000000000000000d4" as const;

  it("binds a DID to a tenant", async () => {
    await store.ensure(CAROL, ACCT_1);
    assert.equal(
      await store.linkSocial(CAROL, {
        did: "did:privy:carol",
        provider: "twitter",
        subject: "998877",
        handle: "carol",
      }),
      true,
    );
    const back = await store.byDid("did:privy:carol");
    assert.equal(back!.tenant, CAROL);
  });

  it("FIRST CLAIM WINS — a DID cannot be moved to another tenant", async () => {
    // Otherwise signing in with somebody else's X account would hand you their
    // agent. Structurally the same guard the grant intake uses on a smart
    // account, and it fails in the same direction: closed.
    await store.ensure(DAVE, ACCT_2);
    assert.equal(
      await store.linkSocial(DAVE, {
        did: "did:privy:carol",
        provider: "twitter",
        subject: "998877",
      }),
      false,
    );
    const back = await store.byDid("did:privy:carol");
    assert.equal(back!.tenant, CAROL, "still Carol's");
  });

  it("re-linking the same pair is a no-op, not a failure", async () => {
    assert.equal(
      await store.linkSocial(CAROL, {
        did: "did:privy:carol",
        provider: "twitter",
        subject: "998877",
        handle: "carol_renamed",
      }),
      true,
    );
    const r = await store.get(CAROL);
    assert.equal(r!.social!.handle, "carol_renamed", "the handle is a projection and may move");
    assert.equal(r!.social!.subject, "998877", "the identity is the subject, and did not");
  });

  it("linking never touches the slug", async () => {
    const r = await store.get(CAROL);
    const before = r!.slug;
    await store.linkSocial(CAROL, {
      did: "did:privy:carol",
      provider: "google",
      subject: "998877",
    });
    assert.equal((await store.get(CAROL))!.slug, before);
  });
});
