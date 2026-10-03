/**
 * The convert latch — ONCE PER DEPOSIT, durable across restarts AND redeploys.
 *
 * THE BUG THIS FIXES. The hourly cooldown used to live in worker memory, so
 * every terminal stop/start reset it and the next tick re-converted the SAME
 * funds — the reserve left behind by the previous fire always reads as fresh
 * surplus. A home-dir JSON file fixed restarts but not hosted redeploys (the
 * child home is wiped), so the record lives in `convert_state` (store.ts),
 * mirrored like the rest of the ledger.
 *
 * THE RULE. After a fire the worker records the balance it left behind
 * (`consideredWei`). A later tick may fire only when the balance EXCEEDS that
 * marker — i.e. a deposit (or any inbound transfer) arrived. Balance only ever
 * grows that way; gas spend and trades move it down, and a downward move
 * ratchets the marker down with it, so a spend-then-small-deposit still counts
 * as a deposit. The hourly cooldown stays as anti-flap: two deposits inside one
 * hour convert on the second hour's tick, not twice at once.
 *
 * MANUAL SWAPS share the latch: a manual fire sets the same marker and clock,
 * so auto-convert cannot re-eat a manual swap's leftover an hour later, and a
 * manual request does not bypass the grant, the reserve, or the wall.
 *
 * AT-MOST-ONCE for manual requests: completed ids are claimed BEFORE submit
 * (write-ahead). A crash between submit and settle burns the id instead of
 * replaying the spend — the owner resubmits with a fresh id. Gas spends once
 * per instruction.
 *
 * This module is pure rules + row codec; the SQL lives in store.ts next to
 * every other table. No clock, no RPC, no filesystem — exported for tests.
 */

export const AUTO_CONVERT_COOLDOWN_MS = 3_600_000;
const MAX_COMPLETED_IDS = 50;

export interface ConvertLatch {
  /** ms epoch of the last fire (auto or manual). 0 = never. */
  firedAtMs: number;
  /** Balance (wei) left behind by the last fire — the high-water mark of
   * "already considered" funds. Only an excess over this may fire. */
  consideredWei: bigint;
  /** Manual request ids already honoured. Bounded; newest last. */
  completedSwapIds: string[];
  /** ms epoch of the last write — the mirror's freshness guard. */
  updatedAtMs: number;
}

export function emptyLatch(): ConvertLatch {
  return { firedAtMs: 0, consideredWei: 0n, completedSwapIds: [], updatedAtMs: 0 };
}

function toWei(s: string | undefined): bigint {
  try {
    if (typeof s !== "string" || !/^\d+$/.test(s)) return 0n;
    return BigInt(s);
  } catch {
    return 0n;
  }
}

/** Row codec — the store row carries decimal text and JSON (sqlite has
 * no bigint and no arrays); the latch carries bigints and a string list.
 * Corrupt fields degrade toward "never fired" (safe: may convert) rather
 * than toward "already fired" (which would silently skip a deposit). */
export function latchFromRow(row: {
  firedAtMs: unknown;
  consideredWei: unknown;
  completedIds: unknown;
  updatedAtMs: unknown;
}): ConvertLatch {
  const latch = emptyLatch();
  if (typeof row.firedAtMs === "number" && Number.isFinite(row.firedAtMs) && row.firedAtMs >= 0) {
    latch.firedAtMs = Math.floor(row.firedAtMs);
  }
  latch.consideredWei = toWei(typeof row.consideredWei === "string" ? row.consideredWei : undefined);
  if (typeof row.completedIds === "string") {
    try {
      const ids = JSON.parse(row.completedIds) as unknown;
      if (Array.isArray(ids)) {
        latch.completedSwapIds = ids
          .filter((id): id is string => typeof id === "string" && id.length > 0)
          .slice(-MAX_COMPLETED_IDS);
      }
    } catch {
      /* corrupt ids — treat as none honoured, never as all honoured */
    }
  }
  if (typeof row.updatedAtMs === "number" && Number.isFinite(row.updatedAtMs) && row.updatedAtMs >= 0) {
    latch.updatedAtMs = Math.floor(row.updatedAtMs);
  }
  return latch;
}

