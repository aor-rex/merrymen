/**
 * WHAT YOUR MERRYMAN LOOKS LIKE, from what it actually is.
 *
 * The 3D figure's trim is not a costume choice: it is the worker-reported
 * mode, mapped to a colour. Dressing that claims something the agent isn't
 * is worse than no dressing, so unknown (null — never beaten, or beating
 * unheard) renders dim, never as practice and never as live.
 */

export type FigureTrim = "live" | "paper" | "idle";
export type FigureShell = "default" | "trencher";

/** The worker's mode, or null when it has never said. Never null out. */
export function trimFor(mode: string | null | undefined): FigureTrim {
  if (mode === "live") return "live";
  if (mode === "paper") return "paper";
  return "idle";
}

export function trimHex(trim: FigureTrim): string {
  switch (trim) {
    case "live":
      return "#22c55e";
    case "paper":
      return "#b8f53d";
    case "idle":
      return "#52525b";
  }
}

/** Shell follows the running strategy, not a wardrobe. */
export function shellFor(strategy: string | null | undefined): FigureShell {
  return strategy !== null && strategy !== undefined && /trencher/i.test(strategy)
    ? "trencher"
    : "default";
}

/** Caption under the figure. Says the state, never decorates it. */
export function figureLabel(trim: FigureTrim): string {
  switch (trim) {
    case "live":
      return "trading for real";
    case "paper":
      return "practice money";
    case "idle":
      return "not running";
  }
}
