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

      // When it first bought in — the x-axis of the entry timeline.
      let enteredAt: number | null = null;
      try {
        const t = (await db
          .prepare(
            `SELECT MIN(created_at) AS at FROM trades
              WHERE agent_id = ? AND status IN ('landed','paper') AND fill_side = 'buy'`,
          )
          .get(String(r.agent_id))) as { at: number | null } | undefined;
        enteredAt = t?.at ? Number(t.at) : null;
      } catch {
        /* fill_side arrives with a worker migration */
      }

      holders.push({
        slug: slugFor.get(account) ?? null,
        name: String(r.name ?? "Agent"),
        handle: (String(r.x_handle ?? "") || "").trim() || null,
        paper: r.mode === "paper",
        valueUsdg: value,
        costUsdg: cost,
        pnlBps: cost !== null && cost > 0 ? Math.round(((value - cost) / cost) * 10_000) : null,
        enteredAt,
      });
    }

    return { symbol, holders, privateHolders };
  });
}
