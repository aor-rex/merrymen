/**
 * THE "NOT YET" DOOR.
 *
 * app.merrymen.dev is being worked on in the open, and the owner wants a
 * passer-by to be told that rather than shown a half-finished terminal. This is
 * that notice, with a shared password behind it.
 *
 * IT IS A DOORKNOB, NOT A LOCK, and the difference matters because someone will
 * eventually be tempted to put something real behind it. It stops a casual
 * visitor and a search crawler. It is not authentication: there is one password
 * for everyone, it is checked in the edge runtime with no session, and the
 * things on this deployment that actually move money are protected by the
 * signed-session checks in each route handler — which this does not touch and
 * must not be confused with.
 *
 * THE PASSWORD IS NOT IN THIS REPOSITORY. It comes from the environment, so it
 * can be changed or removed without a deploy of new code, and so that a public
 * git history never carries it. Unset means no gate at all, which is what keeps
 * local development and every self-hosted install working exactly as before.
 */

export const GATE_COOKIE = "mm_gate";

/** The one route that may set the cookie, and the page that asks for it. */
export const GATE_PATH = "/gate";
export const GATE_API = "/api/gate";

/** The configured password, or null when the gate is off. */
export function gatePassword(): string | null {
  const raw = (process.env.MERRYMEN_SITE_PASSWORD ?? "").trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Compare without leaking length or position through timing.
 *
 * Overkill for a shared notice password, and cheap enough that arguing about it
 * costs more than doing it.
 */
export function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Whether a path is behind the notice.
 *
 * THE API IS GATED TOO, and the first version of this file was wrong about why
 * it could not be. It claimed Telegram posts webhooks to /api/telegram — that
 * route is a dashboard status endpoint the BROWSER calls, which reaches out to
 * the Bot API rather than receiving from it. Checked properly, nothing outside
 * a browser calls this deployment: no worker, orchestrator, cli or gateway code
 * fetches it, /api/bundler is built from window.location.origin, and no
 * healthcheck path is configured. A visitor who is through the door carries the
 * cookie on same-origin requests, so the product keeps working for them.
 *
 * That is worth the change because the API was the whole disclosure. With the
 * pages behind a password and the API open, forty posts of agent reasoning and
 * every agent name were still readable by anyone who knew the URLs.
 *
 * TWO THINGS STAY OPEN. /api/gate, or the password could never be handed in;
 * and the framework's own assets, or the notice itself renders unstyled.
 */
export function isGatedPath(pathname: string): boolean {
  if (pathname === GATE_API) return false;
  if (pathname.startsWith("/api/")) return true;
  if (pathname.startsWith("/_next/")) return false;
  if (pathname === GATE_PATH) return false;
  // Files served straight out of public/: icons, the manifest, the service
  // worker, the atmosphere images. Anything with an extension.
  if (/\.[a-z0-9]+$/i.test(pathname)) return false;
  return true;
}
