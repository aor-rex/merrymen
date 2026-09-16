/**
 * A BASIS MAY NOT BE CLEARED WHILE THE FILL THAT MUST READ IT IS UNBOOKED.
 *
 * THE ORDER THE BOOK REQUIRES, and it is not negotiable:
 *
 *     read basis → compute realised → write realised → THEN consume the basis
 *
 * Never:
 *
 *     clear basis → try to compute realised
 *
 * WHAT WENT WRONG. A class sell lands, and the SAME function that sent it then
 * re-reads the book from chain — `reconcileClassFromChain`, called from the
 * class executor arm so the scout budget binds within a session. The vault is
 * now empty, so `restoreClassCostBasis` clears the position's basis as
 * stranded. Only afterwards does `bookFill` run, ~316 lines later, and finds
 * `{qtyRaw: 0n, costUsdg: 0n}`. `applyFill` correctly reports `basisUnknown`
 * for a sell with nothing on the books, and `realized_pnl_usdg` is written
 * `undefined`.
 *
 * So both halves were individually right and the ORDER was wrong. Every class
 * sell the fleet has ever made recorded `fill sell/receipt` with no realised
 * P&L beside it — deterministically, not as a race, which is why it was never
 * intermittent and never noticed.
 *
 * WHY THE CLEAR IS NOT SIMPLY REMOVED. It earns its place: a basis that
 * outlives its position is what a re-entry into the same token would start
 * from, so the next buy inherits a cost it never paid and the next sell reports
 * a loss that already happened. `class-basis-equity.test.ts` and
 * `custody.test.ts` both pin that clearing as correct. The fix is therefore an
 * ORDERING, not a removal: defer the clear past the fill that is about to
 * consume the basis anyway.
 *
 * DEFERRING COSTS NOTHING. `bookFill` reduces the basis to zero on a full exit
 * and `setBasis` deletes at zero, so the fill consumes it a moment later. If
 * the fill never books, the next tick's reconcile clears it exactly as before —
 * the guard is scoped to one pass over one token, never a standing exemption.
 */

/**
 * Tokens whose basis is spoken for by a fill this pass has not booked yet.
 *
 * An address set, lowercased on the way in. Addresses rather than symbols
 * because this is handed the intent's own asset leg, and a launch token's
 * symbol is chosen by its deployer — the same reason `instrumentClassOf` and
 * the position ceiling are address-keyed.
 */
export class PendingBasis {
  private readonly held = new Set<string>();

  /** Mark a token's basis as owed to a fill that has not been booked yet. */
  hold(token: string | null | undefined): void {
    if (token) this.held.add(token.toLowerCase());
  }

  /** Release it once the fill has booked — or failed to. */
  release(token: string | null | undefined): void {
    if (token) this.held.delete(token.toLowerCase());
  }

  /**
   * May a reconciliation clear this token's basis right now?
   *
   * FALSE means "not yet", never "not ever". The caller's next pass over the
   * same token clears it if the fill still has not arrived.
   */
  mayClear(token: string | null | undefined): boolean {
    if (!token) return true;
    return !this.held.has(token.toLowerCase());
  }

  /** For assertions and logging; the set is otherwise private. */
  get size(): number {
    return this.held.size;
  }
}

/**
 * The booking decision, lifted out of `bookFill` so it can be tested at all.
 *
 * `index.ts` has NO top-level exports — `bookFill` is a closure inside `main()`
 * and the booking sequence lives inside `processIntentLocked` — so every
 * existing test either re-implements the body by hand or matches the file as
 * source text with a regex. That is why a deterministic, always-on bug in this
 * exact expression survived: no test has ever executed it.
 *
 * Mirrors `bookFill`'s rule exactly: realised is written for a SELL whose basis
 * was fully backed, and left NULL for a buy (nothing realised) and for an
 * unbacked sell (cost unknown), so the realised sum only ever contains figures
 * the book can defend.
 */
export function realisedForFill(
  side: "buy" | "sell",
  basisUnknown: boolean,
  realizedUsdg: bigint,
): bigint | null {
  if (side !== "sell") return null;
  if (basisUnknown) return null;
  return realizedUsdg;
}
