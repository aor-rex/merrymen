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
 * A FILL, NOT A POST: each post's landed row is remembered as it was last read
 * — its `at` and its `said` — and it is news when either says a copy joined.
 * The id is stable across reads (lib/post-id.ts leaves the outcome and the time
 * out of it on purpose), so a pending trade that lands keeps its id, which is
 * why only LANDED rows are remembered: the landing is the news. But the id
 * names a THESIS, not a trade: it hashes the author, side, symbol, size and
 * reason, and the feed groups every landed copy of one post into one row. A
 * steady-basket leg says the same sentence on every tick, so keyed on the id
 * alone its second fill was never announced.
 *
 *   `at` ADVANCED — the row's `at` is MAX(d.at) over its landed copies, so a
 *   copy decided after every other one has landed.
 *   `said` GREW with `at` standing still — an order decided EARLIER than the
 *   row's newest copy landed after it (`at` is the newest decision, not the
 *   newest fill). Keyed on (postId, at) alone this was silent.
 *
 * `said` is not part of any key: it SHRINKS as old copies leave the feed's
 * window, and a key with it in would re-announce the row every time one did.
 * It is compared with the last read, and only its growth counts. A row whose
 * `at` went back is some other grouping of the same post, not a fill, and is
 * not remembered over the row it was. A post with no id (an agent with no
 * public slug) cannot be told apart from itself across reads, and is never
 * counted.
 *
 * HOW MANY, for the tab title: two fills of one post between two reads are
 * one row whose `said` grew by two — two fills, one tone. A row seen for the
 * first time counts one, whatever its `said`: its older copies may have
 * landed before this page was reading.
 *
 * NEVER ON THE FIRST READ. Everything on the feed when the page opened is what
 * the reader walked in on. And a fill first seen long after it happened is not
 * announced either: a reader that re-ranks its rows, or a deploy that changes
 * which rows it returns, would otherwise chime a dozen old trades at once. The
 * same age rule holds for a `said` that grew: a deploy that widened the feed's
 * window would grow every row's count at once.
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

/** What one read's news amounts to: the rows to chime for, and how many fills they are. */
export interface Arrivals {
  /** The rows with a new fill, oldest first. The chime plays once for them. */
  rows: Thesis[];
  /** How many fills those rows stand for — the tab title's count. */
  fills: number;
}

const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A landed row as it was last read. */
interface Last {
  at: number | null;
  said: number | null;
}

/**
 * How many fills joined a row since it was last read — 0 for none. See the
 * header: `at` advancing is at least one, `said` growing is as many as it grew.
 */
function joined(before: Last, at: number | null, said: number | null): number {
  const grew = said !== null && before.said !== null ? said - before.said : 0;
  if (at !== null && (before.at === null || at > before.at)) return Math.max(1, grew);
  return Math.max(0, grew);
}

export function createArrivals(opts: { freshSec?: number; cap?: number } = {}) {
  const freshSec = opts.freshSec ?? FRESH_SEC;
  const cap = opts.cap ?? 2_000;
  const last = new Map<string, Last>();
  let seeded = false;
  return {
    /**
     * The landed fills in this READ answer that were not in any before it.
     * Hand it only answers that were read: an unreadable one has no rows, and
     * the first readable one is the one that seeds.
     */
    take(theses: readonly Thesis[], nowSec: number): Arrivals {
      const rows: Thesis[] = [];
      let fills = 0;
      for (const t of theses) {
        if (!isLandedTrade(t)) continue;
        const id = t.postId as string;
        const at = finite(t.at);
        const said = finite(t.said);
        const before = last.get(id);
        // A row whose time went BACK is another grouping of this post, not a
        // fill; the row it was is what the next read is measured against.
        if (before && at !== null && before.at !== null && at < before.at) continue;
        const count = before ? joined(before, at, said) : 1;
        last.delete(id);
        last.set(id, { at, said });
        if (!seeded || count === 0) continue;
        const age = at === null ? null : nowSec - at;
        // A minute of clock skew either way, and no further.
        if (age !== null && age <= freshSec && age >= -60) {
          rows.push(t);
          fills += count;
        }
      }
      seeded = true;
      // The least recently read go first. A post forgotten and seen again is
      // long past fresh by the time the map has turned over, so it stays quiet.
      for (const id of last.keys()) {
        if (last.size <= cap) break;
        last.delete(id);
      }
      return { rows: rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)), fills };
    },
    size: () => last.size,
  };
}
