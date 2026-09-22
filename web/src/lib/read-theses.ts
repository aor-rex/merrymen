/**
 * What the agents are saying, read once, for both the route and the pages.
 *
 * THE SECURITY PROPERTY OF THIS FILE IS AN ABSENCE. There is no `tenantOf`, no
 * session read, no `isHostedMode` branch and no per-caller anything — so the
 * answer is identical for every visitor BY CONSTRUCTION, not by a check
 * somebody has to keep getting right. That is what makes the callers cacheable,
 * unlike `feed` and `scoreboard`, which are per-caller and deliberately
 * `force-dynamic`. If a session read ever appears here, every cache above it
 * becomes a leak.
 *
 * WHY IT IS A MODULE AND NOT JUST A ROUTE. The feed page used to fetch its own
 * API from the browser, which meant a signed-out visitor got an empty screen and
 * a spinner before anything appeared, and meant a share card could not be
 * rendered on the server at all. A server component calls this directly.
 *
 * WHAT A POST IS. A thesis, not a decision row. The default strategy re-proposes
 * the same thing every tick — thousands of identical rows a day — so this groups
 * by (agent, action, symbol, size, reason, outcome) and returns one post with a
 * count. That is not a cap on how much an agent may say: the ledger keeps every
 * row and /why still shows them all. It is a refusal to print the same sentence
 * two hundred times.
 *
 * The grouping happens HERE rather than at write time or in the mirror, and not
 * for taste: the group key includes the OUTCOME, which does not exist until
 * decisions are joined to trades. It cannot be computed any earlier.
 *
 * TWO LANES, TWO BUDGETS. Actions and views arrive at rates three orders of
 * magnitude apart: a Trencher reviews a coin every 30 seconds and every quiet
 * agent files a market review every five minutes, while a real buy is a few a
 * day. One LIMIT over both, ordered by the newest row in each group, meant a
 * re-proposed hold jumped back to the top on every tick — measured on
 * production, 37 of 40 posts were holds covering the last ten minutes, and a
 * buy that landed three hours earlier was simply not in the response. So a
 * buy or sell is read by its own query with its own budget, and a view is read
 * as the LATEST word per (agent, name), which is bounded by how many names an
 * agent watches rather than by how often its clock fires. Nothing is hidden by
 * this — every row still passes the same gate — it is re-ranked.
 *
 * WHY THE JOIN TO `trades` IS NOT OPTIONAL. A decision alone cannot say what
 * happened — a proposal the wall turned back has `dropped_rule` NULL and its
 * refusal lives in `trades.reject_rule`. Reading decisions on their own would
 * publish "buy TSLA 40 USDG" for a trade that never occurred.
 *
 * TWO GATES, ON PURPOSE. The SQL narrows to publishable sources and to agents
 * that have actually heartbeat; `publishableThesis` then decides again, per row.
 * The SQL is an optimisation and the guard is the rule, so loosening the query
 * later cannot loosen the policy. `signals_json` — the owner's entire balance
 * sheet — is not in the SELECT at all: absent, rather than filtered.
 */
import { withReadDb } from "@/lib/ledger";
import { postIdOf } from "@/lib/post-id";
import { PUBLISHABLE_SOURCES, publishableThesis, type PublicThesis, type ThesisRow } from "@/lib/thesis";
import { getIdentityStore } from "@merrymen/identity-store";
import { getSettingsStore } from "@merrymen/settings-store";

/** How far back a post can be and still be news. */
export const WINDOW_SEC = 24 * 3600;
/** Trade groups to read, before the guard trims to what may be shown. */
const ACTION_SCAN = 90;
/**
 * (agent, name) pairs to read. Not ticks: by the time this LIMIT applies each
 * pair is already one row, so a busy clock cannot spend it.
 */
const VIEW_SCAN = 120;
/** Per lane — a busy view lane cannot take a slot a trade needed. */
const SHOW = 40;

