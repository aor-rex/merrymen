/**
 * FOUR PLACES. NOT SIX.
 *
 * At 375px four tabs are 93px each, which is comfortable. Five would be 75px,
 * and the old console's own comment records discovering that five tabs at that
 * width gave an unreadable label.
 *
 * The reference product's fifth pillar is Alerts — "real time notifications for
 * what the best are buying". Here that is the feed's Wired filter, which is the
 * same information and needs no push infrastructure. Real push sits on top of
 * the existing service worker later, and is not a reason to spend a tab now.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Matches this route and everything under it. */
  prefix?: string;
}

export const NAV: readonly NavItem[] = [
  { href: "/", label: "Feed" },
  { href: "/tokens", label: "Tokens", prefix: "/t" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/you", label: "You" },
] as const;

/** Which nav item owns this path. Exact for "/", prefix for the rest. */
export function activeHref(pathname: string): string {
  if (pathname === "/") return "/";
  for (const n of NAV) {
    if (n.href === "/") continue;
    if (pathname === n.href || pathname.startsWith(`${n.href}/`)) return n.href;
    if (n.prefix && pathname.startsWith(`${n.prefix}/`)) return n.href;
  }
  // An agent profile belongs to the feed: you got there from a post.
  if (pathname.startsWith("/a/")) return "/";
  return "/";
}
