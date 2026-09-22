/**
 * WHAT THE TOKEN PAGE MAY SAY ABOUT WHO HOLDS IT, given where that read stands.
 *
 * The page kept an error string and a list, and nothing for "not answered yet"
 * — so for the whole of the fetch it printed "Agents holding 0" and "No public
 * agent holdings reported yet". Zero and empty are answers; a read in flight
 * has not given one. Out of Token.tsx so the decision can be executed: the
 * screen imports a chart library the test runner cannot load.
 */
export type HoldersRead = "loading" | "failed" | "ok";

/** The strip's "Agents holding" figure: a count only once one was read. */
export function holdersFigure(read: HoldersRead, count: number): string {
  return read === "ok" ? String(count) : "—";
}

/**
 * Which holders block to draw. A list that already has rows keeps them (the
 * read that produced them succeeded); otherwise emptiness is claimed only by a
 * read that answered, and a failure is its own state, said by the page.
 */
export function holdersList(read: HoldersRead, count: number): "loading" | "failed" | "empty" | "table" {
  if (count > 0) return "table";
  return read === "loading" ? "loading" : read === "failed" ? "failed" : "empty";
}
