/**
 * What this system is willing to fetch from a URL somebody else chose.
 *
 * ONE DEFINITION, THREE CALLERS. The image proxy wrote the first version of this
 * because a token's logo URI comes from a token contract, which makes it
 * attacker-chosen by construction. The research browser has exactly the same
 * hazard and worse consequences — it runs a real browser, on a box with private
 * network neighbours — so the guard moved here rather than being written twice.
 * Two copies of a security check are one copy and one liability.
 *
 * WHAT IT IS NOT. This is a guard, not a proof. A hostname that RESOLVES to a
 * private address is not caught: that needs the resolved IP before connect, and
 * `fetch` does not expose it. The other half of the answer is architectural —
 * the browser runs in its own service with nothing worth reaching, requests are
 * time- and size-capped, and nothing it returns is ever treated as instructions.
 */

/** Hosts that would make an outbound fetch a probe of our own infrastructure. */
const PRIVATE_V4 = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Cloud metadata endpoints, by address rather than by name.
 *
 * 169.254.169.254 is covered by the link-local range above, but it earns its own
 * mention: it is the single most valuable address to an attacker who can make
 * this system fetch a URL, because on most clouds it hands out credentials to
 * anything that asks.
 */
export const METADATA_HOSTS = ["169.254.169.254", "metadata.google.internal", "metadata"] as const;

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // Railway puts every service on `*.railway.internal`, so this is not
  // hypothetical here: the orchestrator, the database and the web service are
  // all reachable by name from the same network the browser sits on.
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if ((METADATA_HOSTS as readonly string[]).includes(h)) return true;
  if (PRIVATE_V4.test(h)) return true;
  // IPv6 loopback and the unique-local range, with or without brackets.
  const v6 = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  if (v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  return false;
}

/**
 * Is this a URL we will fetch at all?
 *
 * HTTPS ONLY, and plain http is refused rather than upgraded. The app is served
 * over https, so a mixed-content resource is blocked by the browser anyway —
 * fetching it server-side would launder that away instead of fixing it, and a
 * plaintext fetch is also the one an on-path attacker can rewrite.
 */
export function safeFetchUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (isPrivateHost(u.hostname)) return null;
  // Credentials in a URL are never something we want to send on someone's
  // behalf, and their presence usually means the URL was crafted.
  if (u.username || u.password) return null;
  return u;
}

/** True when the URL is one we are willing to fetch. */
export function isSafeFetchUrl(raw: string): boolean {
  return safeFetchUrl(raw) !== null;
}