export function latchToRow(latch: ConvertLatch): {
  firedAtMs: number;
  consideredWei: string;
  completedIds: string;
  updatedAtMs: number;
} {
  return {
    firedAtMs: latch.firedAtMs,
    consideredWei: latch.consideredWei.toString(),
    completedIds: JSON.stringify(latch.completedSwapIds.slice(-MAX_COMPLETED_IDS)),
    updatedAtMs: latch.updatedAtMs,
  };
}

/**
 * May this tick fire? Both halves must hold: new money (balance above the
 * marker) AND the cooldown elapsed.
 */
export function latchAllowsFire(latch: ConvertLatch, balanceWei: bigint, nowMs: number): boolean {
  if (balanceWei <= latch.consideredWei) return false; // same funds — never again
  if (nowMs - latch.firedAtMs < AUTO_CONVERT_COOLDOWN_MS) return false; // too soon after the last fire
  return true;
}

/**
 * Ratchet the marker down when funds leave WITHOUT a fire (gas, trades, an
 * off-worker withdrawal). Without this a spend followed by a smaller deposit
 * would sit forever under a stale-high marker. Returns true when the caller
 * should persist.
 */
export function ratchetMarkerDown(latch: ConvertLatch, balanceWei: bigint): boolean {
  if (balanceWei < latch.consideredWei) {
    latch.consideredWei = balanceWei;
    return true;
  }
  return false;
}

/** Record a fire: the clock restarts and the marker becomes what was left. */
export function recordFire(latch: ConvertLatch, nowMs: number, leftoverWei: bigint): void {
  latch.firedAtMs = nowMs;
  latch.consideredWei = leftoverWei;
  latch.updatedAtMs = nowMs;
}

/** True when this manual request id was already honoured. */
export function swapIdCompleted(latch: ConvertLatch, id: string): boolean {
  return latch.completedSwapIds.includes(id);
}

/** Remember a honoured manual request id (bounded). Caller persists. */
export function recordSwapId(latch: ConvertLatch, id: string, nowMs: number): void {
  if (!latch.completedSwapIds.includes(id)) {
    latch.completedSwapIds.push(id);
    latch.completedSwapIds = latch.completedSwapIds.slice(-MAX_COMPLETED_IDS);
  }
  latch.updatedAtMs = nowMs;
}

/**
 * Withdraw a claim made before a spend that never happened — the durable
 * write failed, so the id must not look honoured to a retry with the same id.
 * The mirror image of recordSwapId: claiming is write-ahead, unclaiming is
 * persist-failure-only. Never called after a broadcast.
 */
export function unclaimSwapId(latch: ConvertLatch, id: string): void {
  latch.completedSwapIds = latch.completedSwapIds.filter((x) => x !== id);
}

export interface ManualSwapRequest {
  wei: bigint;
  id: string;
}

/**
 * Validate a manual-swap handoff (settings fields). Digits-only wei and a
 * tight id shape — anything else is ignored, never executed.
 */
export function parseManualSwap(s: {
  manualSwapWei?: unknown;
  manualSwapId?: unknown;
}): ManualSwapRequest | null {
  if (typeof s.manualSwapWei !== "string" || !/^\d{1,30}$/.test(s.manualSwapWei)) return null;
  if (typeof s.manualSwapId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(s.manualSwapId)) {
    return null;
  }
  const wei = BigInt(s.manualSwapWei); // safe: digits-only, bounded length
  if (wei <= 0n) return null;
  return { wei, id: s.manualSwapId };
}

