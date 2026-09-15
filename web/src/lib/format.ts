/**
 * Money, as figures a reader can compare at a glance.
 *
 * Pure and dependency-free, and here rather than beside a component because a
 * SERVER component needs them: the token page renders its stat strip on the
 * server, and importing a helper out of a "use client" module to do it would
 * drag that module into the browser bundle to fetch three lines of arithmetic.
 *
 * EVERY ONE RETURNS AN EM DASH FOR NULL, and that is load-bearing rather than
 * cosmetic. These fill a monospace grid, and a null rendered as 0 is a claim
 * that a thing was measured and found to be nothing.
 */

const DASH = "—";

/** $1.2M / $84k / $912 — never more precision than the number deserves. */
export function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
}

/** $324.98 — for anything quoted in whole dollars. */
export function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * A coin price, which spans about twelve orders of magnitude on this chain.
 *
 * Significant figures below a cent, fixed places above it: $0.0000 for a coin
 * that genuinely trades at 2.8e-6 is the same failure as rendering a null as
 * zero — a real number displayed as nothing.
 */
export function coinPrice(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toPrecision(3)}`;
  return `$${n.toFixed(4)}`;
}

/** +40.8% / -2.2% / — . Signed, because an unsigned change is half a fact. */
export function pct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return `${n > 0 ? "+" : ""}${n.toFixed(n >= 100 || n <= -100 ? 0 : 1)}%`;
}

/** A count, grouped. Null is an em dash, never 0. */
export function count(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return n.toLocaleString("en-US");
}
