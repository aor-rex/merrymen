/**
 * WAIT FOR AN ORDER'S ANSWER, AND SAY ONLY WHAT THE SERVER SAID.
 *
 * Lifted out of Agent.tsx so the loop can be run against a fake clock — the
 * component is not reachable from the test runner, and the bug lived in the
 * loop's timing.
 *
 * THE BUG. The card polled for a fixed seven minutes and then told the owner
 * "my worker did not pick it up in time, so nothing was sent". The order's own
 * window is max(5 min, 2 ticks + 15 s) — 8m15s at the hosted 240 s tick — and
 * the one-at-a-time slot is held a further two minutes past that. So an owner
 * could be told nothing happened, ask again, be refused "you already have an
 * order waiting", and then watch the first order fill.
 *
 * WHAT CHANGED. The server now carries the deadline back with the order and
 * says "expired" itself, from that deadline, only when nothing claimed it. This
 * loop keeps asking until the server gives a terminal answer — done or expired
 * — and repeats it. If the order's own window and its grace pass with no answer
 * at all, it says THAT, without converting silence into "nothing was sent": a
 * worker that took an order and has not reported back may still have filled it.
 *
 * STILL DIES WITH THE SCREEN (`alive`). Lifting the poll out of the component
 * so a tab switch does not end it is the next step, not this one.
 */
import { ORDER_STALE_GRACE_MS } from "@/lib/order-state";

/** One poll's reading. Null is a poll that could not be read — not an answer. */
export type OrderPoll = { state?: string; result?: string | null } | null;

export interface FollowDeps {
  poll(id: string): Promise<OrderPoll>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** False once the screen that asked has gone away. */
  alive(): boolean;
  say(line: string): void;
}

/** How often the card asks. Unchanged from the loop this replaced. */
export const FOLLOW_EVERY_MS = 5_000;

/**
 * Room past the order's deadline and grace before the card stops asking: one
 * ferry pass to carry a late answer up, and a couple of polls to read it.
 */
const FOLLOW_SLACK_MS = 60_000;

/**
 * How long to wait when the server gave no deadline — a duplicate from an older
 * server, or a response that lost the field. Longer than any window the route
 * issues at the hosted tick, because stopping early is the failure being fixed.
 */
const FALLBACK_WAIT_MS = 15 * 60_000;

/** The sentence for a TERMINAL answer, or null while the order is still open. */
export function orderAnswer(p: OrderPoll): string | null {
  if (!p) return null;
  if (p.state === "done") {
    // The worker's own words, which read the ledger row. Nothing here infers an
    // outcome — a browser guessing at what a trade did is exactly the claim
    // this codebase refuses to make.
    return p.result && p.result.trim()
      ? p.result
      : "My worker closed that order without saying how it went. Check your trades before asking again.";
  }
  if (p.state === "expired") {
    // The server says this only for an order nothing claimed, past its own
    // deadline and grace — which is what makes "nothing was sent" true.
    return "That order expired before my worker picked it up, so nothing was sent. Ask again if you still want it.";
  }
  return null;
}

/**
 * The window passed with no terminal answer. Said from the LAST thing the
 * server reported, and never as a failure: an order the worker has may still
 * fill, and one we could not read about is one we know nothing about.
 */
export function unansweredLine(last: OrderPoll): string {
  if (last?.state === "running") {
    return (
      "My worker has that order and has not answered yet, so I cannot say how it went — it may still fill. " +
      "Check your trades before asking again."
    );
  }
  if (last?.state === "queued") {
    // Only reachable for an order the server gave no deadline to: with one, the
    // server itself turns an unclaimed order into "expired" before this runs.
    return (
      "That order is still waiting for my worker to pick it up — nothing has gone out yet, but it still can. " +
      "Check your trades before asking again."
    );
  }
  return (
    "I could not get an answer about that order, so I cannot say whether it went through. " +
    "Check your trades before asking again."
  );
}

/** The real poll, as the card makes it. */
export async function fetchOrderPoll(id: string): Promise<OrderPoll> {
  try {
    const r = await fetch(`/api/orders?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8_000) });
    return r.ok ? ((await r.json()) as OrderPoll) : null;
  } catch {
    return null; // a dropped poll is not an outcome
  }
}

export async function followOrder(
  id: string,
  expiresAt: number | null,
  deps: Partial<Pick<FollowDeps, "poll" | "sleep" | "now">> & Pick<FollowDeps, "alive" | "say">,
): Promise<void> {
  const poll = deps.poll ?? fetchOrderPoll;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const giveUpAt =
    (expiresAt !== null && Number.isFinite(expiresAt) ? expiresAt + ORDER_STALE_GRACE_MS : now() + FALLBACK_WAIT_MS) +
    FOLLOW_SLACK_MS;
  let last: OrderPoll = null;
  while (now() < giveUpAt) {
    await sleep(FOLLOW_EVERY_MS);
    if (!deps.alive()) return;
    let read: OrderPoll;
    try {
      read = await poll(id);
    } catch {
      continue; // a dropped poll is not an outcome
    }
    if (read) last = read;
    const answer = orderAnswer(read);
    if (answer) {
      deps.say(answer);
      return;
    }
  }
  if (deps.alive()) deps.say(unansweredLine(last));
}