/**
 * The convert ticket — a single-use spend authorization for one manual swap,
 * ferried by the orchestrator into the child home (convert-ticket.json).
 *
 * WHY A FILE, NOT THE SHARED DB. A hosted child cannot read shared Postgres
 * (DATABASE_URL is stripped by design), and its own sqlite dies with a fresh
 * home — so neither is a trustworthy pre-spend read. The ticket file is the
 * orchestrator's signed word, written at spawn and every pass, AFTER the
 * orchestrator atomically claimed the id in shared convert_claims. No ticket
 * for this id means the spend is not authorized: either the claim never
 * landed (storage failure — wait, don't spend) or it landed and the ticket
 * was lost (crash before ferry — ambiguous, fail closed, owner resubmits).
 */
export interface ConvertTicket {
  /** "ok" authorizes exactly this id; "blocked" names an id that must NOT execute. */
  status: "ok" | "blocked";
  /** The manual swap id this ticket speaks about. */
  id: string;
  /** ms epoch the orchestrator wrote the ticket — for the alert copy, not a TTL. */
  issuedAtMs: number;
}

/** Read and validate a ticket file. Garbage, wrong shape, or missing: null. */
export function readConvertTicket(raw: string | null | undefined): ConvertTicket | null {
  if (typeof raw !== "string") return null;
  try {
    const t = JSON.parse(raw) as Record<string, unknown>;
    if ((t.status !== "ok" && t.status !== "blocked") || typeof t.id !== "string") return null;
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(t.id)) return null;
    return { status: t.status, id: t.id, issuedAtMs: typeof t.issuedAtMs === "number" ? t.issuedAtMs : 0 };
  } catch {
    return null;
  }
}

/** Parse a JSON id array defensively: garbage in, empty list out. Shared by
 * the orchestrator (shared completed_ids) and tests. */
export function parseCompletedIds(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const ids = JSON.parse(v) as unknown;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
  } catch {
    return [];
  }
}

/**
 * The worker's half of the ticket gate — pure, tested. "go" spends;
 * "wait" holds silently (no ticket yet, or a ticket for another id — the
 * orchestrator decides next pass); "blocked" holds AND alerts the owner once
 * (ambiguous: claimed without a ticket, the spend may already have happened).
 */
export function manualTicketAllows(
  ticket: ConvertTicket | null,
  handoffId: string,
): "go" | "wait" | "blocked" {
  if (ticket && ticket.id === handoffId) {
    return ticket.status === "ok" ? "go" : "blocked";
  }
  return "wait";
}

export type TicketDecision =
  /** Fresh handoff: claim it in shared storage, then write an "ok" ticket. */
  | { action: "issue" }
  /** Ticket already in the home for this id: execution in flight, leave it. */
  | { action: "pending" }
  /** Nothing to authorize (no handoff, or id completed): remove any ticket. */
  | { action: "done" }
  /** Claimed before but no ticket in the home: ambiguous (crash between claim
   * and ferry, or redeploy after broadcast before mirror). Fail closed: write
   * a "blocked" ticket and alert the owner — never re-issue. */
  | { action: "blocked" };

/**
 * Pure ticket decision — the orchestrator's per-tenant rule, exported for
 * tests. Inputs are all shared-durable except ticketInHome (the file the
 * last pass ferried, if it survived).
 */
export function decideConvertTicket(args: {
  handoffId: string | null;
  completedIds: string[];
  claimedIds: string[] | null;
  ticketInHome: { id: string; status: "ok" | "blocked" } | null;
}): TicketDecision {
  const { handoffId, completedIds, claimedIds, ticketInHome } = args;
  if (!handoffId || completedIds.includes(handoffId)) return { action: "done" };
  if (claimedIds === null) return { action: "done" }; // storage unreachable: change nothing, spend nothing
  if (ticketInHome?.status === "ok" && ticketInHome.id === handoffId) return { action: "pending" };
  if (claimedIds.includes(handoffId)) return { action: "blocked" };
  return { action: "issue" };
}
