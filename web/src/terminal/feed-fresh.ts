/**
 * WHICH ROWS THE PAGE HAS NOT SHOWN BEFORE — what the feed's slide-in is drawn
 * from.
 *
 * Possible only since beats are keyed on `postId` (beat.ts, contract C2): with
 * `at` in the key every row was "new" on every refresh. Now a key the page has
 * not seen is a post it has not shown.
 *
 * MODULE-LEVEL, NOT COMPONENT STATE, on purpose. Switching tabs unmounts the
 * Feed; component state would forget everything and coming back would slide in
 * the whole page. The set outlives the component, so only what arrived while
 * the reader was away moves.
 *
 * THE FIRST READ IS NOT NEWS. The first non-empty set of keys primes the set
 * and nothing slides in — a page arriving is not forty posts arriving. An
 * empty first read (unread, unreadable, a quiet window) does not prime, so the
 * first real rows are still treated as the page.
 *
 * READING NEVER MARKS. `freshAmong` is pure over the set, and only `markSeen`
 * — called after commit — changes it. A render React discards, or StrictMode's
 * second render, must see the same answer as the one that paints; marking
 * during render would make the second render see nothing new, and a row would
 * never animate in development.
 *
 * Presentation state, per viewer and per page load. Nothing here is stored,
 * sent, or read by anything but the row's class.
 */
import type { Beat } from "./beat";

const seen = new Set<string>();
let primed = false;

/** A long session is bounded: past this, the set restarts from the current page. */
const SEEN_MAX = 5_000;

/** The keys in `keys` the page has not shown before. Pure: changes nothing. */
export function freshAmong(keys: readonly string[]): ReadonlySet<string> {
  if (!primed) return new Set();
  return new Set(keys.filter((k) => !seen.has(k)));
}

/** The page has now shown these. Called after the render that drew them commits. */
export function markSeen(keys: readonly string[]): void {
  if (keys.length === 0) return;
  if (seen.size + keys.length > SEEN_MAX) seen.clear();
  for (const k of keys) seen.add(k);
  primed = true;
}

/**
 * WHETHER A ROW ON SCREEN IS NEW. A post is new by its own key. A summary — a
 * watch line or a chorus — is not a post and has no key of its own worth
 * diffing (its id is the agent or the crowd, which is always "seen"), so it is
 * new when the member it leads with is: a fresh hold that joined a watch line
 * moves the line, exactly as it would have moved its own row.
 */
export function isFresh(beat: Beat, fresh: ReadonlySet<string> | undefined): boolean {
  if (!fresh || fresh.size === 0) return false;
  if (fresh.has(beat.id)) return true;
  return (beat.kind === "watch" || beat.kind === "chorus") && fresh.has(beat.latest.id);
}

/** Tests only: a fresh page load. */
export function forgetSeenForTest(): void {
  seen.clear();
  primed = false;
}
