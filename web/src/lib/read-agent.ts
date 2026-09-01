/**
 * One agent, in public.
 *
 * Addressed by SLUG, never by smart account — the slug is stable across a
 * re-grant and the account is not, and the account is an address the
 * publication gate would refuse to print anyway.
 *
 * THIS IS WHERE cost_basis FINALLY REACHES A READER. The column has been
 * mirrored for a while and `grep cost_basis web/src` returned nothing: every
 * unrealised P&L figure and every "what did this cost" answer was computable
 * and uncomputed. A position without its entry is a number with no story.
 *
 * THE BOOK IS OPT-IN. Publishing per-agent position sizes on a public URL is
 * the same disclosure /api/scoreboard refuses when hosted, so an agent appears
 * here with its words always and its book only when its owner has said yes.
 * Whether it opted in is itself published, so the page can say "3 of 7 agents
 * in this token publish their book" rather than quietly showing a short list as
 * though it were the whole one.
 *
 * No session read. Same property as the other public readers, same reason.
 */
import { withReadDb } from "@/lib/ledger";
import { rankPnl, type UnrankedWhy } from "@/lib/rank-pnl";
import { getIdentityStore } from "@merrymen/identity-store";
import { getSettingsStore } from "@merrymen/settings-store";

export interface Holding {
  symbol: string;
  /** The token address, so the row can link to /t/<address>. */
  token: string | null;
  valueUsdg: number;
  /** What it cost. Null when there is no basis on record. */
  costUsdg: number | null;
  /** Unrealised, in bps. Null when the basis is unknown — never rendered as 0. */
  pnlBps: number | null;
  priceStale: boolean;
}

export interface AgentProfile {
  slug: string;
  name: string;
  handle: string | null;
  /** "live" | "paper" | "idle" */
  mode: string;
  strategy: string | null;
  /** The published return, or null. Exactly one of this and unrankedWhy is set. */
  pnlBps: number | null;
  /**
   * Why there is no return to show.
   *
   * Carried so the page can say WHICH refusal applies. It rendered "no deposit
   * on record" for both, which is a specific and wrong explanation on an agent
   * that had funded and simply never filled anything.
   */
  unrankedWhy: UnrankedWhy | null;
  maxDdBps: number | null;
  landed: number;
  refused: number;
  curve: number[];
  /** Empty when the owner has not opted in. `publicBook` says which it is. */
  holdings: Holding[];
  publicBook: boolean;
  /** Days since the grant was signed. */
  ridingDays: number | null;
}

