/**
 * NEW REAL-MONEY FILLS, AS THE FEED READS ARRIVE — what the chime plays for and
 * what the tab title counts while nobody is looking.
 *
 * Only a trade that LANDED, with real money. The feed is mostly views and
 * scheduled holds, which arrive every few minutes whether or not anything
 * happened; a title that counted them would climb all day, and a chime for them
 * would be noise. A paper fill is excluded for the reason the rest of the
 * product keeps it apart from `landed` (read-agent.ts): it is simulated money,
 * and it fills on every proposal, so it would be the loudest thing on the feed
 * and the least news. Refusals and pending orders are not fills.
 *
 * DETECTED BY `postId` AND `at` TOGETHER — a fill, not a post. The id is stable
 * across reads (lib/post-id.ts leaves the outcome and the time out of it on
 * purpose), so a pending trade that lands keeps its id, which is why the set
 * remembers only LANDED rows: the landing is the news. But the id names a
 * THESIS, not a trade: it hashes the author, side, symbol, size and reason, and
 * the feed groups every landed copy of one post into one row whose `at` is the
 * newest copy. A steady-basket leg says the same sentence on every tick, so
 * keyed on the id alone its second fill (the same id, a newer `at`) was never
 * announced, and a leg that had filled before the page opened stayed silent for
 * the rest of the session. `at` moves only when a new landed copy joins the
 * group, so (postId, at) changes exactly when something filled. A post with no
 * id (an agent with no public slug) cannot be told apart from itself across
 * reads, and is never counted.
 *
 * NEVER ON THE FIRST READ. Everything on the feed when the page opened is what
 * the reader walked in on. And a fill first seen long after it happened is not
 * announced either: a reader that re-ranks its rows, or a deploy that changes
 * which rows it returns, would otherwise chime a dozen old trades at once.
 */
import type { Thesis } from "./live";

/** How recent a fill must be, when it first appears, to be announced. */
export const FRESH_SEC = 15 * 60;

/**
 * What `outcomeOf` (worker/src/thesis-policy.ts) says of a trade whose status
 * is "paper". It shares the "landed" outcome with a chain fill, so this text is
 * the only thing on a post that is about the FILL: `paper` beside it is the
 * author's mode at its last heartbeat, which flips when the owner goes live and
 * takes every recent paper fill with it.
 */
const PAPER_FILL_TEXT = "filled on paper";

export function isLandedTrade(t: Thesis): boolean {
  return (
    (t.action === "buy" || t.action === "sell") &&
    t.outcome === "landed" &&
    t.paper !== true &&
    t.outcomeText !== PAPER_FILL_TEXT &&
    t.shadow !== true &&
    typeof t.postId === "string" &&
    t.postId.length > 0
  );
}

/**
 * The fill a landed row stands for: its post, at its newest copy. Never the id
 * alone — see the header.
 */
export function fillKey(t: Thesis): string {
  return `${t.postId}@${typeof t.at === "number" && Number.isFinite(t.at) ? t.at : ""}`;
}

export function createArrivals(opts: { freshSec?: number; cap?: number } = {}) {
  const freshSec = opts.freshSec ?? FRESH_SEC;
  const cap = opts.cap ?? 2_000;
  const seen = new Set<string>();
  let seeded = false;
  return {
    /**
     * The landed fills in this READ answer that were not in any before it,
     * oldest first. Hand it only answers that were read: an unreadable one has
     * no rows, and the first readable one is the one that seeds.
     */
    take(theses: readonly Thesis[], nowSec: number): Thesis[] {
      const news: Thesis[] = [];
      for (const t of theses) {
        if (!isLandedTrade(t)) continue;
        const id = fillKey(t);
        if (seen.has(id)) continue;
        seen.add(id);
        const age = typeof t.at === "number" && Number.isFinite(t.at) ? nowSec - t.at : null;
        // A minute of clock skew either way, and no further.
        if (seeded && age !== null && age <= freshSec && age >= -60) news.push(t);
      }
      seeded = true;
      // The oldest remembered go first. An id forgotten and seen again is long
      // past fresh by the time the set has turned over, so it stays quiet.
      for (const id of seen) {
        if (seen.size <= cap) break;
        seen.delete(id);
      }
      return news.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
    },
    size: () => seen.size,
  };
}
