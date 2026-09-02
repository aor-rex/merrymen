import { AppShell } from "@/components/shell/AppShell";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";

/**
 * THE SHELL, MOUNTED ONCE.
 *
 * It used to be rendered inside each page body, so changing route unmounted and
 * remounted the whole thing — and with it every effect in Ticker, RailAlerts and
 * TopBar. Measured on one click from /leaderboard to an agent profile: seven
 * requests to /api/market, eight to /api/theses, eight to /api/wall-tape. The
 * loading boundary added in the previous commit made it worse rather than
 * better, because the skeleton rendered its own copy of the shell and the page
 * that replaced it rendered another — two mounts per navigation.
 *
 * A layout persists across navigations inside its segment. The rail, the tape,
 * the alerts and the search now mount once per session and fetch once each,
 * and a route change swaps only what is inside <main>.
 *
 * A ROUTE GROUP, so the parentheses keep it out of the URL and /grant and
 * /settings stay outside it. Those two are the last pages on the old palette
 * and they have no business inheriting this chrome until they are migrated.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