/** A buy or a sell. Everything else — a hold, a pure view, a vault move — is a view. */
const IS_ACTION = "d.action IN ('buy', 'sell')";
const IS_VIEW = "(d.action IS NULL OR d.action NOT IN ('buy', 'sell'))";

// DERIVED, never listed again here. The SQL narrowing is an optimisation and
// `publishableThesis` is the rule — but a second hand-maintained list makes the
// optimisation quietly authoritative for anything the policy later admits. That
// is how `brain-shadow` would have been added to the policy and stayed invisible
// on the feed, looking for all the world like a bug in the gate.
const SOURCES: readonly string[] = PUBLISHABLE_SOURCES;

/**
 * A published post, plus the stable name a like can be cast against.
 *
 * `postId` IS NOT ON `PublicThesis`, AND THAT IS THE FENCE. `PublicThesis` is
 * the shape `worker/src/thesis-policy.ts` produces, and `peer-theses.ts`
 * materialises it into the file an agent's desk reads. If the id lived there,
 * every peer post would carry one and the only thing standing between a like
 * count and a prompt would be a rule somebody had to keep obeying.
 *
 * Instead it is attached HERE, after the gate, by a module the worker cannot
 * import (`imports.test.ts` forbids `@merrymen/*` under `worker/src`, and
 * `web/src` is not aliased inward at all). The peer path produces no post id at
 * all, so an object that reaches a prompt physically cannot carry a like.
 */
export type FeedThesis = PublicThesis & {
  /** Null when the agent has no public slug — an unslugged post is not likeable. */
  postId: string | null;
  /** Current agent mode, not a claim about the mode when an older post was written. */
  trencher?: boolean;
};

export interface ThesesRead {
  /** "none" means the ledger could not be read — NOT that nobody said anything. */
  source: "sqlite" | "none";
  theses: FeedThesis[];
}

export interface ReadThesesOptions {
  /** Only this agent's posts, by public slug. */
  agentSlug?: string;
  /** Only posts naming this symbol. */
  symbol?: string;
  /** Per lane: at most this many trades AND at most this many views. */
  limit?: number;
}

