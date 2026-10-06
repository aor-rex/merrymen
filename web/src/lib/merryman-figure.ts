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

/**
 * DRESS, and what it is allowed to change: the body colour only. Trim glow,
 * fins and ring stay state-driven — a shell can never dress an idle agent as
 * a live one. Unknown stored values fall back to spectre, never blank.
 */
export type FigureColorway = "spectre" | "aurum" | "glacier";

export const COLORWAYS: readonly FigureColorway[] = ["spectre", "aurum", "glacier"];

/** Body colour per shell. Spectre is the house black. */
export function colorwayHex(colorway: FigureColorway): string {
  switch (colorway) {
    case "spectre":
      return "#2b3542";
    case "aurum":
      return "#4a3d22";
    case "glacier":
      return "#31445a";
  }
}

/** Read back a stored shell choice. Anything unrecognised is spectre. */
export function colorwayFromStored(stored: string | null | undefined): FigureColorway {
  return stored === "aurum" || stored === "glacier" || stored === "spectre"
    ? stored
    : "spectre";
}

/** localStorage key for one agent's shell. Slug may be unknown pre-claim. */
export function colorwayKey(slug: string | null | undefined): string {
  return `merryman-shell:${slug ?? "unclaimed"}`;
}

/**
 * KIND: which figurine the owner picked — memoji-style, the head is the
 * character. Kind is pure dress like paint: it never touches trim, fins or
 * ring. Unknown stored values fall back to robot, never blank.
 */
export type FigureKind = "robot" | "fox" | "wolf" | "deer";

export const KINDS: readonly FigureKind[] = ["robot", "fox", "wolf", "deer"];

/** Emoji for the kind picker. Emoji only — no words to translate. */
export function kindEmoji(kind: FigureKind): string {
  switch (kind) {
    case "robot":
      return "🤖";
    case "fox":
      return "🦊";
    case "wolf":
      return "🐺";
    case "deer":
      return "🦌";
  }
}

/** Read back a stored kind choice. Anything unrecognised is robot. */
export function kindFromStored(stored: string | null | undefined): FigureKind {
  return stored === "fox" || stored === "wolf" || stored === "deer" || stored === "robot"
    ? stored
    : "robot";
}

/** localStorage key for one agent's kind. */
export function kindKey(slug: string | null | undefined): string {
  return `merryman-kind:${slug ?? "unclaimed"}`;
}
