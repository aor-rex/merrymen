/**
 * How long ago, in words.
 *
 * Lifted out of `Console.tsx` because there were already two copies and they
 * DISAGREE: the console's parses the ledger's timestamp as UTC by appending a
 * "Z"; `FeedPanel.tsx` omits it and therefore reads every timestamp as local
 * time, which silently shifts the whole panel by the viewer's offset. A third
 * hand-written copy was not going to be the one that got it right.
 *
 * This module takes EPOCH SECONDS rather than the formatted string, so the
 * question of which timezone a string is in never arises.
 */

/** Epoch seconds → "just now" / "4m ago" / "9h ago" / "3d ago". */
export function timeAgo(epochSec: number): string {
  if (!Number.isFinite(epochSec) || epochSec <= 0) return "";
  const secs = Math.floor(Date.now() / 1000) - Math.floor(epochSec);
  // A clock that disagrees with the server should not produce "in 4 minutes".
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
