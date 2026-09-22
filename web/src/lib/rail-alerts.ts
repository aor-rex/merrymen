/**
 * WHAT THE ALERTS RAIL SHOWS: trades, and only trades.
 *
 * It showed the first eighteen posts of any kind, and on production seventeen
 * of them were holds — a Trencher's 30-second reviews and every quiet agent's
 * five-minute market check. The rail beside every page read as "nothing is
 * happening, repeatedly". Its model is fomo's Alerts column: who bought or sold
 * what. Views belong on the feed, where they have room to say why.
 *
 * A REFUSED TRADE IS STILL AN ALERT. The badge says "turned back" and the owner
 * learns what the wall did; filtering to landed trades would make a refusal
 * silent on the surface that is always on screen.
 *
 * In its own module because RailAlerts is a client component the test runner
 * cannot reach; the rule is here so it can be run rather than read.
 */
import type { PublicThesis } from "@/lib/thesis";

/** How many rows the rail has room for. */
export const RAIL_ALERTS = 18;

export function alertsOf<T extends Pick<PublicThesis, "action">>(theses: readonly T[]): T[] {
  return theses.filter((t) => t.action === "buy" || t.action === "sell").slice(0, RAIL_ALERTS);
}

/**
 * WHAT A ROW CALLS ITS COIN, and the id to put in the tooltip when that differs.
 *
 * `symbol` for a Trencher coin is `T` plus eleven hex of its contract, and the
 * rail printed exactly that. The name is what a reader can use; the id is kept
 * one hover away for whoever is reconciling against the ledger.
 */
export function coinName(t: Pick<PublicThesis, "symbol" | "displayName">): { shown: string; id: string | null } | null {
  if (!t.symbol) return null;
  const name = (t.displayName ?? "").trim();
  return name && name !== t.symbol ? { shown: name, id: t.symbol } : { shown: t.symbol, id: null };
}

/**
 * WHETHER THE READ HAPPENED, apart from what it returned. `source: "none"` is
 * the reader saying it could not open the ledger — an empty list from it is not
 * a quiet fleet, and the rail must not say "no trades" off it.
 */
export function alertsRead(body: { source?: string } | null | undefined): "ok" | "unreadable" {
  return body == null || body.source === "none" ? "unreadable" : "ok";
}
