/**
 * Per-tenant Postgres advisory lease — the guarantee that at most ONE
 * orchestrator replica arms a given tenant at a time.
 *
 * THE HOLE IT CLOSES. The orchestrator forks one worker child per tenant. Run
 * two orchestrator replicas — which Railway does the moment the service scales
 * past one — and both read the same grant store, both fork a child for the same
 * tenant, and both trade that tenant's ONE session key against that tenant's ONE
 * daily cap. Each child counts only its own spend (the counters live in its
 * process, seeded from the ledger at arm), so the account can spend up to N×
 * the ceiling with N replicas. The wall still bounds per-op value, but the daily
 * budget — the thing that says "risk at most this much of my money per day" —
 * silently multiplies. That is the multi-replica correctness hole the plan flags
 * as a real-funds blocker.
 *
 * WHY AN ADVISORY LOCK. A Postgres SESSION-level advisory lock is a cross-process
 * mutex whose lifetime is exactly the connection that took it. Replica B's
 * pg_try_advisory_lock returns false while replica A holds it, so B refuses to
 * arm. And when A dies — process gone, or just its lease connection dropped —
 * Postgres releases the lock, and B may take over on its next reconcile. That is
 * precisely the failover we want: at most one arm at a time, with automatic
 * handoff, and never a permanent freeze if a replica vanishes.
 *
 * NO SHARED DB → NO LOCK NEEDED. Without DATABASE_URL the grant store is the
 * single-file backend, which only one process can ever run against — so the
 * lease is implicit and acquire() returns a no-op hold that is always granted
 * and always healthy. This keeps the self-hosted path and the single-service
 * testnet deploy byte-identical to today; the lock machinery engages only once
 * there is a shared database for replicas to contend over.
 *
 * `pg` is a RUNTIME-only dependency (dynamic import), the same arrangement the
 * grant store uses, so the file backend builds and runs with pg absent.
 */

/** A held lease. `release()` is idempotent; `healthy()` is a cheap sync probe. */
export interface TenantLease {
  readonly tenant: `0x${string}`;
  /** "postgres" when a real advisory lock is held; "none" for the implicit single-process hold. */
  readonly backend: "postgres" | "none";
  /**
   * True while the lock is still ours. Goes false the instant the lease
   * connection errors or ends — because at that moment Postgres has released the
   * lock and another replica may hold it, so this child must stop trading. The
   * no-op lease is always healthy (nothing to lose).
   */
  healthy(): boolean;
  /** Release the lock and close the connection. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * A stable 64-bit key for a tenant, in Postgres `bigint` range.
 *
 * FNV-1a over the lowercased owner address, reinterpreted as a SIGNED 64-bit
 * integer (Postgres bigint is signed; an unsigned value ≥ 2^63 would overflow
 * the ::bigint cast). Deterministic, so every replica computes the same key for
 * the same tenant and they contend over the same lock. A 64-bit space makes a
 * collision between two distinct tenants astronomically unlikely — and even a
 * collision would only make one of them wait, never let both arm, so it fails
 * safe.
 */
export function leaseKey(tenant: string): bigint {
  const OFFSET = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  let h = OFFSET;
  const s = tenant.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= BigInt(s.charCodeAt(i));
    h = BigInt.asUintN(64, h * PRIME);
  }
  return BigInt.asIntN(64, h);
}

/** The minimal `pg.Client` surface the lease uses — keeps pg a runtime-only, untyped dep. */
interface PgLeaseClient {
  connect(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
  on(event: "error" | "end", cb: (...args: unknown[]) => void): void;
}

/** The always-granted hold used when there is no shared database to contend over. */
function noopLease(tenant: `0x${string}`): TenantLease {
  return {
    tenant,
    backend: "none",
    healthy: () => true,
    async release() {
      /* nothing to release — the hold was implicit */
    },
  };
}

/**
 * Try to lease `tenant`. Returns the held lease, or NULL when another replica
 * already holds it (the caller must then NOT arm this tenant and retry on a
 * later reconcile — the other replica may hand it back). Throws only on an
 * unexpected database error, which the caller treats as "skip this tenant this
 * reconcile", never as "arm anyway".
 *
 * Without DATABASE_URL this is the no-op hold (single process by construction).
 */
export async function acquireTenantLease(tenant: `0x${string}`): Promise<TenantLease | null> {
  const url = process.env.DATABASE_URL;
  if (!url) return noopLease(tenant);

  // pg is runtime-only: installed on the hosted image, absent from this repo and
  // from the self-hosted install. webpackIgnore stops any bundler resolving it.
  // @ts-expect-error pg has no types here (runtime-only); the import is gated on DATABASE_URL
  const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
    Client: new (c: { connectionString: string }) => PgLeaseClient;
  };
  const c = new pg.Client({ connectionString: url });
  await c.connect();

  // Latch loss of the lock. An errored or ended connection means Postgres has
  // already dropped our advisory lock, so from that instant the lease is no
  // longer ours — healthy() must report that even though the JS object survives.
  // Without a listener, a connection 'error' also throws as an unhandled event.
  let alive = true;
  c.on("error", () => {
    alive = false;
  });
  c.on("end", () => {
    alive = false;
  });

  const key = leaseKey(tenant).toString();
  try {
    const { rows } = await c.query("SELECT pg_try_advisory_lock($1::bigint) AS locked", [key]);
    if (rows[0]?.locked !== true) {
      // Another replica holds this tenant — release the connection and report it.
      await c.end().catch(() => {});
      return null;
    }
  } catch (e) {
    await c.end().catch(() => {});
    throw e;
  }

  return {
    tenant,
    backend: "postgres",
    healthy: () => alive,
    async release() {
      if (!alive) {
        // Connection already gone — the lock died with it; just close.
        await c.end().catch(() => {});
        return;
      }
      alive = false;
      try {
        await c.query("SELECT pg_advisory_unlock($1::bigint)", [key]);
      } catch {
        /* connection already unusable — the lock released itself */
      }
      await c.end().catch(() => {});
    },
  };
}
