/**
 * Trade/event/equity persistence — SQLite (node:sqlite, built into Node 22+).
 * One durable file at .data/merrymen.db shared by worker (writer) and web
 * (reader via /api/feed). No external service, no keys. Migration path to
 * Postgres is a schema port when the platform goes multi-user.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { StoredGrant } from "../../packages/core/src/index";
import { ensureHome, homePaths } from "./home";

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;
  ensureHome();
  const DB_FILE = homePaths.db();
  db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(`
    /* agent_id (= smart_account here) threads EVERY per-agent table: trades,
       decisions, positions, cost_basis, equity, fee_accruals. On the EVM rail
       it is the ERC-4337 smart-account address; on the broker rail it is the
       namespaced "rh:<account_number>" from venues/robinhood-id.ts — the
       prefix exists so the two id spaces can never collide, and a broker row
       can never key into an on-chain agent's basis, HWM, or fee ledger. */
    CREATE TABLE IF NOT EXISTS agents (
      smart_account TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT 'Robin',
      owner_address TEXT NOT NULL,
      session_key_address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      caps TEXT NOT NULL,
      granted_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'armed',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'ok',
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS events_agent_time ON events (agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      target TEXT NOT NULL,
      sell_token TEXT,
      buy_token TEXT,
      amount_usdg REAL NOT NULL,
      user_op_hash TEXT,
      tx_hash TEXT,
      status TEXT NOT NULL,
      reject_rule TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS trades_agent_time ON trades (agent_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS equity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      eth_wei TEXT NOT NULL,
      cash_usdg REAL NOT NULL,
      vault_usdg REAL NOT NULL,
      equity_usdg REAL NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS equity_agent_time ON equity (agent_id, at DESC);
    CREATE TABLE IF NOT EXISTS fee_accruals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      profit_usdg REAL NOT NULL,
      fee_usdg REAL NOT NULL,
      hwm_before_usdg REAL NOT NULL,
      hwm_after_usdg REAL NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS fee_accruals_agent_time ON fee_accruals (agent_id, at DESC);
    -- Money crossing the account's boundary: the owner funding it, or taking
    -- money back out. NOT trades, and NOT vault moves (those are equity-neutral
    -- shuffles inside the wall).
    --
    -- Without this table equity is a bare balance reading with no flow term, so
    -- a deposit is arithmetically indistinguishable from a gain: /pnl reported
    -- +999.48 on a book that was down 0.52, and the performance fee charged the
    -- owner on their own principal. Every performance figure is now measured
    -- against (equity - netContributions) instead of against equity.
    --
    -- 'source' records HOW we know, in the same spirit as trades.basis_source
    -- and positions.price_source. The three are not equally good evidence:
    --   'chain-log'       a Transfer log naming this account. Exact, has a tx.
    --   'transfer-intent' our own outbound transfer. Exact, has a tx.
    --   'inferred'        a cash change no fill explains. Honest guesswork; only
    --                     ever recorded when NO trade ran in the interval, so it
    --                     cannot be confused with a fill, and it carries no tx.
    -- An audit that needs a chain-verifiable figure keeps the first two.
    CREATE TABLE IF NOT EXISTS flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      direction TEXT NOT NULL,       -- 'in' | 'out'
      amount_usdg REAL NOT NULL,     -- always positive; direction carries the sign
      tx_hash TEXT,                  -- null only when source = 'inferred'
      block_number INTEGER,
      source TEXT NOT NULL,
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS flows_agent_time ON flows (agent_id, at DESC);
    -- The audit record: an append-only, hash-chained mirror of every fact that
    -- moves money, written in the SAME transaction as the row it mirrors so the
    -- two cannot diverge.
    --
    -- Why it exists. The tables above are a plain sqlite file on the operator's
    -- own disk. Anyone can rewrite them with the sqlite3 CLI in ten seconds, and
    -- the equity curve is not derivable from anything else — it is a series of
    -- point-in-time balance readings written by the same process being audited.
    -- "Verifiable, not claimed" was in the README while the ledger could prove
    -- nothing to anyone.
    --
    -- What the chain buys: each entry carries the hash of the one before it, so
    -- an edited or deleted record breaks every hash after it. 'seq' is
    -- monotonic, so a DELETED record is visible as a gap — silence is as
    -- detectable as tampering. It is NOT signed: a signature proves the machine
    -- holding the key wrote it, which the chain plus the on-chain cross-check
    -- already establish, without introducing a key to manage.
    CREATE TABLE IF NOT EXISTS journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      epoch INTEGER NOT NULL,
      kind TEXT NOT NULL,           -- 'fill' | 'flow' | 'mark' | 'fee'
      payload_json TEXT NOT NULL,   -- canonical JSON (sorted keys) of the fact
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL,           -- sha256(prev_hash + payload_json)
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS journal_agent_epoch ON journal (agent_id, epoch, seq);
    CREATE TABLE IF NOT EXISTS positions (
      agent_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      token TEXT NOT NULL,
      raw_balance TEXT NOT NULL,
      ui_multiplier TEXT NOT NULL,
      price_usd REAL NOT NULL,
      price_stale INTEGER NOT NULL DEFAULT 0,
      value_usdg REAL NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (agent_id, symbol)
    );
    CREATE TABLE IF NOT EXISTS paper_book (
      agent_id TEXT PRIMARY KEY,
      cash_usdg REAL NOT NULL,
      vault_usdg REAL NOT NULL DEFAULT 0,
      hwm_usdg REAL NOT NULL DEFAULT 0,
      shares TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    -- Every proposal the agent made — SURVIVING (linked to a trade via
    -- trades.decision_id) and DROPPED (dropped_rule set, no trade). This is the
    -- attribution substrate: it turns "why did you trade" from a ±15-min event
    -- guess into a real join, and is the prerequisite for learning from outcomes.
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      source TEXT NOT NULL,        -- 'strategist' | 'strategy:<name>' | 'chat' | 'selftest'
      strategy TEXT,
      provider TEXT,
      model TEXT,
      symbol TEXT,
      action TEXT,                 -- 'buy' | 'sell' | 'hold' | 'transfer' | ...
      size_usdg REAL,
      reason TEXT,                 -- the model's own words (never fed back into policy)
      dropped_rule TEXT,           -- non-null when the proposal was dropped before execution
      signals_json TEXT,           -- the inputs the decision was made on (for later review)
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS decisions_agent_time ON decisions (agent_id, at DESC);
    -- Conversation turns, so the merryman doesn't lose the thread on restart.
    -- Lives in sqlite rather than a json file because the db is already open and
    -- single-writer; a file would need its own read-modify-write and would race
    -- the notifier. Content is already truncated and HTML-stripped by the caller.
    CREATE TABLE IF NOT EXISTS chat_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      role TEXT NOT NULL,          -- 'user' | 'assistant'
      content TEXT NOT NULL,
      memory_ids TEXT,             -- JSON array: what was recalled for this turn
      at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS chat_turns_chat_time ON chat_turns (chat_id, id DESC);
    -- Weighted-average cost basis per held symbol (see basis.ts). Quantities are
    -- 18dp RAW units and cost is 6dp USDG, both as decimal strings because
    -- sqlite has no bigint — parsed straight back to BigInt on read.
    -- Basis lives per RAW unit, so ERC-8056 splits never disturb it.
    --
    -- PARTITIONED BY MODE: 'paper', 'live', 'brokerage'. Each is a different
    -- book of a different asset (simulated shares vs real tokens vs custodial
    -- shares); sharing a row would let a simulated fill price a real sell, a
    -- custodial fill price an on-chain position, or delete another book's cost.
    -- Mirrors how paper_book is already separate from on-chain balances. The
    -- brokerage book's raw unit is decided when its writer lands (step 5/6 of
    -- the adapter plan) — the column is unit-agnostic decimal strings either way.
    CREATE TABLE IF NOT EXISTS cost_basis (
      agent_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      symbol TEXT NOT NULL,
      qty_raw TEXT NOT NULL,
      cost_usdg TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (agent_id, mode, symbol)
    );
    -- Pairs discovery has already told the owner about. Persisted so a restart
    -- doesn't re-announce every launch of the last hour as if it were new —
    -- a feed that cries wolf on every reboot stops being read.
    CREATE TABLE IF NOT EXISTS discovered_pools (
      address TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      first_seen INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  for (const ddl of [
    "ALTER TABLE equity ADD COLUMN positions_usdg REAL NOT NULL DEFAULT 0",
    // Persistent high-water mark + running fee total — HWM must survive
    // restarts or the breaker and the fee ledger both forget the peak.
    "ALTER TABLE agents ADD COLUMN hwm_usdg REAL NOT NULL DEFAULT 0",
    "ALTER TABLE agents ADD COLUMN accrued_fee_usdg REAL NOT NULL DEFAULT 0",
    // Simulation receipt: what the pre-trade quote promised, on the record.
    "ALTER TABLE trades ADD COLUMN sim_quote_out TEXT",
    "ALTER TABLE trades ADD COLUMN sim_min_out TEXT",
    "ALTER TABLE trades ADD COLUMN sim_fee_tier INTEGER",
    "ALTER TABLE trades ADD COLUMN sim_gas TEXT",
    // Attribution link: which decision produced this trade (see decisions table).
    "ALTER TABLE trades ADD COLUMN decision_id TEXT",
    // Fill economics — what actually moved, so P&L is computable per round-trip.
    "ALTER TABLE trades ADD COLUMN fill_side TEXT",
    "ALTER TABLE trades ADD COLUMN fill_qty_raw TEXT",
    "ALTER TABLE trades ADD COLUMN fill_price_usd REAL",
    "ALTER TABLE trades ADD COLUMN realized_pnl_usdg REAL",
    // How the fill figures were obtained: 'paper' (exact, simulated at the oracle
    // price) or 'quote' (live swap, taken from the pre-trade QuoterV2 simulation
    // rather than a parsed receipt). Never silently mix the two in analysis.
    "ALTER TABLE trades ADD COLUMN basis_source TEXT",
    // Where a holding's price came from: 'chainlink' (an external feed) or 'pool'
    // (a Uniswap TWAP, used for tokens with no feed). Not the same evidential
    // quality, so every surface that shows a value can say which it is instead of
    // presenting both as the same kind of number. Old rows default to chainlink,
    // which is what they were — nothing else could produce a price back then.
    "ALTER TABLE positions ADD COLUMN price_source TEXT NOT NULL DEFAULT 'chainlink'",
    // Discovery grew from "have I announced this" into "is it worth entering".
    "ALTER TABLE discovered_pools ADD COLUMN decimals INTEGER NOT NULL DEFAULT 18",
    "ALTER TABLE discovered_pools ADD COLUMN liquidity_usd REAL NOT NULL DEFAULT 0",
    "ALTER TABLE discovered_pools ADD COLUMN fdv_usd REAL NOT NULL DEFAULT 0",
    // Brokerage orders. A broker fill has an order id and no tx hash, and it
    // fills asynchronously — 'status' stays our coarse verdict enum, while
    // settlement_status carries the BROKER'S OWN state word verbatim
    // (submitted/partial/filled/cancelled/…, vocabulary unverified until read
    // off the wire — DESIGN.md §11 Q5). Both NULL on every EVM and paper row.
    "ALTER TABLE trades ADD COLUMN order_id TEXT",
    "ALTER TABLE trades ADD COLUMN settlement_status TEXT",
    // Gas actually paid on a landed UserOp, wei. The account self-pays with no
    // paymaster, so this is a real cost of every trade — and it was invisible:
    // sim_gas holds QuoterV2's estimate for the SWAP CALL only, unmultiplied by
    // any gas price, so realized P&L was gross of gas forever.
    "ALTER TABLE trades ADD COLUMN gas_wei TEXT",
    // EPOCH. Everything written before the accounting was fixed stays epoch 1
    // and is excluded from performance reporting — kept for forensics, never
    // presented as measured. The first tick after the fix opens epoch 2. This
    // is the "new epoch, keep history" decision enforced by the schema rather
    // than by convention, so no reconstructed figure can leak into a published
    // number by someone forgetting.
    "ALTER TABLE trades ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE equity ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE flows ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE fee_accruals ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    // The epoch this agent is currently writing into.
    "ALTER TABLE agents ADD COLUMN epoch INTEGER NOT NULL DEFAULT 1",
    // Measured execution quality: quoted-out vs received-out, in bps, positive
    // when the fill was worse than quoted. The slippage SETTING is one flat 1%
    // constant applied to a $5 trade and a $5,000 one alike; this is the
    // evidence needed to replace it with something size-aware.
    "ALTER TABLE trades ADD COLUMN fill_slippage_bps INTEGER",
  ]) {
    try {
      db.exec(ddl);
    } catch {
      // column already exists
    }
  }
  // stderr, not stdout: `merrymen export` writes the audit journal to stdout,
  // and a diagnostic line landing in the middle of it corrupts the file. A log
  // is not data.
  console.error(`[store] sqlite at ${DB_FILE}`);
  return db;
}

/** Create the DB + schema eagerly so a broken store fails at startup, not mid-trade. */
export function initStore(): void {
  getDb();
}

export interface TradeRow {
  agent_id: string;
  kind: string;
  target: string;
  sell_token?: string;
  buy_token?: string;
  amount_usdg: number;
  /**
   * OUR UserOperation hash — the only id that identifies this trade on a 4337
   * explorer. The bundled `tx_hash` may carry other people's operations too.
   *
   * This column, its type field and its INSERT placeholder all existed for
   * months while NO call site ever supplied a value: a landed trade could not
   * be traced back to the operation that produced it. Populated since 2026-08-26.
   */
  user_op_hash?: string;
  tx_hash?: string;
  /**
   * Our coarse verdict, not the broker's. 'submitted' is the brokerage rail's
   * committed-but-not-yet-filled state: the money is already reserved against
   * the caps (a submitted order is spend the instant it leaves), and step 6's
   * reconciler resolves it to landed/reverted from the wire. The broker's own
   * state words live in settlement_status, verbatim — two vocabularies, never
   * mixed.
   */
  status: "landed" | "reverted" | "rejected" | "paper" | "submitted";
  reject_rule?: string;
  /** Brokerage order id (no tx hash exists on that rail). NULL elsewhere. */
  order_id?: string;
  /** The broker's own order-state word, stored verbatim. NULL elsewhere. */
  settlement_status?: string;
  /*
   * No created_at. The column is `INTEGER NOT NULL DEFAULT (unixepoch())` and
   * addTrade deliberately omits it from the INSERT, so SQLite stamps the row.
   *
   * It used to be a required field here that fourteen call sites dutifully
   * filled with `new Date().toISOString()` — and every one of those strings was
   * dropped on the floor, because the column was never in the INSERT list. The
   * type promised control the code did not have.
   *
   * That mattered less than it looked (the stored value was always a correct
   * integer, and the trailing-24h budget windows have always worked), but it is
   * a live trap for anything that needs to record when something ACTUALLY
   * happened rather than when the row was written — a settlement reconciler for
   * an async brokerage fill, say. Such a thing needs its own column, e.g.
   * `filled_at`; it must not reach for this one and quietly get nothing.
   */
  /** Simulation receipt (Uniswap QuoterV2): quoted out, slippage-bounded min, tier, gas. */
  sim_quote_out?: string;
  sim_min_out?: string;
  sim_fee_tier?: number;
  sim_gas?: string;
  /** Attribution: the decisions.id that produced this trade (null for legacy rows). */
  decision_id?: string;
  /** Fill economics — set on filled trades so P&L is computable per round-trip. */
  fill_side?: "buy" | "sell";
  /** 18dp raw units filled, as a decimal string. */
  fill_qty_raw?: string;
  fill_price_usd?: number;
  /** 6dp-derived USDG booked on this fill (sells only; buys are always 0). */
  realized_pnl_usdg?: number;
  /**
   * How the fill figures were obtained, in descending order of evidence:
   *   'receipt' — read off the settled transaction's Transfer logs. The fact.
   *   'paper'   — exact, but simulated at the oracle price. Not real money.
   *   'quote'   — the pre-trade QuoterV2 bound. An ESTIMATE, and the fallback
   *               when a receipt cannot be parsed. Never mix it with 'receipt'
   *               in analysis without saying so.
   */
  basis_source?: "receipt" | "paper" | "quote";
  /** Gas actually paid, wei, as a decimal string. Real cost; not in equity_usdg. */
  gas_wei?: string;
  /** Measured execution quality: how far the fill landed from the quote, in bps (+ is worse). */
  fill_slippage_bps?: number;
}

/** One row in the decisions table — the proposal, its reasoning, and its fate. */
export interface DecisionRow {
  id: string;
  agent_id: string;
  source: string;
  strategy?: string;
  provider?: string;
  model?: string;
  symbol?: string;
  action?: string;
  size_usdg?: number;
  reason?: string;
  /** Set when the proposal was dropped before execution (no trade will link to it). */
  dropped_rule?: string;
  signals_json?: string;
}

/** A fresh decision id. Kept here so every producer stamps the same shape. */
export function newDecisionId(): string {
  return randomUUID();
}

export async function addDecision(row: DecisionRow): Promise<void> {
  try {
    getDb()
      .prepare(
        `INSERT INTO decisions (id, agent_id, source, strategy, provider, model, symbol, action, size_usdg, reason, dropped_rule, signals_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.agent_id,
        row.source,
        row.strategy ?? null,
        row.provider ?? null,
        row.model ?? null,
        row.symbol ?? null,
        row.action ?? null,
        row.size_usdg ?? null,
        row.reason ?? null,
        row.dropped_rule ?? null,
        row.signals_json ?? null,
      );
  } catch (e) {
    console.error("[store] decision insert failed:", e);
  }
}

export async function ensureAgent(grant: StoredGrant): Promise<string> {
  getDb()
    .prepare(
      `INSERT INTO agents (smart_account, owner_address, session_key_address, chain_id, caps, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(smart_account) DO UPDATE SET
         caps = excluded.caps, expires_at = excluded.expires_at, session_key_address = excluded.session_key_address`,
    )
    .run(
      grant.smartAccount,
      grant.owner,
      grant.sessionKeyAddress,
      grant.chainId,
      JSON.stringify(grant.caps),
      grant.grantedAt,
      grant.expiresAt,
    );
  return grant.smartAccount;
}

/** Persisted HWM + accrued fees, loaded at arm time. */
export async function getAgentFinancials(
  agentId: string,
): Promise<{ hwmUsdg: number; accruedFeeUsdg: number }> {
  const row = getDb()
    .prepare("SELECT hwm_usdg, accrued_fee_usdg FROM agents WHERE smart_account = ?")
    .get(agentId) as { hwm_usdg: number; accrued_fee_usdg: number } | undefined;
  return { hwmUsdg: row?.hwm_usdg ?? 0, accruedFeeUsdg: row?.accrued_fee_usdg ?? 0 };
}

/** Ratchet the persisted HWM (monotonic — ignores values below the stored peak). */
export async function setAgentHwm(agentId: string, hwmUsdg: number): Promise<void> {
  try {
    getDb()
      .prepare("UPDATE agents SET hwm_usdg = MAX(hwm_usdg, ?) WHERE smart_account = ?")
      .run(hwmUsdg, agentId);
  } catch (e) {
    console.error("[store] hwm update failed:", e);
  }
}

/**
 * Move the HWM by a signed amount, floored at zero — the ONE exception to its
 * monotonicity, and only ever for capital crossing the boundary.
 *
 * The HWM is monotonic with respect to PERFORMANCE: recovering to a previous
 * peak is not profit and must not be charged for. It cannot be monotonic with
 * respect to CAPITAL. A 1,000 USDG deposit lifts equity by 1,000 without
 * earning a penny, so the peak it is measured against has to lift too, or the
 * next tick books the owner's own money as profit and takes a fee on it. A
 * withdrawal is the mirror: leave the peak up and the account is permanently
 * "in drawdown" by the amount its owner took home, which trips the breaker.
 */
export async function adjustAgentHwm(agentId: string, deltaUsdg: number): Promise<void> {
  try {
    getDb()
      .prepare("UPDATE agents SET hwm_usdg = MAX(0, hwm_usdg + ?) WHERE smart_account = ?")
      .run(deltaUsdg, agentId);
  } catch (e) {
    console.error("[store] hwm adjust failed:", e);
  }
}

// ── the audit journal ─────────────────────────────────────────────────────

/** The chain's anchor. A verifier starts here and must arrive at the last hash. */
export const JOURNAL_GENESIS = "0".repeat(64);

/**
 * Deterministic JSON: keys sorted at every level, bigints as decimal strings.
 *
 * The hash is only reproducible if an independent verifier serialises the same
 * bytes we did. Object key order in JS is insertion order, which is a property
 * of whichever code path built the object — so `{a,b}` and `{b,a}` are the same
 * fact and would otherwise hash differently, and the chain would "fail" on a
 * ledger nobody touched.
 */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        const inner = (v as Record<string, unknown>)[k];
        if (inner !== undefined) out[k] = norm(inner);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** One link: sha256(prev ‖ canonical payload). Pure, so a verifier can redo it. */
export function journalHash(prevHash: string, payloadJson: string): string {
  return createHash("sha256").update(prevHash).update(payloadJson).digest("hex");
}

export type JournalKind = "fill" | "flow" | "mark" | "fee";

export interface JournalEntry {
  seq: number;
  agent_id: string;
  epoch: number;
  kind: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
  at: number;
}

/**
 * Append one fact to the chain. Callers pass the DOMAIN row they just wrote (or
 * are about to), and this mirrors it.
 *
 * Not exported for casual use: it takes an open transaction from
 * `journaled()` so the mirror and the row it mirrors commit together. A journal
 * that can be half-written is not evidence of anything.
 */
function appendJournalRow(agentId: string, epoch: number, kind: JournalKind, payload: unknown): void {
  const db = getDb();
  const prev = db
    .prepare("SELECT hash FROM journal WHERE agent_id = ? AND epoch = ? ORDER BY seq DESC LIMIT 1")
    .get(agentId, epoch) as { hash: string } | undefined;
  const prevHash = prev?.hash ?? JOURNAL_GENESIS;
  const payloadJson = canonicalJson(payload);
  db.prepare(
    `INSERT INTO journal (agent_id, epoch, kind, payload_json, prev_hash, hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(agentId, epoch, kind, payloadJson, prevHash, journalHash(prevHash, payloadJson));
}

/**
 * Run a domain write and its journal entry as ONE transaction.
 *
 * The worker is the single writer, so this is about crash-atomicity rather than
 * concurrency: a process that dies between the two writes must leave neither,
 * not a ledger whose chain has a hole in it or a journal claiming a trade the
 * trades table never got.
 */
export function journaled(
  agentId: string,
  epoch: number,
  kind: JournalKind,
  payload: unknown,
  write: () => void,
): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    write();
    appendJournalRow(agentId, epoch, kind, payload);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* the transaction may already be gone */
    }
    throw e;
  }
}

/** Every entry for one epoch, oldest first — what `merrymen export` emits. */
export async function readJournal(agentId: string, epoch: number): Promise<JournalEntry[]> {
  try {
    return getDb()
      .prepare(
        `SELECT seq, agent_id, epoch, kind, payload_json, prev_hash, hash, at
           FROM journal WHERE agent_id = ? AND epoch = ? ORDER BY seq ASC`,
      )
      .all(agentId, epoch) as unknown as JournalEntry[];
  } catch {
    return [];
  }
}

/** Synchronous epoch lookup — the write paths below are sync and can't await. */
function epochOf(agentId: string): number {
  try {
    const row = getDb()
      .prepare("SELECT epoch FROM agents WHERE smart_account = ?")
      .get(agentId) as { epoch: number } | undefined;
    return row?.epoch ?? 1;
  } catch {
    return 1;
  }
}

/** The epoch this agent writes into now. */
export async function getAgentEpoch(agentId: string): Promise<number> {
  try {
    const row = getDb()
      .prepare("SELECT epoch FROM agents WHERE smart_account = ?")
      .get(agentId) as { epoch: number } | undefined;
    return row?.epoch ?? 1;
  } catch {
    return 1;
  }
}

/**
 * Does this agent have rows from before the audit work? Used once, at the first
 * arm, to decide whether an epoch boundary is needed. A brand-new agent has
 * nothing to quarantine and stays in epoch 1.
 */
export async function hasEpochOneHistory(agentId: string): Promise<boolean> {
  try {
    const row = getDb()
      .prepare(
        `SELECT (SELECT COUNT(*) FROM trades WHERE agent_id = ? AND epoch = 1)
              + (SELECT COUNT(*) FROM equity WHERE agent_id = ? AND epoch = 1) AS n`,
      )
      .get(agentId, agentId) as { n: number } | undefined;
    return (row?.n ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Close the current epoch and open the next. Everything before stays, untouched. */
export async function openNextEpoch(agentId: string): Promise<number> {
  const next = (await getAgentEpoch(agentId)) + 1;
  getDb().prepare("UPDATE agents SET epoch = ? WHERE smart_account = ?").run(next, agentId);
  return next;
}

/** How the ledger came to know about a flow. See the flows DDL — these are not equal evidence. */
export type FlowSource = "chain-log" | "transfer-intent" | "inferred";

export interface FlowRow {
  agentId: string;
  direction: "in" | "out";
  amountUsdg: number;
  source: FlowSource;
  txHash?: string;
  blockNumber?: number;
}

/** Record money crossing the account boundary, and mirror it into the journal. */
export async function addFlow(flow: FlowRow): Promise<void> {
  try {
    const epoch = epochOf(flow.agentId);
    const amount = Math.abs(flow.amountUsdg);
    journaled(
      flow.agentId,
      epoch,
      "flow",
      {
        amountUsdg: amount,
        blockNumber: flow.blockNumber ?? null,
        direction: flow.direction,
        source: flow.source,
        txHash: flow.txHash ?? null,
      },
      () => {
        getDb()
          .prepare(
            `INSERT INTO flows (agent_id, direction, amount_usdg, tx_hash, block_number, source, epoch)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            flow.agentId,
            flow.direction,
            amount,
            flow.txHash ?? null,
            flow.blockNumber ?? null,
            flow.source,
            epoch,
          );
      },
    );
  } catch (e) {
    console.error("[store] flow insert failed:", e);
  }
}

/**
 * Capital the owner has put in, less what they have taken out. Subtract it from
 * equity and what remains is the only thing that deserves to be called P&L.
 *
 * NULL when nothing is on record — which is NOT the same as zero. A ledger
 * written before the flows table existed knows nothing about what was put in,
 * and treating that as "nothing was put in" republishes the original bug:
 * equity minus zero is the bankroll, presented as profit. Callers must show no
 * P&L at all rather than a confident wrong one.
 */
export async function getNetContributionsUsdg(agentId: string): Promise<number | null> {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
       FROM flows WHERE agent_id = ?`,
    )
    .get(agentId) as { n: number; net: number } | undefined;
  if (!row || row.n === 0) return null;
  return row.net;
}

/**
 * Total gas paid on landed operations, in wei.
 *
 * Reported SEPARATELY rather than folded into equity, deliberately. Gas leaves
 * the account in ETH and there is no ETH/USD feed configured — only a WETH pool
 * — so converting it would mean inventing a price for the one figure whose job
 * is to be beyond dispute. equity_usdg is cash + vault + positions and excludes
 * ETH entirely, which means realized P&L is GROSS OF GAS; this is the number
 * that says by how much.
 */
export async function getGasPaidWei(agentId: string): Promise<bigint> {
  try {
    const rows = getDb()
      .prepare("SELECT gas_wei FROM trades WHERE agent_id = ? AND gas_wei IS NOT NULL")
      .all(agentId) as { gas_wei: string }[];
    return rows.reduce((sum, r) => {
      try {
        return sum + BigInt(r.gas_wei);
      } catch {
        return sum;
      }
    }, 0n);
  } catch {
    return 0n; // pre-migration ledger
  }
}

/** The flow record itself, newest first — for the audit export and /pnl's detail line. */
export async function listFlows(agentId: string, limit = 200): Promise<
  { direction: string; amount_usdg: number; source: string; tx_hash: string | null; at: number }[]
> {
  return getDb()
    .prepare(
      `SELECT direction, amount_usdg, source, tx_hash, at FROM flows
       WHERE agent_id = ? ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(agentId, limit) as {
    direction: string;
    amount_usdg: number;
    source: string;
    tx_hash: string | null;
    at: number;
  }[];
}

/** Record one accrual event and roll it into the agent's running total. */
export async function addFeeAccrual(
  agentId: string,
  a: { profitUsdg: number; feeUsdg: number; hwmBeforeUsdg: number; hwmAfterUsdg: number },
): Promise<void> {
  try {
    const epoch = epochOf(agentId);
    journaled(agentId, epoch, "fee", { ...a, epoch }, () => {
      const db = getDb();
      db.prepare(
        `INSERT INTO fee_accruals (agent_id, profit_usdg, fee_usdg, hwm_before_usdg, hwm_after_usdg, epoch)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(agentId, a.profitUsdg, a.feeUsdg, a.hwmBeforeUsdg, a.hwmAfterUsdg, epoch);
      db.prepare(
        "UPDATE agents SET accrued_fee_usdg = accrued_fee_usdg + ? WHERE smart_account = ?",
      ).run(a.feeUsdg, agentId);
    });
  } catch (e) {
    console.error("[store] fee accrual failed:", e);
  }
}

export async function setAgentStatus(
  agentId: string,
  status: "armed" | "active" | "killed" | "expired",
): Promise<void> {
  try {
    getDb().prepare("UPDATE agents SET status = ? WHERE smart_account = ?").run(status, agentId);
  } catch (e) {
    console.error("[store] status update failed:", e);
  }
}

export async function addEvent(
  agentId: string,
  level: "ok" | "warn" | "err",
  message: string,
): Promise<void> {
  try {
    getDb()
      .prepare("INSERT INTO events (agent_id, level, message) VALUES (?, ?, ?)")
      .run(agentId, level, message);
  } catch (e) {
    console.error("[store] event insert failed:", e);
  }
}

export async function addTrade(row: TradeRow): Promise<void> {
  try {
    const epoch = epochOf(row.agent_id);
    // Only money-moving rows enter the hash chain. A rejection changes no
    // balance, so its absence cannot distort a performance claim — and there
    // are thousands of them. They stay in `trades` (and in the export, as
    // context) without being part of the tamper-evident record.
    const moved = row.status === "landed" || row.status === "paper";
    const writeRow = () => {
      getDb()
      .prepare(
        `INSERT INTO trades (agent_id, kind, target, sell_token, buy_token, amount_usdg, user_op_hash, tx_hash, status, reject_rule,
                             sim_quote_out, sim_min_out, sim_fee_tier, sim_gas, decision_id,
                             fill_side, fill_qty_raw, fill_price_usd, realized_pnl_usdg, basis_source,
                             order_id, settlement_status, gas_wei, fill_slippage_bps, epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.agent_id,
        row.kind,
        row.target,
        row.sell_token ?? null,
        row.buy_token ?? null,
        row.amount_usdg,
        row.user_op_hash ?? null,
        row.tx_hash ?? null,
        row.status,
        row.reject_rule ?? null,
        row.sim_quote_out ?? null,
        row.sim_min_out ?? null,
        row.sim_fee_tier ?? null,
        row.sim_gas ?? null,
        row.decision_id ?? null,
        row.fill_side ?? null,
        row.fill_qty_raw ?? null,
        row.fill_price_usd ?? null,
        row.realized_pnl_usdg ?? null,
        row.basis_source ?? null,
        row.order_id ?? null,
        row.settlement_status ?? null,
        row.gas_wei ?? null,
        row.fill_slippage_bps ?? null,
        epoch,
      );
    };
    if (!moved) {
      writeRow();
      return;
    }
    journaled(
      row.agent_id,
      epoch,
      "fill",
      {
        amountUsdg: row.amount_usdg,
        basisSource: row.basis_source ?? null,
        buyToken: row.buy_token ?? null,
        decisionId: row.decision_id ?? null,
        fillPriceUsd: row.fill_price_usd ?? null,
        fillQtyRaw: row.fill_qty_raw ?? null,
        fillSide: row.fill_side ?? null,
        gasWei: row.gas_wei ?? null,
        kind: row.kind,
        realizedPnlUsdg: row.realized_pnl_usdg ?? null,
        sellToken: row.sell_token ?? null,
        slippageBps: row.fill_slippage_bps ?? null,
        status: row.status,
        target: row.target,
        txHash: row.tx_hash ?? null,
        userOpHash: row.user_op_hash ?? null,
      },
      writeRow,
    );
  } catch (e) {
    console.error("[store] trade insert failed:", e);
  }
}

export async function addEquity(
  agentId: string,
  b: {
    ethWei: bigint;
    cashUsdg: number;
    vaultUsdg: number;
    positionsUsdg: number;
    /**
     * The composed total. REQUIRED, and not re-derived here.
     *
     * This function used to compute `cash + vault + positions` itself while the
     * caller judged fees and the drawdown breaker against a figure that also
     * included quarantined cost — so the curve every surface reads sat below the
     * number the performance fee ratcheted on, by exactly the quarantined
     * amount, forever. One definition, in equity.composeEquityUsdg, passed in.
     */
    equityUsdg: number;
    /**
     * The prices this valuation was made at, and how good each one is.
     *
     * Without them a historical equity figure cannot be re-derived by anyone,
     * including us: `positions` carries price/source/staleness but is UPSERTED
     * every tick, so each snapshot destroys the last. The equity row kept only
     * the resulting scalar, which is an assertion, not a derivation.
     */
    marks?: readonly { symbol: string; priceUsd: number; source: string; stale: boolean }[];
    /** Block the balances were read at — the anchor an auditor re-reads from. */
    blockNumber?: bigint;
  },
): Promise<void> {
  try {
    const epoch = epochOf(agentId);
    journaled(
      agentId,
      epoch,
      "mark",
      {
        blockNumber: b.blockNumber?.toString() ?? null,
        cashUsdg: b.cashUsdg,
        equityUsdg: b.equityUsdg,
        ethWei: b.ethWei.toString(),
        marks: (b.marks ?? []).map((m) => ({
          priceUsd: m.priceUsd,
          source: m.source,
          stale: m.stale,
          symbol: m.symbol,
        })),
        positionsUsdg: b.positionsUsdg,
        vaultUsdg: b.vaultUsdg,
      },
      () => {
        getDb()
          .prepare(
            "INSERT INTO equity (agent_id, eth_wei, cash_usdg, vault_usdg, positions_usdg, equity_usdg, epoch) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(agentId, b.ethWei.toString(), b.cashUsdg, b.vaultUsdg, b.positionsUsdg, b.equityUsdg, epoch);
      },
    );
  } catch (e) {
    console.error("[store] equity insert failed:", e);
  }
}

/** Latest holdings snapshot — replaces, then prunes symbols no longer held. */
export async function setPositions(
  agentId: string,
  positions: readonly {
    symbol: string;
    token: string;
    rawBalance: bigint;
    uiMultiplier: bigint;
    priceUsd: number;
    priceStale: boolean;
    /** 'chainlink', 'pool' or 'broker' — see the price_source migration. */
    priceSource: string;
    valueUsdg: number;
  }[],
): Promise<void> {
  try {
    const db = getDb();
    const upsert = db.prepare(
      `INSERT INTO positions (agent_id, symbol, token, raw_balance, ui_multiplier, price_usd, price_stale, price_source, value_usdg, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(agent_id, symbol) DO UPDATE SET
         raw_balance = excluded.raw_balance, ui_multiplier = excluded.ui_multiplier,
         price_usd = excluded.price_usd, price_stale = excluded.price_stale,
         price_source = excluded.price_source,
         value_usdg = excluded.value_usdg, updated_at = excluded.updated_at`,
    );
    for (const p of positions) {
      upsert.run(
        agentId,
        p.symbol,
        p.token,
        p.rawBalance.toString(),
        p.uiMultiplier.toString(),
        p.priceUsd,
        p.priceStale ? 1 : 0,
        p.priceSource,
        p.valueUsdg,
      );
    }
    const held = positions.map((p) => p.symbol);
    const placeholders = held.map(() => "?").join(",");
    db.prepare(
      held.length
        ? `DELETE FROM positions WHERE agent_id = ? AND symbol NOT IN (${placeholders})`
        : "DELETE FROM positions WHERE agent_id = ?",
    ).run(agentId, ...held);
  } catch (e) {
    console.error("[store] positions update failed:", e);
  }
}

/**
 * Which book a budget question is about. Paper money and real money are not the
 * same money, and they must not share a budget.
 *
 * They used to. Both counters below asked for status IN ('landed','paper',
 * 'submitted'), so a paper run spent the LIVE 48-op allowance and then refused
 * itself for the rest of the day. That is not hypothetical: it is what happened
 * on 2026-07-15 — 48 simulated fills exhausted the cap in 21 minutes, and the
 * remaining 11.7 hours of the run are 1,242 identical 'ops-cap' rejections.
 *
 * Paper still counts against the cap on its OWN rail, deliberately. The point of
 * paper mode is that it behaves like live; an unbudgeted paper run would prove
 * nothing about what live would do.
 */
export type BudgetRail = "live" | "paper";

/**
 * 'submitted' counts on the live rail: a brokerage order that has left the
 * building is an op whether or not it has filled yet, and excluding it would let
 * a restart forget in-flight orders and overshoot the ops cap. Step 6's
 * reconciler resolves each 'submitted' to landed/reverted; a reverted
 * resolution is the one case the seed then over-counts until the row flips,
 * which is the conservative direction — budgets may under-spend, never
 * over-spend.
 */
const RAIL_STATUSES: Record<BudgetRail, readonly string[]> = {
  live: ["landed", "submitted"],
  paper: ["paper"],
};

/** `IN (?, ?)` placeholders for a rail's status set. */
function railFilter(rail: BudgetRail): { sql: string; params: readonly string[] } {
  const params = RAIL_STATUSES[rail];
  return { sql: params.map(() => "?").join(", "), params };
}

/**
 * Executed-op count on one rail in the trailing 24h — seeds the ops-cap counter
 * across restarts, and (since the counter no longer only ever climbs) re-reads
 * it as ops age out of the window.
 */
export async function getOpsToday(agentId: string, rail: BudgetRail = "live"): Promise<number> {
  const { sql, params } = railFilter(rail);
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM trades
       WHERE agent_id = ? AND status IN (${sql}) AND created_at > unixepoch() - 86400`,
    )
    .get(agentId, ...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Rename the agent — the user-given merryman name (shown on the dashboard). */
export async function setAgentName(agentId: string, name: string): Promise<void> {
  try {
    getDb().prepare(`UPDATE agents SET name = ? WHERE smart_account = ?`).run(name, agentId);
  } catch (e) {
    console.error("[store] agent rename failed:", e);
  }
}

/** Sum of landed chat transfers in the trailing 24h — the transfer sub-budget. */
export async function getTransferredTodayUsdg(agentId: string): Promise<number> {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdg), 0) AS spent FROM trades
       WHERE agent_id = ? AND status = 'landed' AND kind = 'transfer'
         AND created_at > unixepoch() - 86400`,
    )
    .get(agentId) as { spent: number } | undefined;
  return row?.spent ?? 0;
}

/**
 * Sum of spend on one rail in the trailing 24h — seeds the daily-cap counter.
 * Same rail split as getOpsToday, and for the same reason: simulated spend must
 * not consume a real allowance.
 */
export async function getSpentTodayUsdg(agentId: string, rail: BudgetRail = "live"): Promise<number> {
  const { sql, params } = railFilter(rail);
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(amount_usdg), 0) AS spent FROM trades
       WHERE agent_id = ? AND status IN (${sql}) AND kind != 'vault-withdraw'
         AND created_at > unixepoch() - 86400`,
    )
    .get(agentId, ...params) as { spent: number } | undefined;
  return row?.spent ?? 0;
}

// ── chat turns — the conversation survives a restart ──────────────────────

/** Kept per chat on disk. Only the newest few reach a prompt (see service.ts);
 * the rest exist for sticky-memory lookup and future recall. */
const CHAT_TURNS_KEPT = 40;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** Memory ids surfaced for this turn, so a pronoun follow-up keeps the thread. */
  memoryIds?: string[];
}

/** Append one turn and prune the chat back to its retention window. */
export function appendChatTurn(chatId: number, turn: ChatTurn): void {
  try {
    const db = getDb();
    db.prepare("INSERT INTO chat_turns (chat_id, role, content, memory_ids) VALUES (?, ?, ?, ?)").run(
      chatId,
      turn.role,
      turn.content,
      turn.memoryIds && turn.memoryIds.length ? JSON.stringify(turn.memoryIds) : null,
    );
    db.prepare(
      `DELETE FROM chat_turns WHERE chat_id = ? AND id NOT IN (
         SELECT id FROM chat_turns WHERE chat_id = ? ORDER BY id DESC LIMIT ?)`,
    ).run(chatId, chatId, CHAT_TURNS_KEPT);
  } catch (e) {
    console.error("[store] chat turn insert failed:", e);
  }
}

/** The most recent turns for a chat, oldest-first (prompt order). */
export function recentChatTurns(chatId: number, limit = CHAT_TURNS_KEPT): ChatTurn[] {
  try {
    const rows = getDb()
      .prepare("SELECT role, content, memory_ids FROM chat_turns WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
      .all(chatId, limit) as { role: string; content: string; memory_ids: string | null }[];
    return rows
      .reverse()
      .map((r) => {
        let memoryIds: string[] | undefined;
        try {
          memoryIds = r.memory_ids ? (JSON.parse(r.memory_ids) as string[]) : undefined;
        } catch {
          memoryIds = undefined; // a corrupt blob must not cost us the turn
        }
        return { role: r.role === "assistant" ? "assistant" : "user", content: r.content, memoryIds } as ChatTurn;
      });
  } catch {
    return [];
  }
}

/** Unix seconds of the last turn in a chat, or null if there is none. Lets the
 * merryman know it's been three days rather than opening cold every time. */
export function lastChatTurnAt(chatId: number): number | null {
  try {
    const row = getDb()
      .prepare("SELECT at FROM chat_turns WHERE chat_id = ? ORDER BY id DESC LIMIT 1")
      .get(chatId) as { at: number } | undefined;
    return row?.at ?? null;
  } catch {
    return null;
  }
}

/** Forget one chat's conversation — what /forget must actually do now that
 * turns persist to disk rather than dying with the process. */
export function clearChatTurns(chatId: number): void {
  try {
    getDb().prepare("DELETE FROM chat_turns WHERE chat_id = ?").run(chatId);
  } catch (e) {
    console.error("[store] chat turn clear failed:", e);
  }
}

// ── cost basis — weighted-average, per symbol (see basis.ts) ──────────────

/**
 * Paper, live, and brokerage keep separate books — see the cost_basis DDL.
 * 'brokerage' exists so a custodial fill can never price an on-chain
 * position's sell (or vice versa); its writer lands with step 6.
 */
export type BasisMode = "paper" | "live" | "brokerage";

/** Load a symbol's basis for one mode. Missing row = a flat position, not an error. */
export function getBasis(agentId: string, mode: BasisMode, symbol: string): { qtyRaw: bigint; costUsdg: bigint } {
  try {
    const row = getDb()
      .prepare("SELECT qty_raw, cost_usdg FROM cost_basis WHERE agent_id = ? AND mode = ? AND symbol = ?")
      .get(agentId, mode, symbol) as { qty_raw: string; cost_usdg: string } | undefined;
    if (!row) return { qtyRaw: 0n, costUsdg: 0n };
    return { qtyRaw: BigInt(row.qty_raw), costUsdg: BigInt(row.cost_usdg) };
  } catch {
    return { qtyRaw: 0n, costUsdg: 0n };
  }
}

/** Persist a symbol's basis; a fully-closed position drops the row entirely. */
export function setBasis(
  agentId: string,
  mode: BasisMode,
  symbol: string,
  b: { qtyRaw: bigint; costUsdg: bigint },
): void {
  try {
    const db = getDb();
    if (b.qtyRaw <= 0n) {
      db.prepare("DELETE FROM cost_basis WHERE agent_id = ? AND mode = ? AND symbol = ?").run(agentId, mode, symbol);
      return;
    }
    db.prepare(
      `INSERT INTO cost_basis (agent_id, mode, symbol, qty_raw, cost_usdg, updated_at)
       VALUES (?, ?, ?, ?, ?, unixepoch())
       ON CONFLICT(agent_id, mode, symbol) DO UPDATE SET
         qty_raw = excluded.qty_raw, cost_usdg = excluded.cost_usdg, updated_at = excluded.updated_at`,
    ).run(agentId, mode, symbol, b.qtyRaw.toString(), b.costUsdg.toString());
  } catch (e) {
    console.error("[store] basis update failed:", e);
  }
}

/** Every symbol carrying basis in one mode — used to reconcile against reality. */
export function basisSymbols(agentId: string, mode: BasisMode): string[] {
  try {
    const rows = getDb()
      .prepare("SELECT symbol FROM cost_basis WHERE agent_id = ? AND mode = ?")
      .all(agentId, mode) as { symbol: string }[];
    return rows.map((r) => r.symbol);
  } catch {
    return [];
  }
}

/**
 * Realized P&L over closed round trips, for ONE agent and ONE book. Paper and
 * live money must never be summed together, and rows whose basis was unknown
 * carry NULL so they're excluded rather than counted as cost-free profit.
 */
export function getRealizedPnlUsdg(agentId: string, mode: BasisMode, sinceUnix?: number): number {
  // Exhaustive on purpose: a mode with no status mapping would read ZERO P&L
  // everywhere, silently — the exact failure the design doc calls out.
  // 'brokerage' maps to 'landed' like 'live': a settled broker fill is as real
  // as a landed swap, and 'submitted' rows are excluded here because an
  // unfilled order has no realized anything. Cross-talk with 'live' is
  // impossible at the query level: broker agents live in the rh: id space, so
  // one agent_id never carries both kinds of landed row.
  const statusByMode: Record<BasisMode, string> = { paper: "paper", live: "landed", brokerage: "landed" };
  const status = statusByMode[mode];
  try {
    const row = (
      sinceUnix
        ? getDb()
            .prepare(
              "SELECT COALESCE(SUM(realized_pnl_usdg), 0) AS pnl FROM trades WHERE agent_id = ? AND status = ? AND realized_pnl_usdg IS NOT NULL AND created_at > ?",
            )
            .get(agentId, status, sinceUnix)
        : getDb()
            .prepare(
              "SELECT COALESCE(SUM(realized_pnl_usdg), 0) AS pnl FROM trades WHERE agent_id = ? AND status = ? AND realized_pnl_usdg IS NOT NULL",
            )
            .get(agentId, status)
    ) as { pnl: number } | undefined;
    return row?.pnl ?? 0;
  } catch {
    return 0;
  }
}

// ── paper book — the zero-funds ledger (see paper.ts) ─────────────────────

export interface PaperBookRow {
  cashUsdg: number;
  vaultUsdg: number;
  hwmUsdg: number;
  /** symbol → { token, shares } */
  shares: Record<string, { token: `0x${string}`; shares: number }>;
}

/** Load the paper book, seeding it with the starting cash on first touch. */
export async function getPaperBook(agentId: string, startUsdg: number): Promise<PaperBookRow> {
  getDb()
    .prepare("INSERT OR IGNORE INTO paper_book (agent_id, cash_usdg) VALUES (?, ?)")
    .run(agentId, startUsdg);
  const row = getDb()
    .prepare("SELECT cash_usdg, vault_usdg, hwm_usdg, shares FROM paper_book WHERE agent_id = ?")
    .get(agentId) as { cash_usdg: number; vault_usdg: number; hwm_usdg: number; shares: string };
  let shares: PaperBookRow["shares"] = {};
  try {
    shares = JSON.parse(row.shares) as PaperBookRow["shares"];
  } catch {
    // corrupt shares blob — start clean rather than crash the tick
  }
  return { cashUsdg: row.cash_usdg, vaultUsdg: row.vault_usdg, hwmUsdg: row.hwm_usdg, shares };
}

export async function setPaperBook(agentId: string, book: PaperBookRow): Promise<void> {
  getDb()
    .prepare(
      `UPDATE paper_book SET cash_usdg = ?, vault_usdg = ?, hwm_usdg = ?, shares = ?, updated_at = unixepoch()
       WHERE agent_id = ?`,
    )
    .run(book.cashUsdg, book.vaultUsdg, book.hwmUsdg, JSON.stringify(book.shares), agentId);
}

/** Addresses discovery has already reported. Bounded — old rows are pruned. */
export function seenPools(): Set<string> {
  try {
    const rows = getDb().prepare("SELECT address FROM discovered_pools").all() as { address: string }[];
    return new Set(rows.map((r) => r.address.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** Record a reported pair so it is never announced twice. */
export function markPoolSeen(address: string, symbol: string): void {
  try {
    getDb()
      .prepare("INSERT OR IGNORE INTO discovered_pools (address, symbol) VALUES (?, ?)")
      .run(address.toLowerCase(), symbol.slice(0, 16));
    // A launchy chain could otherwise grow this forever. 5k rows is far more
    // than dedupe needs and keeps the table trivial to scan.
    getDb().exec(
      "DELETE FROM discovered_pools WHERE address NOT IN (SELECT address FROM discovered_pools ORDER BY first_seen DESC LIMIT 5000)",
    );
  } catch (e) {
    console.error("[store] discovered_pools insert failed:", e);
  }
}

// ── discovery candidates + trench positions ────────────────────────────────

export interface PoolCandidate {
  address: string;
  symbol: string;
  decimals: number;
  liquidityUsd: number;
  fdvUsd: number;
  firstSeen: number;
}

/**
 * Remember a discovered pair WITH the numbers a decision needs.
 *
 * Discovery previously stored only an address, which was enough to avoid
 * announcing twice and useless for anything else — a strategy asking "is this
 * worth entering" would have had to re-derive every figure from scratch.
 * `first_seen` doubles as the age baseline: the pool's own creation time isn't
 * always available, and the moment we first saw it is at least a fact.
 */
export function recordCandidate(c: PoolCandidate): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO discovered_pools (address, symbol, decimals, liquidity_usd, fdv_usd)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET
           symbol = excluded.symbol, decimals = excluded.decimals,
           liquidity_usd = excluded.liquidity_usd, fdv_usd = excluded.fdv_usd`,
      )
      .run(c.address.toLowerCase(), c.symbol.slice(0, 16), c.decimals, c.liquidityUsd, c.fdvUsd);
  } catch (e) {
    console.error("[store] candidate upsert failed:", e);
  }
}

/** Candidates seen within `maxAgeSec`, freshest first. */
export function recentCandidates(maxAgeSec: number, limit = 25): PoolCandidate[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT address, symbol, decimals, liquidity_usd, fdv_usd, first_seen
         FROM discovered_pools WHERE first_seen > unixepoch() - ?
         ORDER BY first_seen DESC LIMIT ?`,
      )
      .all(maxAgeSec, limit) as {
      address: string; symbol: string; decimals: number;
      liquidity_usd: number; fdv_usd: number; first_seen: number;
    }[];
    return rows.map((r) => ({
      address: r.address,
      symbol: r.symbol,
      decimals: Number(r.decimals) || 18,
      liquidityUsd: Number(r.liquidity_usd) || 0,
      fdvUsd: Number(r.fdv_usd) || 0,
      firstSeen: Number(r.first_seen) || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * The entry baseline a trench exit is judged against.
 *
 * Only depth and time live here. Entry PRICE is derived from cost basis
 * instead — that ledger already tracks exactly what was paid per raw unit, and
 * a second copy could disagree with it after a partial fill.
 */
export function setTrenchEntry(agentId: string, mode: BasisMode, symbol: string, liquidityUsd: number): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO trench_positions (agent_id, mode, symbol, entry_liquidity_usd)
         VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, mode, symbol) DO NOTHING`,
      )
      .run(agentId, mode, symbol, liquidityUsd);
  } catch (e) {
    console.error("[store] trench entry insert failed:", e);
  }
}

export function getTrenchEntry(
  agentId: string,
  mode: BasisMode,
  symbol: string,
): { liquidityUsd: number; entrySec: number } | null {
  try {
    const row = getDb()
      .prepare("SELECT entry_liquidity_usd, entry_sec FROM trench_positions WHERE agent_id = ? AND mode = ? AND symbol = ?")
      .get(agentId, mode, symbol) as { entry_liquidity_usd: number; entry_sec: number } | undefined;
    return row ? { liquidityUsd: Number(row.entry_liquidity_usd), entrySec: Number(row.entry_sec) } : null;
  } catch {
    return null;
  }
}

/** Forget a closed position, so re-entering later starts a fresh baseline. */
export function clearTrenchEntry(agentId: string, mode: BasisMode, symbol: string): void {
  try {
    getDb()
      .prepare("DELETE FROM trench_positions WHERE agent_id = ? AND mode = ? AND symbol = ?")
      .run(agentId, mode, symbol);
  } catch {
    /* nothing to clear */
  }
}
