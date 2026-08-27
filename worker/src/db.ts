/**
 * The ledger's database driver — one async interface, two backends.
 *
 * The store (store.ts) is the single writer of the trade/equity/position/basis
 * ledger. It used to talk to node:sqlite synchronously. To let a HOSTED deploy
 * put that ledger in shared Postgres — so the web service can read what a worker
 * child writes, and it survives a redeploy — every store call is now async and
 * goes through this `Db` seam:
 *
 *   - SqliteDb (the default, and all self-hosted) wraps node:sqlite. Its
 *     operations are synchronous under the hood, so wrapping them as async
 *     changes NOTHING about behaviour — the same file, the same WAL, the same
 *     crash-atomic transactions. This is what keeps self-hosted byte-for-byte.
 *   - PgDb (added in the next stage, selected by DATABASE_URL) will run the same
 *     SQL against Postgres with placeholder + dialect translation.
 *
 * `?` placeholders and the sqlite spelling of SQL are the lingua franca here; a
 * Postgres backend translates them. Transactions run through `tx()` so the
 * Postgres backend can pin them to one connection (a pool.query-per-statement
 * transaction would scatter across connections and never commit as a unit).
 */
import { DatabaseSync } from "node:sqlite";

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Stmt {
  run(...params: unknown[]): Promise<RunResult>;
  get(...params: unknown[]): Promise<unknown>;
  all(...params: unknown[]): Promise<unknown[]>;
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): Promise<void>;
  /** Run `fn` inside a single transaction. The db passed in IS the transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

// ── sqlite backend ─────────────────────────────────────────────────────────

class SqliteDb implements Db {
  constructor(private raw: DatabaseSync) {}
  prepare(sql: string): Stmt {
    const raw = this.raw;
    return {
      async run(...params) {
        return raw.prepare(sql).run(...(params as never[])) as RunResult;
      },
      async get(...params) {
        return raw.prepare(sql).get(...(params as never[]));
      },
      async all(...params) {
        return raw.prepare(sql).all(...(params as never[]));
      },
    };
  }
  async exec(sql: string): Promise<void> {
    this.raw.exec(sql);
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // node:sqlite is synchronous, so a single connection is the whole story:
    // BEGIN, run the body (which awaits, but each op completes synchronously),
    // then COMMIT — or ROLLBACK and rethrow. Same guarantee as before.
    this.raw.exec("BEGIN");
    try {
      const out = await fn(this);
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK");
      } catch {
        /* the transaction may already be gone */
      }
      throw e;
    }
  }
}

/**
 * Wrap an already-open node:sqlite connection as the async Db. store.ts opens the
 * connection and runs the schema SYNCHRONOUSLY (sqlite allows it, and that keeps
 * self-hosted's lazy-on-first-use init byte-for-byte); only the per-query calls
 * the store makes are routed through the async interface. Postgres selection
 * (DATABASE_URL) is added in the next stage as a sibling factory.
 */
export function wrapSqlite(raw: DatabaseSync): Db {
  return new SqliteDb(raw);
}

// ── sqlite → postgres translation ────────────────────────────────────────────
//
// The store writes SQL in the sqlite dialect (that is the self-hosted default and
// the only backend the test suite exercises). These pure functions rewrite it for
// Postgres. They are exported so they can be unit-tested WITHOUT a live database —
// the translation is the part that can silently be wrong, so it is the part with
// tests. The live Postgres round-trip itself is gated before any funding deploy
// (docs/hosted-platform-plan.md), exactly like the grant store's PG backend.

/** Rewrite `?` positional placeholders to Postgres `$1,$2,…`, skipping any inside
 *  single-quoted string literals (the store has none today, but a `?` in a string
 *  must never be renumbered). */
