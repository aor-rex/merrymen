/**
 * Hosted mode — the single switch that turns merrymen from a self-hosted
 * single-tenant tool into a multi-tenant service on a public URL.
 *
 * ONE FLAG, read from ONE place, because the two modes have OPPOSITE threat
 * models and every fund-safety decision downstream branches on which one is
 * true. Self-hosted: one user, one machine, the owner key is theirs and the
 * localhost host-guard is the whole perimeter. Hosted: many users on a public
 * domain, the server holds session keys for real accounts, and the perimeter
 * is wallet-native auth on every mutating route.
 *
 * Defaults to SELF-HOSTED (false) — the safe default, and what every existing
 * install already is. Hosted mode is opt-in via MERRYMEN_HOSTED, so no
 * self-hosted user can accidentally trip into the multi-tenant code paths.
 */
export function isHostedMode(): boolean {
  const v = (process.env.MERRYMEN_HOSTED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * The server secret that signs session cookies and challenge nonces.
 *
 * REQUIRED in hosted mode and returned as null otherwise. A missing secret in
 * hosted mode is a boot-time refusal, never a silent fallback to a default —
 * a predictable signing key is a forgeable session for every tenant.
 */
export function sessionSecret(): string | null {
  const s = process.env.MERRYMEN_SESSION_SECRET;
  if (typeof s === "string" && s.length >= 32) return s;
  return null;
}