export async function readAgent(slug: string): Promise<AgentProfile | null> {
  let identity;
  try {
    identity = await getIdentityStore().bySlug(slug);
  } catch {
    return null;
  }
  if (!identity) return null;

  // Every account this tenant has held: a re-grant must not split an agent's
  // history into two strangers.
  const accounts = identity.accounts.map((a) => a.toLowerCase());
  if (accounts.length === 0) return null;

  // The book is the OWNER's call, and the setting is per tenant.
  let publicBook = false;
  try {
    const s = (await getSettingsStore().get(identity.tenant)) as { publicBook?: boolean } | null;
    publicBook = s?.publicBook === true;
  } catch {
    /* fail closed: no setting readable means no book published */
  }

  return withReadDb(async (db): Promise<AgentProfile | null> => {
    if (!db) return null;
    const inList = accounts.map(() => "?").join(", ");

    let row:
      | { smart_account: string; name: string; x_handle: string | null; mode: string; epoch: number; granted_at: number }
      | undefined;
    try {
      row = (await db
        .prepare(
          `SELECT smart_account, name, x_handle, COALESCE(mode, 'idle') AS mode,
                  COALESCE(epoch, 1) AS epoch, granted_at
             FROM agents WHERE LOWER(smart_account) IN (${inList})
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(...accounts)) as typeof row;
    } catch {
      return null;
    }
    if (!row) return null;

    const account = row.smart_account;
    const epoch = Number(row.epoch ?? 1);

    let curve: number[] = [];
    let latest: number | null = null;
    try {
      const pts = (await db
        .prepare(
          `SELECT equity_usdg FROM (
             SELECT equity_usdg, at, id FROM equity WHERE agent_id = ? AND epoch = ?
              ORDER BY at DESC, id DESC LIMIT 500
           ) ORDER BY at ASC, id ASC`,
        )
        .all(account, epoch)) as { equity_usdg: number }[];
      const vals = pts.map((p) => Number(p.equity_usdg)).filter(Number.isFinite);
      latest = vals.length ? vals[vals.length - 1]! : null;
      const step = Math.max(1, Math.ceil(vals.length / 60));
      curve = vals.filter((_, i) => i % step === 0);
    } catch {
      /* no history */
    }

    let contributed: number | null = null;
    try {
      const f = (await db
        .prepare(
          `SELECT COUNT(*) AS n,
                  COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_usdg ELSE -amount_usdg END), 0) AS net
             FROM flows WHERE agent_id = ? AND epoch = ?`,
        )
        .get(account, epoch)) as { n: number; net: number } | undefined;
      contributed = !f || Number(f.n) === 0 ? null : Number(f.net);
    } catch {
      /* flows arrives with a worker migration */
    }

    let gasUsdg = 0;
    let landed = 0;
    let refused = 0;
    try {
      const t = (await db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN status = 'landed' THEN gas_usdg ELSE 0 END), 0) AS gas,
                  SUM(CASE WHEN status = 'landed' THEN 1 ELSE 0 END) AS landed,
                  SUM(CASE WHEN status IN ('rejected','reverted') THEN 1 ELSE 0 END) AS refused
             FROM trades WHERE agent_id = ? AND epoch = ?`,
        )
        .get(account, epoch)) as { gas: number; landed: number | null; refused: number | null } | undefined;
      gasUsdg = Number(t?.gas ?? 0);
      landed = Number(t?.landed ?? 0);
      refused = Number(t?.refused ?? 0);
    } catch {
      /* older ledger */
    }

    let strategy: string | null = null;
    try {
      const s = (await db
        .prepare(
          `SELECT strategy FROM decisions WHERE agent_id = ? AND strategy IS NOT NULL
            ORDER BY at DESC LIMIT 1`,
        )
        .get(account)) as { strategy: string } | undefined;
      strategy = s?.strategy?.replace(/^strategy:/, "") ?? null;
    } catch {
      /* no decisions yet */
    }

    let holdings: Holding[] = [];
    if (publicBook) {
      try {
        // The join that has never existed. `mode` partitions cost_basis, so a
        // paper agent's basis is not mixed into a live book.
        const rows = (await db
          .prepare(
            `SELECT p.symbol AS symbol, p.token AS token, p.value_usdg AS value_usdg,
                    p.price_stale AS price_stale, b.cost_usdg AS cost_usdg
               FROM positions p
               LEFT JOIN cost_basis b
                 ON b.agent_id = p.agent_id AND b.symbol = p.symbol AND b.mode = ?
              WHERE p.agent_id = ?
              ORDER BY p.value_usdg DESC`,
          )
          .all(row.mode === "paper" ? "paper" : "live", account)) as Record<string, unknown>[];
        holdings = rows.map((r) => {
          const value = Number(r.value_usdg ?? 0);
          const cost = r.cost_usdg === null || r.cost_usdg === undefined ? null : Number(r.cost_usdg);
          return {
            symbol: String(r.symbol),
            token: r.token ? String(r.token) : null,
            valueUsdg: value,
            costUsdg: cost,
            // Unknown basis means unknown return, not a flat one.
            pnlBps: cost !== null && cost > 0 ? Math.round(((value - cost) / cost) * 10_000) : null,
            priceStale: Number(r.price_stale ?? 0) === 1,
          };
        });
      } catch {
        /* cost_basis arrives with a worker migration */
      }
    }

    // THE SAME RULE THE LEADERBOARD USES, and it was missing here.
    //
    // This computed the identical arithmetic without the landed > 0 refusal, so
    // the profile published a return the board was correctly refusing to rank —
    // for the same agent, on the same data, at the same moment. The bug
    // rank-pnl exists to prevent shipped on the board and was fixed there;
    // every profile page went on making it.
    //
    // Its docstring records what that looks like: +2643.3%, from a flat
    // 1000.0000 paper opening balance divided by 36 USDG of real contributions,
    // by an agent with zero landed trades and 1,225 refusals.
    const { pnlBps, unrankedWhy } = rankPnl({ contributed, latest, gasUsdg, landed });

    const granted = Number(row.granted_at ?? 0);
    const ridingDays = granted > 0 ? Math.floor((Date.now() / 1000 - granted) / 86_400) : null;

    return {
      slug: identity.slug,
      name: String(row.name ?? "Agent"),
      handle: (row.x_handle ?? "").trim() || null,
      mode: String(row.mode ?? "idle"),
      strategy,
      pnlBps,
      unrankedWhy,
      maxDdBps: drawdownBps(curve),
      landed,
      refused,
      curve,
      holdings,
      publicBook,
      ridingDays,
    };
  });
}

function drawdownBps(curve: number[]): number | null {
  if (curve.length < 2) return null;
  let peak = curve[0]!;
  let worst = 0;
  for (const v of curve) {
    if (v > peak) peak = v;
    if (peak > 0) worst = Math.max(worst, (peak - v) / peak);
  }
  return Math.round(worst * 10_000);
}
