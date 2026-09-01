/**
 * WHO IS IN THIS TOKEN, AND WHAT DO THEY THINK.
 *
 * The reference product plots traders on a price chart because price is the
 * point there. Here the agents are the point, so this answers a different
 * question: which of them hold it, what it cost them, and what they said about
 * it. There is no trade panel on the page this feeds, now or later — the whole
 * product claim is that something else does the trading.
 *
 * THE BOOK IS OPT-IN, per agent. Publishing position sizes on a public URL is
 * the same disclosure /api/scoreboard refuses when hosted. An agent's WORDS are
 * public either way, so an agent that has not opted in still appears in the
 * theses list and simply does not appear in the position table — and the count
 * of who opted out is published, so the table can say "3 of 7 agents in this
 * token publish their book" instead of quietly showing a short list as though
 * it were the whole one.
 *
 * MARKET FACTS DO NOT COME FROM HERE. `discovered_pools` is worker-local and
 * never mirrored, so a hosted page reading it would render blank. The page
 * fetches /api/discoveries for price, depth and volume exactly as /tokens does.
 *
 * No session read. Same property as the other public readers.
 */
import { withReadDb } from "@/lib/ledger";
import { getIdentityStore } from "@merrymen/identity-store";
import { getSettingsStore } from "@merrymen/settings-store";

export interface TokenHolder {
  slug: string | null;
  name: string;
  handle: string | null;
  paper: boolean;
  valueUsdg: number;
  costUsdg: number | null;
  pnlBps: number | null;
  /** When this agent first bought it, unix seconds. Null when unknown. */
  enteredAt: number | null;
  /**
   * What it paid on that first buy, USD.
   *
   * The agents' own marks, and the only price axis this page can honestly
   * draw: there is no OHLC for a curve token anywhere in this repo, but a fill
   * is a price something actually traded at. Null when the fill carried none.
   */
  entryPriceUsd: number | null;
}

export interface TokenRead {
  symbol: string | null;
  holders: TokenHolder[];
  /** Agents holding it that do NOT publish their book. A count, never a list. */
  privateHolders: number;
}

/** Addresses are the URL key here, and they are matched case-insensitively. */
export const TOKEN_RE = /^0x[0-9a-fA-F]{6,64}$/;

export async function readToken(token: string): Promise<TokenRead> {
  const empty: TokenRead = { symbol: null, holders: [], privateHolders: 0 };
  if (!TOKEN_RE.test(token)) return empty;

  // slug + which tenants opted in, read once.
  const slugFor = new Map<string, string>();
  const tenantFor = new Map<string, `0x${string}`>();
  try {
    for (const id of await getIdentityStore().all()) {
      for (const a of id.accounts) {
        slugFor.set(a.toLowerCase(), id.slug);
        tenantFor.set(a.toLowerCase(), id.tenant);
      }
    }
  } catch {
    /* rows render unlinked */
  }

  const publicBook = new Map<string, boolean>();
  const store = (() => {
    try {
      return getSettingsStore();
    } catch {
      return null;
    }
  })();
  if (store) {
    for (const [account, tenant] of tenantFor) {
      try {
        const s = (await store.get(tenant)) as { publicBook?: boolean } | null;
        publicBook.set(account, s?.publicBook === true);
      } catch {
        publicBook.set(account, false); // fail closed
      }
    }
  }

  return withReadDb(async (db): Promise<TokenRead> => {
    if (!db) return empty;

    let rows: Record<string, unknown>[] = [];
    try {
      rows = (await db
        .prepare(
          `SELECT p.agent_id AS agent_id, p.symbol AS symbol, p.value_usdg AS value_usdg,
                  a.name AS name, a.x_handle AS x_handle, COALESCE(a.mode, 'idle') AS mode,
                  b.cost_usdg AS cost_usdg
             FROM positions p
             JOIN agents a ON a.smart_account = p.agent_id
             LEFT JOIN cost_basis b
               ON b.agent_id = p.agent_id AND b.symbol = p.symbol
              AND b.mode = CASE WHEN a.mode = 'paper' THEN 'paper' ELSE 'live' END
            WHERE LOWER(p.token) = ?
              AND a.mode IN ('live','paper')
              AND p.agent_id NOT LIKE 'rh:%'
            ORDER BY p.value_usdg DESC`,
        )
        .all(token.toLowerCase())) as Record<string, unknown>[];
    } catch {
      return empty;
    }

    const symbol = rows.length ? String(rows[0]!.symbol) : null;

    // WHEN EACH AGENT BOUGHT THIS TOKEN, and what it paid.
    //
    // This was a query per holder and it filtered on agent_id ALONE, with no
    // mention of the token — so it answered "when did this agent first buy
    // ANYTHING", and the timeline has been plotting the wrong instant for every
    // agent that had traded before. `buy_token` is the token acquired;
    // `target` beside it is the router, which is why the filter is not on that.
    //
    // Ordered earliest-first under the cap, so truncation can only drop LATER
    // trades and can never change the first entry this computes.
    const entry = new Map<string, { at: number; priceUsd: number | null }>();
    try {
      const fills = (await db
        .prepare(
          `SELECT agent_id, created_at, fill_price_usd
             FROM trades
            WHERE LOWER(buy_token) = ?
              AND status IN ('landed','paper')
              AND fill_side = 'buy'
            ORDER BY created_at ASC
            LIMIT 500`,
        )
        .all(token.toLowerCase())) as Record<string, unknown>[];
      for (const fill of fills) {
        const id = String(fill.agent_id);
        if (entry.has(id)) continue; // earliest wins, and it is already here
        const p = fill.fill_price_usd;
        entry.set(id, {
          at: Number(fill.created_at),
          priceUsd: p === null || p === undefined ? null : Number(p),
        });
      }
    } catch {
      /* fill_side and buy_token arrive with a worker migration */
    }

    const holders: TokenHolder[] = [];
    let privateHolders = 0;

    for (const r of rows) {
      const account = String(r.agent_id).toLowerCase();
      if (!publicBook.get(account)) {
        privateHolders += 1;
        continue;
      }
      const value = Number(r.value_usdg ?? 0);
      const cost = r.cost_usdg === null || r.cost_usdg === undefined ? null : Number(r.cost_usdg);

      const first = entry.get(String(r.agent_id)) ?? null;

      holders.push({
        slug: slugFor.get(account) ?? null,
        name: String(r.name ?? "Agent"),
        handle: (String(r.x_handle ?? "") || "").trim() || null,
        paper: r.mode === "paper",
        valueUsdg: value,
        costUsdg: cost,
        pnlBps: cost !== null && cost > 0 ? Math.round(((value - cost) / cost) * 10_000) : null,
        enteredAt: first?.at ?? null,
        entryPriceUsd: first?.priceUsd ?? null,
      });
    }

    return { symbol, holders, privateHolders };
  });
}