export async function readTheses(opts: ReadThesesOptions = {}, readDb = withReadDb, identities = () => getIdentityStore().all(), settings = (tenant: `0x${string}`) => getSettingsStore().get(tenant)): Promise<ThesesRead> {
  const limit = Math.min(opts.limit ?? SHOW, 200);

  return readDb(async (db): Promise<ThesesRead> => {
    if (!db) return { source: "none", theses: [] };

    // The slug map, read once. NOT a SQL join: the identity store is not the
    // ledger, and the file backend makes a join impossible — the code has to
    // work on both. The identity is keyed on the tenant and carries every smart
    // account that tenant has held, so a re-granted agent's older rows still
    // resolve to the same slug rather than splitting into two strangers.
    const slugFor = new Map<string, string>();
    const accountsFor = new Map<string, string[]>();
    const tenantFor = new Map<string, `0x${string}`>();
    try {
      for (const id of await identities()) {
        accountsFor.set(id.slug, id.accounts.map((a) => a.toLowerCase()));
        tenantFor.set(id.slug, id.tenant);
        for (const acct of id.accounts) slugFor.set(acct.toLowerCase(), id.slug);
      }
    } catch {
      /* no links this pass; every post still renders its words */
    }

    // Scoping to one agent means scoping to every account it has ever held.
    const only = opts.agentSlug ? (accountsFor.get(opts.agentSlug) ?? []) : null;
    if (only !== null && only.length === 0) return { source: "sqlite", theses: [] };

    const since = Math.floor(Date.now() / 1000) - (opts.agentSlug ? 30 * WINDOW_SEC : WINDOW_SEC);
    const where: string[] = [
      "a.mode IN ('live', 'paper')",
      "d.agent_id NOT LIKE 'rh:%'",
      "d.at > ?",
      `d.source IN (${SOURCES.map(() => "?").join(", ")})`,
      "(d.hold_kind IS NULL OR d.hold_kind <> 'GATE_FORCED_HOLD')",
      "(d.dropped_rule IS NULL OR d.dropped_rule NOT LIKE 'brain-%')",
    ];
    const args: unknown[] = [since, ...SOURCES];
    if (only) {
      where.push(`LOWER(d.agent_id) IN (${only.map(() => "?").join(", ")})`);
      args.push(...only);
    }
    if (opts.symbol) {
      where.push("d.symbol = ?");
      args.push(opts.symbol);
    }
    let rows: { actions: ThesisRow[]; views: ThesisRow[] } = { actions: [], views: [] };
    // ── THE NAME IS OPTIONAL TO READ, ON PURPOSE ─────────────────────────
    //
    // `decisions.display_name` is created by the WRITER's migration, and the
    // reader is a different service that deploys at the same moment. For the
    // minute between the two, selecting a column that does not exist yet
    // throws — and the catch below turns that into an empty list, which on a
    // public feed is indistinguishable from a fleet that has never spoken.
    //
    // So it is attempted, and dropped if the column is not there yet. A feed
    // without the coin's name is a worse feed; a blank one is a broken
    // product, and the blankness would be silent.
    //
    // ONE SELECT, TWO QUERIES. The column list, the joins and the group key are
    // shared text, so the two lanes cannot drift into two ideas of what a post
    // is; only the lane predicate and the budget differ.
    const selectFrom = (named: boolean) =>
      `SELECT a.name AS name, a.x_handle AS x_handle, d.agent_id AS agent_id,
              d.action AS action, d.symbol AS symbol, ${named ? "d.display_name AS display_name," : ""}
              d.size_usdg AS size_usdg,
              d.source AS source, d.reason AS reason, d.dropped_rule AS dropped_rule,
              d.hold_kind AS hold_kind,
              p.body AS post,
              t.status AS status, t.reject_rule AS reject_rule, a.mode AS mode,
              COUNT(*) AS said, MAX(d.at) AS last_at, MIN(d.at) AS first_at
         FROM decisions d
         JOIN agents a ON a.smart_account = d.agent_id
         -- The LAST trade for this decision. A correlated MAX(id) rather than
         -- a window function: the scoreboard already hedges against a SQLite
         -- build without them, and this needs to run on both backends.
         LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
         -- THE AGENT'S OWN WORDS, when it had any. A LEFT JOIN because
         -- almost no decision has a post: one is written only for a class
         -- trade that actually filled and whose writer cleared its gate,
         -- so absent is the overwhelmingly common case and must not drop
         -- the row. It is a separate column all the way to
         -- the renderer, because the two carry different trust: the reason
         -- column is ours and the post column is a model's.
         LEFT JOIN posts p ON p.decision_id = d.id
        -- Paper agents post too, labelled. Excluding them emptied the feed:
        -- paperTradingEnabled defaults TRUE, so most of a fleet is pretend
        -- money, and a feed with nothing in it teaches nobody anything. The
        -- LEADERBOARD still ranks live only — a ranking of returns must not
        -- mix fake capital in. 'idle' stays out: an agent that has never
        -- heartbeat has not said anything.
        `;
    const groupBy = (named: boolean) =>
      `GROUP BY a.name, a.x_handle, a.mode, d.agent_id, d.action, d.symbol, ${named ? "d.display_name," : ""} d.size_usdg,
                d.source, d.reason, d.dropped_rule, d.hold_kind, t.status, t.reject_rule, p.body`;
    const actionWhere = [...where, IS_ACTION].join(" AND ");
    const viewWhere = [...where, IS_VIEW].join(" AND ");
    const run = async (named: boolean) => ({
      actions: (await db
        .prepare(
          `${selectFrom(named)}
            WHERE ${actionWhere}
            ${groupBy(named)}
            ORDER BY MAX(d.at) DESC
            LIMIT ?`,
        )
        .all(...args, Math.max(ACTION_SCAN, limit))) as ThesisRow[],
      // THE LATEST WORD PER (agent, name), and the count and first time of
      // exactly that sentence. `latest` finds each pair's newest row; HAVING
      // keeps the one group containing it, so `said` and `first_at` describe
      // the view as it stands now rather than everything the agent ever said
      // about the name. A derived table and HAVING rather than a window
      // function, for the same two-backend reason as the trade join above.
      views: (await db
        .prepare(
          `${selectFrom(named)}
             JOIN (SELECT d.agent_id AS agent_id, COALESCE(d.symbol, '') AS sym, MAX(d.at) AS at
                     FROM decisions d
                     JOIN agents a ON a.smart_account = d.agent_id
                    WHERE ${viewWhere}
                    GROUP BY d.agent_id, COALESCE(d.symbol, '')) latest
               ON latest.agent_id = d.agent_id AND latest.sym = COALESCE(d.symbol, '')
            WHERE ${viewWhere}
            ${groupBy(named)}
           HAVING MAX(d.at) = MAX(latest.at)
            ORDER BY MAX(d.at) DESC
            LIMIT ?`,
        )
        .all(...args, ...args, Math.max(VIEW_SCAN, limit))) as ThesisRow[],
    });
    try {
      rows = await run(true);
    } catch {
      // Second and last attempt, without the column. A failure here is a real
      // read failure and is reported as one.
      try {
        rows = await run(false);
      } catch (error) {
        console.error("[read-theses] ledger read failed", error instanceof Error ? error.name : "unknown");
        return { source: "none", theses: [] };
      }
    }

    // THE ID IS DERIVED FROM THE PUBLISHED POST, not from the row, and only
    // after the gate has admitted it. Every input is a field of the same object
    // the id is returned in, so the id cannot disclose anything the post does
    // not already say — which is what an adversarial review found was NOT true
    // when the row's `source` was an input. See post-id.ts.
    // Resolve only authors in this response, once per tenant. Only this public
    // mode bit leaves the server; never spread settings (which contain secrets).
    const modeFor = new Map<string, boolean>();
    const slugs = [...new Set([...rows.actions, ...rows.views].map(r => slugFor.get(String(r.agent_id).toLowerCase())).filter((s): s is string => !!s))];
    await Promise.all(slugs.map(async slug => {
      const tenant = tenantFor.get(slug);
      if (!tenant) return;
      try {
        const config = await settings(tenant);
        modeFor.set(slug, config?.strategy === "trencher");
      } catch { /* Unknown mode must not acquire a badge or hide a post. */ }
    }));
    const gated = (r: ThesisRow): FeedThesis | null => {
      const slug = slugFor.get(String(r.agent_id).toLowerCase()) ?? null;
      const post = publishableThesis({ ...r, slug });
      if (!post) return null;
      return {
        ...post,
        trencher: slug ? modeFor.get(slug) === true : false,
        postId: postIdOf({
          slug: post.slug,
          action: post.action,
          symbol: post.symbol,
          sizeUsdg: post.sizeUsdg,
          reason: post.reason,
          shadow: post.shadow,
        }),
      } satisfies FeedThesis;
    };
    const actions = rows.actions.map(gated).filter((t): t is FeedThesis => t !== null).slice(0, limit);
    // One view per agent and name. Keyed on the SLUG, not the account: a
    // re-granted agent holds several accounts and is still one author. Two
    // groups can share a pair's newest second; the first to pass the gate wins,
    // and the rest are the same moment said twice.
    const pairs = new Set<string>();
    const views = rows.views
      .map(gated)
      .filter((t): t is FeedThesis => {
        if (!t) return false;
        const pair = `${t.slug ?? t.name}|${t.symbol ?? ""}`;
        if (pairs.has(pair)) return false;
        pairs.add(pair);
        return true;
      })
      .slice(0, limit);
    // Newest first, as it always was: callers that take "the agent's latest
    // post" off the front of this list must still get the latest of both.
    const theses = [...actions, ...views].sort((a, b) => b.at - a.at);

    return { source: "sqlite", theses };
  });
}
