/**
 * WHAT BECAME OF AN ORDER, from the order's own clock.
 *
 * Split out of api/orders/route.ts so the rule can be executed by a test across
 * the deadline — the route imports the settings and command-file modules, which
 * the test runner cannot resolve. Pure: no database, no clock of its own.
 *
 * "expired" is the one answer here that tells an owner NOTHING WAS SENT, so it
 * is said only when that is certain: the order was never claimed, and it is
 * past its own `expiresAt` plus the grace the route holds the one-at-a-time
 * slot for. Every other late state stays what it is — a claimed order is the
 * worker's to answer, however long it takes, because it may still fill.
 */

/**
 * How long after its expiry a row may still hold the one-at-a-time slot.
 *
 * The expiry is enforced in the CHILD, at the claim, so a row can legitimately
 * be a ferry pass and a tick behind its own deadline while it is genuinely
 * being decided. Past that it either answered or never will, and either way it
 * must stop blocking — an owner locked out of ordering by a row nothing can
 * finish is the worse failure.
 *
 * The orchestrator's ORDER_GRACE_MS is the same figure, stated there because
 * the two processes share no module: the ferry must not close a row before the
 * route would free its slot, or a second order is admitted beside a live one.
 */
export const ORDER_STALE_GRACE_MS = 2 * 60_000;

export type OrderState = "queued" | "running" | "done" | "expired";

/**
 * The deadline an order was placed with, or null when it carries none.
 *
 * NULL IS NOT "ALREADY EXPIRED". The worker's `isExpired` treats a missing
 * `expiresAt` as no expiry at all, so an order without one can still be run —
 * and saying it expired would be telling the owner nothing was sent about an
 * order that may yet fill.
 */
export function orderExpiresAt(args: unknown): number | null {
  let bag: unknown = args;
  if (typeof args === "string") {
    try {
      bag = JSON.parse(args);
    } catch {
      return null;
    }
  }
  if (!bag || typeof bag !== "object") return null;
  const v = (bag as { expiresAt?: unknown }).expiresAt;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The one rule, for a table row and a command file alike. */
export function orderStateOf(
  o: { done: boolean; claimed: boolean; expiresAt: number | null },
  nowMs: number,
): OrderState {
  if (o.done) return "done";
  if (o.claimed) return "running";
  if (o.expiresAt !== null && nowMs > o.expiresAt + ORDER_STALE_GRACE_MS) return "expired";
  return "queued";
}

/** The hosted table row, as the card reads it. */
export function hostedOrderReply(
  row: Record<string, unknown>,
  nowMs: number,
): { id: string; state: OrderState; result: string | null; at: number; expiresAt: number | null } {
  const present = (v: unknown) => v !== null && v !== undefined;
  const expiresAt = orderExpiresAt(row.args);
  return {
    id: String(row.id),
    state: orderStateOf({ done: present(row.done_at), claimed: present(row.claimed_at), expiresAt }, nowMs),
    result: present(row.result) ? String(row.result) : null,
    at: Number(row.created_at),
    expiresAt,
  };
}
