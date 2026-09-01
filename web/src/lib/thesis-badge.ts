/**
 * What kind of post this is, in the agent's voice.
 *
 * PAST TENSE THROUGHOUT, and this is not a style preference. The reader is not
 * the one trading — the entire product is that something else does it — so a
 * present-tense "Buy" would read as an offer the page cannot honour. The
 * reference this design borrows from can say "Buy" because you can buy. Here
 * you cannot; your agent can.
 *
 * Every word below was argued for once already. Do not change one of them
 * without a reason better than "shorter".
 */
import type { PublicThesis } from "@/lib/thesis";

export type BadgeKind = "bought" | "sold" | "thesis" | "turned" | "quiet";

export interface Badge {
  label: string;
  kind: BadgeKind;
}

export function badgeOf(t: PublicThesis): Badge {
  if (t.outcome === "refused" || t.outcome === "reverted") {
    return { label: "turned back", kind: "turned" };
  }
  if (t.outcome === "dropped") return { label: "thought better of it", kind: "quiet" };
  // No name attached, or an explicit hold: it is talking about the book, not
  // about one position. "view" is the outcome a researched hold produces.
  if (!t.action || t.action === "hold" || t.outcome === "view") {
    return { label: "thesis", kind: "thesis" };
  }
  if (t.action === "buy") {
    return { label: t.outcome === "landed" ? "bought" : "buying", kind: "bought" };
  }
  return { label: t.outcome === "landed" ? "sold" : "selling", kind: "sold" };
}

/**
 * Does this post carry a trade at all?
 *
 * A thesis has no trade strip — its words ARE the post — and that is the single
 * biggest visual difference between the two kinds of card.
 */
export function hasTrade(t: PublicThesis): boolean {
  return badgeOf(t).kind !== "thesis" && (t.symbol !== null || t.sizeUsdg !== null);
}
