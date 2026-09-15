/**
 * The per-tenant SETTINGS store — a hosted tenant's own configuration (strategy,
 * basket, custom tokens, their Telegram bot, sizing knobs).
 *
 * Self-hosted keeps its single settings.json and never touches this. Hosted needs
 * MANY settings, one per tenant, durable across a redeploy, and reachable from
 * two services: the web app WRITES it (the settings page), the orchestrator READS
 * it and hands each child worker a settings.json. Grant and settings are separate
 * stores because they have different shapes and lifecycles — but they share the
 * same backend selection and the same at-rest sealing, so a tenant's bot token
 * never sits in the clear beside the ciphertext.
 *
 * What reaches this store is ALREADY clean: the settings API strips every
 * house-key and remote-execution field (HOSTED_FORBIDDEN_SETTING_FIELDS) before
 * writing, so a stored blob carries only what a tenant may legitimately own. The
 * whole blob is sealed anyway (it can hold telegramBotToken, a secret), under the
 * same DEK the grant store uses — held by web + orchestrator, never by a child.
 *
 * NODE-ONLY (node:crypto, node:fs, pg). Imported by the web API and the worker,
 * never the browser bundle.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { merrymenHome } from "./home";
import { openSecret, requireDek, sealSecret, storeDek } from "./store-crypto";
import type { MerrymenSettings } from "../../packages/core/src/index";

export interface SettingsStore {
  /** Persist (replace) a tenant's settings. */
  put(tenant: `0x${string}`, settings: MerrymenSettings): Promise<void>;
  /** A tenant's settings, or null if none stored. */
  get(tenant: `0x${string}`): Promise<MerrymenSettings | null>;
  /** Every tenant that has stored settings. */
  listTenants(): Promise<`0x${string}`[]>;
  /** Forget a tenant's settings (on kill). */
  remove(tenant: `0x${string}`): Promise<void>;
}

/** Seal the settings JSON when a DEK is present, else store it plaintext. */
function seal(settings: MerrymenSettings): string {
  const json = JSON.stringify(settings);
  const dek = storeDek();
  return dek ? sealSecret(json, dek) : json;
}

/** Reverse of seal — unseal if it looks sealed (iv.tag.ct), else parse plaintext. */
function unseal(blob: string): MerrymenSettings {
  const dek = storeDek();
  // A sealed blob is exactly three base64url parts; anything else is plaintext
  // JSON (self-hosted / no DEK), which starts with '{'.
  const looksSealed = dek && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(blob);
  const json = looksSealed ? openSecret(blob, dek) : blob;
  return JSON.parse(json) as MerrymenSettings;
}

interface StoredSettingsRecord {
  tenant: `0x${string}`;
  sealed: string;
  updatedAt: number;
}

// ── file backend ─────────────────────────────────────────────────────────────

export class FileSettingsStore implements SettingsStore {
  private dir = path.join(merrymenHome(), "tenant-settings");
  private file(tenant: string) {
    return path.join(this.dir, `${tenant.toLowerCase()}.json`);
  }
  async put(tenant: `0x${string}`, settings: MerrymenSettings): Promise<void> {
    const rec: StoredSettingsRecord = { tenant, sealed: seal(settings), updatedAt: Math.floor(Date.now() / 1000) };
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(tenant), JSON.stringify(rec, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  async get(tenant: `0x${string}`): Promise<MerrymenSettings | null> {
    try {
      const rec = JSON.parse(await readFile(this.file(tenant), "utf8")) as StoredSettingsRecord;
      return unseal(rec.sealed);
    } catch {
      return null;
    }
  }
  async listTenants(): Promise<`0x${string}`[]> {
    try {
      return (await readdir(this.dir)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5) as `0x${string}`);
    } catch {
      return [];
    }
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    await rm(this.file(tenant), { force: true });
  }
}

// ── postgres backend ─────────────────────────────────────────────────────────

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Postgres backend for the multi-service hosted deploy. `pg` is imported at
 * RUNTIME only (webpackIgnore) so the file backend builds with it absent; the DEK
 * is required, exactly as PgGrantStore. Gated on a live-Postgres integration test
 * before any funding deploy (docs/hosted-platform-plan.md).
 */
export class PgSettingsStore implements SettingsStore {
  private ready: Promise<PgClientLike> | null = null;
  constructor(private url: string) {
    requireDek();
  }
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      this.ready = (async () => {
        // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
        const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
          Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void> };
        };
        const c = new pg.Client({ connectionString: this.url });
        await c.connect();
        await c.query(
          `CREATE TABLE IF NOT EXISTS tenant_settings (
             tenant TEXT PRIMARY KEY,
             sealed TEXT NOT NULL,
             updated_at BIGINT NOT NULL
           )`,
        );
        return c;
      })();
    }
    return this.ready;
  }
  async put(tenant: `0x${string}`, settings: MerrymenSettings): Promise<void> {
    const c = await this.client();
    await c.query(
      `INSERT INTO tenant_settings (tenant, sealed, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (tenant) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = EXCLUDED.updated_at`,
      [tenant.toLowerCase(), seal(settings), Math.floor(Date.now() / 1000)],
    );
  }
  async get(tenant: `0x${string}`): Promise<MerrymenSettings | null> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT sealed FROM tenant_settings WHERE tenant = $1`, [tenant.toLowerCase()]);
    return rows[0] ? unseal(String(rows[0].sealed)) : null;
  }
  async listTenants(): Promise<`0x${string}`[]> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT tenant FROM tenant_settings`);
    return rows.map((r) => String(r.tenant) as `0x${string}`);
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM tenant_settings WHERE tenant = $1`, [tenant.toLowerCase()]);
  }
}

let cached: SettingsStore | null = null;
export function getSettingsStore(): SettingsStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgSettingsStore(url) : new FileSettingsStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetSettingsStoreForTest(): void {
  cached = null;
}
