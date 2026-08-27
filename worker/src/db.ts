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
