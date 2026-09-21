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
 *
 * ── THE SEAM ──────────────────────────────────────────────────────────────
 *
 * Every figure in the product now passes through this file, and every one of
 * them asks `displayLocale()` rather than naming a locale itself. Today that
 * answers "en-US" for everybody, so nothing on screen changes. That is the
 * point: the seam lands and is proved before it moves.
 *
 * It replaces about thirty hand-written formatters, and three of them were
 * wrong in ways that only show up outside `en-US`:
 *
 *   COMPACT NOTATION CANNOT BE A LOOKUP TABLE. `$1.2B` read on the long scale
 *   — German, Italian, Spanish, Dutch, European Portuguese — is 10^12, a
 *   thousandfold misreading with nothing to notice. And a table keyed on
 *   k/M/B cannot express what the right answer even is: Chinese, Japanese and
 *   Korean regroup at 10^8, so 1.234e9 is `12.3亿`, not "1.2 of anything".
 *   Verified across the shipped locales; `Intl` knows, a table cannot.
 *
 *   A HAND-WRITTEN SIGN LANDS IN THE WRONG PLACE. `${n > 0 ? "+" : ""}${n}%`
 *   is right in nine languages and wrong in Turkish, which writes the symbol
 *   before the number: `+%40,8`. `signDisplay` puts it where the language
 *   puts it.
 *
 *   THE CURRENCY SYMBOL IS NOT ALWAYS A PREFIX. `$${n}` is wrong for Spanish,
 *   Vietnamese, Russian and Indonesian, which suffix it, and for Brazilian
 *   Portuguese, which writes `US$ ` with a space.
 *
 * DIGITS STAY LATIN, and that is a typography constraint rather than a
 * preference. Geist Pixel is the face used for every balance in the product,
 * at 52-56px with a sub-1 line-height, and its `unicode-range` covers Latin
 * only. A locale that switched the digit SET would paint the account balance
 * in a fallback face inside a box laid out for a different one.
 */

const DASH = "—";

/**
 * The locale every figure in the product is rendered in.
 *
 * ONE ANSWER FOR THE WHOLE APP, deliberately. Before this, ten call sites
 * pinned "en-US" and one — the chat confirmation card, which is the last
 * sentence read before an order is placed — used `undefined`, which means the
 * browser's own locale. So a German owner already saw `$1.000` on the
 * confirmation card beside `$1,234.50` in the top bar: two number systems in
 * one viewport, on the screen where the number matters most.
 *
 * It is a function rather than a constant so that the day this starts
 * answering something else, no call site has to change.
 */
export function displayLocale(): string {
  return "en-US";
}

/**
 * `Intl` formatters are expensive to construct and these render inside tables
 * of twenty-five rows, so each distinct shape is built once.
 */
