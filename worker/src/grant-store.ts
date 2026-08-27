/**
 * The per-tenant grant store — where a hosted deploy keeps each tenant's signed
 * grant, durably and in isolation.
 *
 * Self-hosted keeps its single grant.json file and never touches this. Hosted
 * needs three things this provides: (1) MANY grants, one per tenant, not a
 * single slot; (2) DURABILITY across a redeploy — Railway's container
 * filesystem is ephemeral, and a lost grant strands a funded account; (3)
 * ENCRYPTION at rest of the session key. Web (the write side) and the
 * orchestrator (the read side) share this one module so they cannot disagree
 * about the shape.
 *
 * TENANT = the owner address, lowercased — the SIWE-authenticated wallet. A
 * grant is always stored under grant.owner, and callers pass the authenticated
 * tenant so the store can refuse a mismatch: the store is the last place the
 * "this grant belongs to this wallet" invariant can be enforced before bytes
 * hit disk.
 *
 * TWO BACKENDS, selected by DATABASE_URL:
 *  - Postgres (hosted, multi-service): web and the orchestrator are separate
 *    Railway services that cannot share a volume, so the shared store is a
 *    network database. Selected when DATABASE_URL is set.
 *  - File (self-hosted, single-service, tests): one file per tenant under a
 *    directory, session key sealed when a DEK is present. The default.
 *
 * NODE-ONLY (node:crypto, node:fs, pg). Imported by web API routes (node
 * runtime) and the worker via the @merrymen/grant-store alias — never by the
 * browser bundle, which is why it lives here and not in core's browser barrel.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { merrymenHome } from "./home";
import { carriesOwnerKey } from "../../packages/core/src/index";
import { openSecret, requireDek, sealSecret, storeDek } from "./store-crypto";
import type { StoredGrant } from "../../packages/core/src/index";

/** A grant safe to persist server-side: session-key-only, session key sealed. */
export interface StoredRecord {
  tenant: `0x${string}`;
  chainId: number;
  /** The grant, session key REMOVED (it lives sealed, separately). */
  grant: Omit<StoredGrant, "demoSessionPrivateKey" | "demoOwnerPrivateKey">;
  /** The session key, AES-256-GCM sealed when a DEK is set, else plaintext. */
  sealedSessionKey: string;
  updatedAt: number;
}

export interface GrantStore {
  /** Persist (or replace) a tenant's grant. Throws on an owner key or a tenant mismatch. */
  put(tenant: `0x${string}`, grant: StoredGrant): Promise<void>;
  /** The tenant's grant, session key decrypted back in, or null. */
  get(tenant: `0x${string}`): Promise<StoredGrant | null>;
  /** Every tenant with a grant — for the orchestrator to lease and arm. */
  listTenants(): Promise<`0x${string}`[]>;
  /** Forget a tenant's grant (the kill switch). */
  remove(tenant: `0x${string}`): Promise<void>;
}

/** Split a full grant into a persistable record, refusing anything with an owner key. */
function toRecord(tenant: `0x${string}`, grant: StoredGrant): StoredRecord {
  if (carriesOwnerKey(grant)) {
    throw new Error("refusing to store a grant that carries an owner key");
  }
  if (typeof grant.owner !== "string" || grant.owner.toLowerCase() !== tenant) {
    throw new Error(`grant.owner (${grant.owner}) does not match tenant (${tenant})`);
  }
  const { demoSessionPrivateKey, demoOwnerPrivateKey, ...rest } = grant as StoredGrant & {
    demoOwnerPrivateKey?: string;
  };
  void demoOwnerPrivateKey; // discarded; the guard above already refused a real one
  const dek = storeDek();
  const sealedSessionKey = dek ? sealSecret(demoSessionPrivateKey, dek) : demoSessionPrivateKey;
  return {
    tenant,
    chainId: grant.chainId,
    grant: rest,
    sealedSessionKey,
    updatedAt: Math.floor(Date.now() / 1000),
  };
}

/** Reassemble a full grant, decrypting the session key back in. */
function fromRecord(rec: StoredRecord): StoredGrant {
  const dek = storeDek();
  const sessionKey = dek ? openSecret(rec.sealedSessionKey, dek) : rec.sealedSessionKey;
  return { ...rec.grant, demoSessionPrivateKey: sessionKey as `0x${string}` } as StoredGrant;
}

// ── file backend ─────────────────────────────────────────────────────────────

/**
 * One JSON record per tenant under <home>/tenants/. Used self-hosted, in tests,
 * and for a single-service hosted deploy on a persistent volume. The session
 * key is sealed on disk when a DEK is present — verified by test: the file must
 * not contain the plaintext key.
 */