export function toPgPlaceholders(sql: string): string {
  let out = "";
  let n = 0;
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inStr = !inStr;
      out += ch;
      continue;
    }
    if (ch === "?" && !inStr) {
      out += "$" + ++n;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Translate ONE store query (not schema) to Postgres. */
export function translateQuery(sql: string): string {
  let s = sql;
  // `INSERT OR IGNORE INTO t (...) VALUES (...)` → append ON CONFLICT DO NOTHING.
  // Both store sites are single-statement with no existing conflict clause.
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(s)) {
    s = s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
    if (!/ON\s+CONFLICT/i.test(s)) s = s.replace(/\s*;?\s*$/, " ON CONFLICT DO NOTHING");
  }
  // sqlite tolerates `ON CONFLICT(cols)`; Postgres wants a space before the list.
  s = s.replace(/ON CONFLICT\(/g, "ON CONFLICT (");
  // `unixepoch()` is sqlite-only; Postgres computes the same integer this way.
  s = s.replace(/unixepoch\(\)/g, "EXTRACT(EPOCH FROM now())::bigint");
  return toPgPlaceholders(s);
}

/** Translate the DDL (CREATE block + an ALTER) to Postgres. Case-sensitive on the
 *  UPPERCASE type/keyword tokens the schema uses, so lowercase prose in the SQL
 *  comments (`the real thing`, `an INTEGER`) is never mistaken for a type. */
export function translateSchema(sql: string): string {
  let s = sql;
  s = s.replace(/PRAGMA[^;]*;/gi, ""); // WAL etc. — no Postgres equivalent, and not needed
  // Auto-increment PK first, before the generic INTEGER rule eats the word.
  s = s.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY");
  s = s.replace(/\bINTEGER\b/g, "BIGINT"); // sqlite INTEGER is 64-bit; match it, and epoch/block fit
  s = s.replace(/\bREAL\b/g, "DOUBLE PRECISION");
  s = s.replace(/unixepoch\(\)/g, "EXTRACT(EPOCH FROM now())::bigint");
  s = s.replace(/ADD COLUMN /g, "ADD COLUMN IF NOT EXISTS "); // idempotent re-runs on an existing db
  return s;
}

// ── postgres backend ─────────────────────────────────────────────────────────

/** The slice of a pg pool/client this driver uses. Kept minimal so `pg` stays a
 *  runtime-only dependency — no `@types/pg`, nothing to resolve at build. Mirrors
 *  grant-store.ts's PgClientLike. */
interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgClientLike>;
}
interface PgClientLike extends PgQueryable {
  release(): void;
}

/** Params sqlite bound loosely, made safe for pg's stricter serializer: bigints as
 *  decimal strings (the columns that hold them are TEXT), undefined as null. */
function coerceParams(params: unknown[]): unknown[] {
  return params.map((p) => (typeof p === "bigint" ? p.toString() : p === undefined ? null : p));
}

class PgDb implements Db {
  constructor(private q: PgQueryable) {}
  prepare(sql: string): Stmt {
    const text = translateQuery(sql);
    const q = this.q;
    return {
      async run(...params) {
        const r = await q.query(text, coerceParams(params));
        // The store never reads lastInsertRowid (verified), so 0 is a safe stand-in
        // rather than an extra RETURNING round-trip on every insert.
        return { changes: r.rowCount ?? 0, lastInsertRowid: 0 };
      },
      async get(...params) {
        const r = await q.query(text, coerceParams(params));
        return r.rows[0];
      },
      async all(...params) {
        const r = await q.query(text, coerceParams(params));
        return r.rows;
      },
    };
  }
  async exec(sql: string): Promise<void> {
    // exec carries only DDL here (schema + ALTERs), so it takes the schema dialect.
    await this.q.query(translateSchema(sql));
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // Pin the transaction to ONE checked-out connection. A pool.query-per-statement
    // transaction would scatter BEGIN/…/COMMIT across connections and never commit
    // as a unit — the reason the seam routes transactions through tx() at all.
    const pool = this.q as PgPoolLike;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(new PgDb(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* the transaction may already be gone */
      }
      throw e;
    } finally {
      client.release();
    }
  }
}

/**
 * Open the Postgres backend: dynamic-import `pg` (runtime-only, absent from this
 * repo and from any self-hosted install), teach it to hand back int8/BIGINT as a
 * JS number so the store's readers see the same shape sqlite gave them, and pool
 * the connections. The schema is run by the caller through `exec()`.
 */
export async function makePgDb(url: string): Promise<Db> {
  // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
  const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
    Pool: new (c: { connectionString: string; max?: number }) => PgPoolLike;
    types: { setTypeParser(oid: number, fn: (v: string) => unknown): void };
  };
  // int8 (oid 20) defaults to a JS string in node-postgres; sqlite returned a
  // number. Every int8 column here (epoch seconds, block numbers, ids, chat ids)
  // is well within 2^53, so Number is exact and keeps the store's read code — which
  // does arithmetic and comparisons on these — unchanged.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  const pool = new pg.Pool({ connectionString: url });
  return new PgDb(pool);
}
