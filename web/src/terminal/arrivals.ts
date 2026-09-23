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
 * A FILL, NOT A POST: each of a post's landed rows is remembered as it was last
 * read — its `at` and its `said`, measured against its own last reading and
 * never another row's (see `measure`) — and it is news when either says a copy
 * joined.
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
 * It is compared with the row's last reading, and only its growth counts. A
 * row whose `at` went back is some other grouping of the same post, not a fill,
 * and the row it was stays remembered beside it. A post with no id (an agent
 * with no public slug) cannot be told apart from itself across reads, and is
 * never counted.
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

/** One read's landed rows of one post, each under its own `at`. */
type Rows = Map<number, { said: number | null; row: Thesis }>;

/** A post as it was last read. */
interface Seen {
  /** Each row's `said` as it was last read, by the row's `at` — kept while the row is off the read. */
  rows: Map<number, number | null>;
  /** The rows the last read of the post showed. */
  shown: Set<number>;
}

/** How many rows of one post are remembered: far more than one read shows. */
const ROWS_KEPT = 64;

/**
 * ONE POST, SEVERAL ROWS (R3L-1). The feed groups by size as well as words,
 * and a private book publishes no size, so the post id — which hashes the
 * published size — is one id over every size: a steady-basket leg clamped by
 * cash or the day's headroom lands in a second row under the same id. So a
 * read's landed rows are gathered by post, each under its own `at`. A row with
 * no `at` has no age to be announced by, and is left out.
 */
function byPost(theses: readonly Thesis[]): Map<string, Rows> {
  const out = new Map<string, Rows>();
  for (const t of theses) {
    const at = finite(t.at);
    if (!isLandedTrade(t) || at === null) continue;
    const said = finite(t.said);
    const rows: Rows = out.get(t.postId as string) ?? new Map();
    out.set(t.postId as string, rows);
    const had = rows.get(at);
    // Two rows of one post in the same second are read as one.
    rows.set(at, had ? { said: had.said === null || said === null ? null : had.said + said, row: had.row } : { said, row: t });
  }
  return out;
}

/**
 * EACH ROW AGAINST ITS OWN LAST READING (R4W-1), never against another row or
 * the post's total. The action lane serves only its newest rows
 * (read-theses.ts SHOW), so an older row of a post falls off the read whenever
 * other activity pushes it past the bound — another agent's order in flight is
 * enough — and comes back with every copy it always had. Folded into one
 * total, that return counted as fills that never happened.
 *
 * A row read before is measured against what it said then. A row under an
 * `at` never read is one of three things:
 *
 *   NEWER THAN EVERY ROW THE LAST READ SHOWED — a copy decided after all of
 *   them landed, so at least one fill. When it is the only such row and the
 *   last read's newest row has left, it is that row moved on, and it counts
 *   its growth.
 *   OLDER, and a row of the last read has left it BELOW this one and none
 *   above — an order that landed late into an older row, moving its `at` up
 *   past its old one: one fill.
 *   ANYTHING ELSE — a row whose `at` went back (another grouping of the post),
 *   or one the bound kept off the last read: not a fill.
 */
function measure(seen: Seen, read: Rows): Map<number, number> {
  const top = Math.max(...seen.shown);
  const gone = [...seen.shown].filter((at) => !read.has(at));
  const newer = [...read.keys()].filter((at) => !seen.rows.has(at) && at > top);
  const out = new Map<number, number>();
  for (const [at, { said }] of read) {
    const was = seen.rows.get(at);
    if (was !== undefined) out.set(at, joined({ at, said: was }, at, said));
    else if (at > top) out.set(at, newer.length === 1 && gone.includes(top) ? joined({ at: top, said: seen.rows.get(top) ?? null }, at, said) : 1);
    else out.set(at, gone.some((g) => g < at) && !gone.some((g) => g > at) ? 1 : 0);
  }
  return out;
}

export function createArrivals(opts: { freshSec?: number; cap?: number } = {}) {
  const freshSec = opts.freshSec ?? FRESH_SEC;
  const cap = opts.cap ?? 2_000;
  const last = new Map<string, Seen>();
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
      for (const [id, read] of byPost(theses)) {
        const seen = last.get(id);
        const newest = Math.max(...read.keys());
        // A post seen for the first time is one fill, on its newest row.
        const counts = seen ? measure(seen, read) : new Map([[newest, 1]]);
        const kept = seen?.rows ?? new Map<number, number | null>();
        for (const [at, { said }] of read) kept.set(at, said);
        for (const at of [...kept.keys()].sort((x, y) => x - y)) {
          if (kept.size <= ROWS_KEPT) break;
          if (!read.has(at)) kept.delete(at);
        }
        last.delete(id);
        last.set(id, { rows: kept, shown: new Set(read.keys()) });
        if (!seeded) continue;
        for (const [at, count] of counts) {
          const age = nowSec - at;
          // A minute of clock skew either way, and no further.
          if (count > 0 && age <= freshSec && age >= -60) {
            rows.push(read.get(at)!.row);
            fills += count;
          }
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
