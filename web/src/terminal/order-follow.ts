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
 * ON THE BROWSER'S OWN CLOCK. The window comes back from POST as a duration
 * (`expiresInMs`) and is counted from when the reply arrived — see
 * followWindowMs for what comparing the server's epoch with Date.now() did.
 *
 * IT NO LONGER DIES WITH THE SCREEN. The poll ran inside Agent.tsx, which is
 * mounted only while the chat is on screen, so closing the dock, switching tab
 * or reloading ended it and the owner never heard how an order they had just
 * placed went. The chat controller (chat-controller.ts) now runs it at App
 * level and keeps each order's deadline — fixed once, on this browser's clock,
 * by followDeadline — so a reload resumes the same wait through
 * followOrderUntil rather than starting a new one. `alive` now means "this
 * owner's chat still exists", not "this screen is open".
 */
import { ORDER_STALE_GRACE_MS } from "@/lib/order-state";

/** One poll's reading. Null is a poll that could not be read — not an answer. */
export type OrderPoll = { state?: string; result?: string | null; receipt?: unknown } | null;

export interface FollowDeps {
  poll(id: string): Promise<OrderPoll>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** False once the screen that asked has gone away. */
  alive(): boolean;
  /**
   * The sentence, and the terminal poll it came from — null when the window
   * ran out with no answer, so nothing unanswered can pass for a receipt.
   */
  say(line: string, poll?: OrderPoll): void;
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

/**
 * How long the order's own window has left, as POST measured it — or null when
 * the reply did not say.
 *
 * A DURATION, NOT THE DEADLINE. `expiresAt` is the server's epoch, and the card
 * used to hold it against the browser's Date.now(): a clock eleven minutes fast
 * gave up before asking once, and a smaller skew stopped asking before the fill
 * arrived. Time elapsed is the one thing both clocks agree on.
 */
export function followWindowMs(body: unknown): number | null {
  const v = (body as { expiresInMs?: unknown } | null | undefined)?.expiresInMs;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * When to stop asking, as a moment on THIS browser's clock.
 *
 * Measured from `now` — when the POST's reply is in hand — so the wait can
 * only come out longer than the server's, never shorter. Fixed ONCE and kept
 * with the order, so a resumed follow waits out the same end instead of a
 * fresh window from the reload.
 */
export function followDeadline(expiresInMs: number | null, now: number): number {
  return (
    now +
    (expiresInMs !== null && Number.isFinite(expiresInMs) ? Math.max(0, expiresInMs) + ORDER_STALE_GRACE_MS : FALLBACK_WAIT_MS) +
    FOLLOW_SLACK_MS
  );
}

export async function followOrder(
  id: string,
  /** From followWindowMs: the order's window left at the POST, on no particular clock. */
  expiresInMs: number | null,
  deps: Partial<Pick<FollowDeps, "poll" | "sleep" | "now">> & Pick<FollowDeps, "alive" | "say">,
): Promise<void> {
  const now = deps.now ?? Date.now;
  return followOrderUntil(id, followDeadline(expiresInMs, now()), deps);
}

/**
 * Follow an order to its answer or to `giveUpAt` — the deadline followDeadline
 * fixed when it was placed, however long ago that was.
 *
 * IT ASKS AT LEAST ONCE. A follow resumed after its deadline — a chat reopened
 * an hour later — would otherwise say "I could not get an answer" without
 * having asked, about an order whose answer has long been on the server.
 */
export async function followOrderUntil(
  id: string,
  giveUpAt: number,
  deps: Partial<Pick<FollowDeps, "poll" | "sleep" | "now">> & Pick<FollowDeps, "alive" | "say">,
): Promise<void> {
  const poll = deps.poll ?? fetchOrderPoll;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  let last: OrderPoll = null;
  let asked = false;
  while (now() < giveUpAt || !asked) {
    await sleep(FOLLOW_EVERY_MS);
    if (!deps.alive()) return;
    asked = true;
    let read: OrderPoll;
    try {
      read = await poll(id);
    } catch {
      continue; // a dropped poll is not an outcome
    }
    if (read) last = read;
    const answer = orderAnswer(read);
    if (answer) {
      deps.say(answer, read);
      return;
    }
  }
  if (deps.alive()) deps.say(unansweredLine(last), null);
}
