/**
 * WHICH CLASS ROWS ARE A POSITION THE AGENT IS ACTUALLY IN.
 *
 * ONE PLACE, because the alternative is what shipped. `class_positions` is a
 * LEDGER — it records every token the vault has ever held, in every state — and
 * "how many positions am I in" is a question about a subset of it. With no
 * shared answer, each caller invented one: index.ts:1607 filtered to
 * `open || recovered`, the equity book filtered the cash token out by address,
 * and the position ceiling filtered nothing at all and counted the lot.
 *
 * WHAT THE CEILING COST. `proposeClassEntries` compared `classMaxPositions`
 * against every row ever written, so a completed round trip occupied a slot for
 * ever and nothing deleted it. Shogun reached 3 of 3 holding NOTHING: one
 * closed round trip, one swept token, and a row for USDG. The gate is below the
 * funnel and logs nothing, so the agent printed a healthy scan every tick and
 * silently never bought.
 *
 * TWO INDEPENDENT TESTS, and they are not the same test.
 *
 *   STATE   — is this position still standing? `closed` and `swept` are over.
 *   IDENTITY— is this row a class TOKEN at all, or the vault's own cash?
 *
 * A row can fail either. The cash row failed only the second: its state is
 * `recovered`, which is a perfectly good standing state for a real token that
 * the tape could not explain — so a state filter alone would have kept it, and
 * an identity filter alone would have kept the closed round trip.
 *
 * ADDRESS-KEYED, NEVER SYMBOL-KEYED. `tokens.ts` makes this argument already
 * and it applies with full force here: a launch token's symbol is chosen by its
 * deployer and can be "USDG". An identity test that trusted a string would let
 * an attacker mint a token that excludes itself from the ceiling.
 */
import { CASH } from "../../packages/core/src/index";

/** The shape this module needs. Anything with these three fields qualifies. */
export interface ClassRowLike {
  token: string;
  quoteToken: string | null;
  state: string | null;
}

/**
 * Is the agent still in this position?
 *
 * `recovered` counts. It means the token is HELD and the tape did not explain
 * how it got there — an unknown basis, not an absent asset — and money the
 * agent cannot account for still occupies a slot it must not be able to
 * double-spend. `closed` and `swept` do not: one was sold, the other was taken
 * out of the vault, and neither leaves anything to sell.
 */
export function isActiveClassState(state: string | null): boolean {
  return state === "open" || state === "recovered";
}

/**
 * Is this row the vault's CASH rather than a position?
 *
 * Two independent proofs, because they cover different failures:
 *
 *   token === the chain's USDG   catches a row whose `quote_token` was never
 *                                written — which is exactly the shape the
 *                                phantom had, since it has no curve to read a
 *                                pair token from.
 *   token === its own quoteToken catches the same fact recorded the other way,
 *                                and keeps working if the quote asset is ever
 *                                something other than USDG.
 *
 * Neither can match a real launch token: a memecoin's address is not the USDG
 * contract, and a curve does not quote a token in itself.
 */
export function isQuoteTokenRow(r: ClassRowLike): boolean {
  const t = r.token.toLowerCase();
  if (t === CASH.USDG.toLowerCase()) return true;
  if (r.quoteToken !== null && t === r.quoteToken.toLowerCase()) return true;
  return false;
}

/**
 * The positions the agent is actually in — what a ceiling counts.
 *
 * Deliberately NOT what `alreadyHeld` uses. That set exists to stop the agent
 * re-entering a token it has already traded, and for that question the history
 * IS the answer; narrowing it here would quietly turn "never buy this twice"
 * into "buy it again as soon as you have sold it", which is a trading change
 * nobody asked for and the worst possible one to make by accident.
 */
export function activeClassPositions<T extends ClassRowLike>(rows: readonly T[]): T[] {
  return rows.filter((r) => isActiveClassState(r.state) && !isQuoteTokenRow(r));
}

/**
 * Does `classMaxPositions` shut the entry route right now?
 *
 * THE DECISION ITSELF, not the ingredients, so a test can assert on what the
 * agent actually does rather than on a count it then compares somewhere else.
 * The comparison lived inline in `proposeClassEntries`, which is a closure in a
 * ten-thousand-line file, and that is why the wrong operand went unnoticed.
 *
 * Zero or negative means NO CEILING — matching the gate's own
 * `cfg.classMaxPositions > 0` guard, which exists because an unset ceiling must
 * not read as "no positions allowed".
 */
export function ceilingBlocks(rows: readonly ClassRowLike[], classMaxPositions: number): boolean {
  if (classMaxPositions <= 0) return false;
  return activeClassPositions(rows).length >= classMaxPositions;
}

/**
 * What the ceiling counted, for the operator, in one line.
 *
 * The counted set rather than just its size: "3/3" invites the reading that
 * three positions are open, which was false for every hour Shogun spent stuck.
 * Naming the tokens and their states is what makes the difference between a
 * full book and a jammed one visible without opening a database.
 */
export function describeCeiling<T extends ClassRowLike & { symbol?: string | null }>(
  rows: readonly T[],
  ceiling: number,
): string {
  const act = activeClassPositions(rows);
  const name = (r: T) => `${r.symbol ?? r.token.slice(0, 10)}(${r.state ?? "?"})`;
  const counted = act.length === 0 ? "none" : act.map(name).join(", ");
  const skipped = rows.length - act.length;
  return (
    `class positions ${act.length}/${ceiling} — counted: ${counted}` +
    (skipped > 0 ? ` · ${skipped} ledger row(s) not counted (closed, swept or cash)` : "")
  );
}