export class FileGrantStore implements GrantStore {
  private dir = path.join(merrymenHome(), "tenants");
  private file(tenant: string) {
    return path.join(this.dir, `${tenant.toLowerCase()}.json`);
  }
  async put(tenant: `0x${string}`, grant: StoredGrant): Promise<void> {
    const rec = toRecord(tenant, grant);
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(tenant), JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  async get(tenant: `0x${string}`): Promise<StoredGrant | null> {
    try {
      const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredRecord;
      return fromRecord(rec);
    } catch {
      return null;
    }
  }
  async listTenants(): Promise<`0x${string}`[]> {
    try {
      const files = await readdir(this.dir);
      return files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5) as `0x${string}`);
    } catch {
      return [];
    }
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    await rm(this.file(tenant), { force: true });
  }
}

// ── postgres backend ─────────────────────────────────────────────────────────

/** The slice of a pg client this store uses. Kept minimal so `pg` is a runtime-only dep. */
interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Postgres backend for the multi-service hosted deploy, where web and the
 * orchestrator are separate Railway services sharing a network database.
 *
 * `pg` is imported at RUNTIME only (dynamic import), so it is not a compile-time
 * dependency and the file backend needs it neither installed nor typed. The DEK
 * is REQUIRED here — a hosted server storing session keys in the clear is
 * exactly what encryption-at-rest exists to prevent — so the constructor path
 * asserts it.
 *
 * INTEGRATION-TEST GATE: the SQL below is typechecked but not exercised in this
 * repo's test run (no live Postgres). Per docs/hosted-platform-plan.md it must
 * pass a live-Postgres round-trip before any deploy that funds a real account.
 */
export class PgGrantStore implements GrantStore {
  private ready: Promise<PgClientLike> | null = null;
  constructor(private url: string) {
    requireDek(); // fail fast: hosted Postgres without a DEK is a plaintext-at-rest bug
  }
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      this.ready = (async () => {
        // pg is a RUNTIME-only dependency (installed on the hosted deploy, not
        // in this repo). The webpackIgnore comment stops Next's bundler from
        // trying to resolve it at build — the file backend must build with pg
        // absent — and it is loaded only here, only when DATABASE_URL selected
        // this backend. The Postgres path is gated on a live integration test
        // before any deploy (docs/hosted-platform-plan.md).
        // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
        const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
          Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void> };
        };
        const c = new pg.Client({ connectionString: this.url });
        await c.connect();
        await c.query(
          `CREATE TABLE IF NOT EXISTS grants (
             tenant TEXT PRIMARY KEY,
             chain_id INTEGER NOT NULL,
             grant_json JSONB NOT NULL,
             sealed_session_key TEXT NOT NULL,
             updated_at BIGINT NOT NULL
           )`,
        );
        return c;
      })();
    }
    return this.ready;
  }
  async put(tenant: `0x${string}`, grant: StoredGrant): Promise<void> {
    const rec = toRecord(tenant, grant);
    const c = await this.client();
    await c.query(
      `INSERT INTO grants (tenant, chain_id, grant_json, sealed_session_key, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant) DO UPDATE SET
         chain_id = EXCLUDED.chain_id, grant_json = EXCLUDED.grant_json,
         sealed_session_key = EXCLUDED.sealed_session_key, updated_at = EXCLUDED.updated_at`,
      [rec.tenant, rec.chainId, JSON.stringify(rec.grant), rec.sealedSessionKey, rec.updatedAt],
    );
  }
  async get(tenant: `0x${string}`): Promise<StoredGrant | null> {
    const c = await this.client();
    const { rows } = await c.query(
      `SELECT tenant, chain_id, grant_json, sealed_session_key, updated_at FROM grants WHERE tenant = $1`,
      [tenant.toLowerCase()],
    );
    const row = rows[0];
    if (!row) return null;
    const rec: StoredRecord = {
      tenant: String(row.tenant) as `0x${string}`,
      chainId: Number(row.chain_id),
      grant: (typeof row.grant_json === "string" ? JSON.parse(row.grant_json) : row.grant_json) as StoredRecord["grant"],
      sealedSessionKey: String(row.sealed_session_key),
      updatedAt: Number(row.updated_at),
    };
    return fromRecord(rec);
  }
  async listTenants(): Promise<`0x${string}`[]> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT tenant FROM grants`);
    return rows.map((r) => String(r.tenant) as `0x${string}`);
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM grants WHERE tenant = $1`, [tenant.toLowerCase()]);
  }
}

/** The store this deploy uses: Postgres when DATABASE_URL is set, else the file backend. */
let cached: GrantStore | null = null;
export function getGrantStore(): GrantStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgGrantStore(url) : new FileGrantStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetGrantStoreForTest(): void {
  cached = null;
}