const cache = new Map<string, Intl.NumberFormat>();
function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = displayLocale();
  const key = `${locale}|${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    // `numberingSystem` rather than a `-u-nu-latn` subtag: the subtag makes
    // some locales emit a leading bidi mark, which is a format character in
    // text this product elsewhere refuses to accept.
    f = new Intl.NumberFormat(locale, { numberingSystem: "latn", ...options });
    cache.set(key, f);
  }
  return f;
}

const USD = { style: "currency", currency: "USD" } as const;

/**
 * $1.2B / $84K / $912 — never more precision than the number deserves.
 *
 * `minimumFractionDigits: 0` is not tidying. Naming a maximum on its own turns
 * off compact notation's own rounding and pins the minimum to it, so $912
 * renders as "$912.0" and $84K as "$84.0K" — a decimal place on figures that
 * have no business carrying one.
 */
export function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return nf({
    ...USD,
    notation: "compact",
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(n);
}

/** $324.98 — for anything quoted in whole dollars. */
export function usd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return nf({ ...USD, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
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
  if (n === 0) return nf({ ...USD, maximumFractionDigits: 0 }).format(0);
  // A minimum as well as a maximum, so 0.005 stays "$0.00500" rather than
  // collapsing to "$0.005". Three significant figures is the claim being made
  // about a sub-cent price; dropping the trailing zeros understates it.
  if (n < 0.01) {
    return nf({ ...USD, minimumSignificantDigits: 3, maximumSignificantDigits: 3 }).format(n);
  }
  return nf({ ...USD, minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(n);
}

/**
 * +40.8% / -2.2% / — . Signed, because an unsigned change is half a fact.
 *
 * The sign is `signDisplay`'s job and not a prefix we write ourselves: Turkish
 * writes the symbol first, so a hand-written "+" produces `+%40,8` — wrong in
 * both languages at once.
 */
export function pct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  const places = n >= 100 || n <= -100 ? 0 : 1;
  return nf({
    style: "percent",
    signDisplay: "exceptZero",
    minimumFractionDigits: places,
    maximumFractionDigits: places,
    // The value arrives as percentage POINTS, not a ratio.
  }).format(n / 100);
}

/** A sub-cent price, to three significant figures. */
export function subCentUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return nf({ ...USD, minimumSignificantDigits: 3, maximumSignificantDigits: 3 }).format(n);
}

/** A price to an exact number of decimal places. */
export function usdFixed(n: number | null, places: number): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return nf({ ...USD, minimumFractionDigits: places, maximumFractionDigits: places }).format(n);
}

/**
 * Money whose precision follows its size: cents while they matter, whole
 * dollars once they do not. $12.34, then $1,284.
 */
export function usdAdaptive(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return nf({ ...USD, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
}

/**
 * A short date and time, for a chart axis or a timestamp beside a figure.
 *
 * Here rather than at the call site because a date is the other half of the
 * same problem: `toLocaleString(undefined, …)` reads the browser's locale,
 * which is how a chart axis came to be labelled in one language beside a
 * balance rendered in another.
 */
const dtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(key: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const locale = displayLocale();
  const id = `${locale}|${key}`;
  let f = dtCache.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { numberingSystem: "latn", ...options });
    dtCache.set(id, f);
  }
  return f;
}

export function shortDateTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return DASH;
  return dtf("short", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** A day, without a year: "Mar 4". For a chart axis. */
export function dayLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return DASH;
  return dtf("day", { month: "short", day: "numeric" }).format(new Date(ms));
}

/** A clock time only, for a row in a trade tape. */
export function timeOnly(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return DASH;
  return dtf("time", { timeStyle: "medium" }).format(new Date(ms));
}

/** A full moment, for a tooltip or a row timestamp. */
export function fullDateTime(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return DASH;
  return dtf("full", { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

/**
 * The character this locale puts between a whole number and its fraction.
 *
 * For writing an EXAMPLE into a message — "for example 10 or 10,50". A hint
 * that shows a dot to someone whose keyboard has a comma is the original bug
 * wearing a helpful expression.
 */
export function decimalSeparator(): string {
  return nf({ minimumFractionDigits: 1 }).format(1.1).replace(/[0-9]/g, "");
}

/** A count, grouped. Null is an em dash, never 0. */
export function count(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  return nf({}).format(n);
}

/**
 * A percentage with a sign this product chose, rather than the one the locale
 * would have picked.
 *
 * `pctBps` renders negatives with U+2212 MINUS SIGN and not a hyphen, because
 * these fill a monospace grid where a hyphen is too short to read as a minus
 * at a glance. `Intl`'s own `signDisplay` would give the locale's sign, so the
 * number is formatted UNSIGNED and the house sign is prefixed.
 *
 * Prefixing is still correct in Turkish, where the percent symbol precedes the
 * number: unsigned gives `%12,3` and the result is `−%12,3`, sign first, which
 * is what Turkish writes. What must NOT happen is prefixing a sign to an
 * already-signed string, which is how `+%40,8` becomes `+%+40,8`.
 */
function signedPct(value: number, places: number, sign: string): string {
  const body = nf({
    style: "percent",
    signDisplay: "never",
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  }).format(Math.abs(value) / 100);
  return `${sign}${body}`;
}

/** A change in percentage POINTS, to two places. Signed. */
export function pctPts(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return DASH;
  const places = n >= 100 || n <= -100 ? 0 : 2;
  return signedPct(n, places, n > 0 ? "+" : n < 0 ? "-" : "");
}

/** A change in BASIS POINTS, to one place. Below half a tenth reads as flat. */
export function pctBps(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return DASH;
  const points = bps / 100;
  if (Math.abs(points) < 0.05) return signedPct(0, 1, "");
  return signedPct(points, 1, points > 0 ? "+" : "−");
}
