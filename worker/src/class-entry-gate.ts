/**
 * THE CLASS ROUTE'S ENTRY GATE, AND WHAT IT SAYS WHEN IT CLOSES.
 *
 * Under a tripped breaker the tick stops asking the class route for entries:
 * every one would be a buy the wall refuses, and the exits are never withheld.
 * That gate said nothing. The strategy's own breaker reason is raised only by
 * a strategy that has legs to buy (steady-basket reports it only when
 * `legs.length > 0`), so an agent whose class route is the buyer and whose
 * strategy has no legs — Crypto only over an equities basket, with a Pons vault
 * sealed in — went silent under the breaker with no reason on any surface: the
 * exact symptom the idle channel's breaker warning exists to end.
 *
 * So the gate decides both halves in one place: whether class entries are
 * proposed this tick, and the idle reason the tick hands the owner. When the
 * breaker is what closed a route that would have looked, and the strategy gave
 * no reason of its own, the reason is the breaker's — the same Why, so it rides
 * the same once-per-change warning (idle-notice.ts) and never becomes a post.
 */
import type { AssetMode } from "../../packages/core/src/index";
import type { Why } from "./strategies/reasons";
import { breakerIdle, breakerTripped, type Snapshot } from "./strategies/types";

/**
 * Would the class route look for an entry at all? The same first gates
 * proposeClassEntries returns NO_CLASS on (index.ts), from the same inputs, so
 * the idle reason does not claim a route the proposer would not have run.
 * Paper cannot simulate a class fill; stocks-only excludes a route whose every
 * entry is a launchpad coin; and without a vault sealed into the signature
 * there is no route. The switch and the size are NOT here: those say do not
 * buy, not do not look, and the breaker is still why nothing is bought.
 */
export function classRouteLooks(s: { paper: boolean; assetMode: AssetMode; vault: string | null | undefined }): boolean {
  return !s.paper && s.assetMode !== "stocks" && !!s.vault;
}

export function classEntryGate(input: {
  snap: Pick<Snapshot, "drawdown">;
  /** classRouteLooks, for this tick. */
  routeLooks: boolean;
  /** The strategy's own idle reason, if it gave one. */
  idle: Why | null | undefined;
}): { propose: boolean; idle: Why | null | undefined } {
  if (!breakerTripped(input.snap)) return { propose: true, idle: input.idle };
  // A strategy's own reason wins: every built-in one already puts the breaker
  // first when it has legs, and a reason it chose is not ours to replace.
  return { propose: false, idle: input.idle ?? (input.routeLooks ? breakerIdle(input.snap) : undefined) };
}
