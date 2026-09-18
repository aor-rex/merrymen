/**
 * WHAT A WIRED AGENT HAS SAID IN PUBLIC, read on the orchestrator's side.
 *
 * The query half of the wire. `peer-files.ts` is the transport; this is the only
 * thing allowed to fill it.
 *
 * WHY THE SELECT IS NARROWER THAN THE FEED'S. `read-theses.ts` runs the browser's
 * version of this and is deliberately not shared with it: that module lives in
 * `web/src`, which the worker cannot import, and moving the whole reader would
 * drag pagination, symbol filters and grouping the orchestrator has no use for.
 *
 * The thing that must NOT be duplicated is the publication policy, and it is not:
 * every row here leaves through `publishableThesis` from `thesis-policy.ts`, the
 * same function `/api/theses` uses. That is the boundary the move of that module
 * was made to create, and it is what makes "the peer file can only contain what
 * an anonymous browser already gets" a compile-time fact rather than a promise.
 *
 * `signals_json` IS THE COLUMN TO KEEP OUT. It holds the owner's entire balance
 * sheet, it IS mirrored into shared Postgres (ledger-mirror.ts copies it), and it
 * sits on the very table this query reads. Any new reader of `decisions` re-opens
 * that hole by default, which is why the column list below is explicit and why a
 * test scans this file's source for the name.
 */
import type { Db } from "./db";
import { getIdentityStore, type IdentityStore } from "./identity-store";
import {
  PUBLISHABLE_SOURCES,
  publishableThesis,
  type PublicThesis,
  type ThesisRow,
} from "./thesis-policy";

/** How far back a peer's thinking is worth carrying. Matches the public feed. */
export const PEER_WINDOW_SEC = 24 * 3600;

/**
 * Sources whose text merrymen wrote, DERIVED rather than copied.
 *
 * A hand-kept second list would drift the moment a strategy is added, and the
 * drift would be silent and in the wrong direction: the SQL would stop selecting
 * a source that publishableThesis is perfectly happy to publish, so a peer would
 * quietly go quiet. Built from the same constant thesis-policy gates on.
 */
// The same list the public feed uses, from the same module. "A peer file can
// only contain what the public feed publishes" is a property only while these
// two readers are incapable of disagreeing about what that is.
const SOURCES: readonly string[] = PUBLISHABLE_SOURCES;

/** At most this many theses reach one child, newest first. A prompt has a budget. */
export const PEER_THESIS_LIMIT = 24;
const SCAN_BATCH = 96;
/** Bound mirror work even if every row in a busy ledger fails publication. */
const MAX_SCAN = 960;

/**
 * Resolve slugs to the accounts behind them.
 *
 * One agent may have held several smart accounts — a re-grant mints a new one —
 * so a slug maps to a LIST, and every one of them has to be in the query or the
 * agent's own history disappears at its last re-grant.
 */
async function resolvePeers(slugs: readonly string[], identity: Pick<IdentityStore, "bySlug">) {
  const accounts = new Set<`0x${string}`>();
  const slugFor = new Map<string, string>();
  for (const slug of slugs) {
    try {
      const id = await identity.bySlug(slug);
      if (id) for (const account of id.accounts) {
        accounts.add(account.toLowerCase() as `0x${string}`);
        slugFor.set(account.toLowerCase(), id.slug);
      }
    } catch {
      // A dangling follow is not an error — see follow-store.ts. It contributes
      // nothing and must not stop the other peers from being read.
    }
  }
  return { accounts: [...accounts], slugFor };
}

export async function accountsForSlugs(slugs: readonly string[]): Promise<`0x${string}`[]> {
  return (await resolvePeers(slugs, getIdentityStore())).accounts;
}

/**
 * The published theses of these accounts, newest first.
 *
 * Returns `[]` on any read failure, deliberately: a ledger written by an older
 * worker has no `decisions` table, and an empty peer file is the honest render of
 * "we could not learn anything" — never a 500 on the orchestrator's mirror pass.
 */
export async function readPeerTheses(
  shared: Db,
  accounts: readonly `0x${string}`[],
  slugFor: ReadonlyMap<string, string> = new Map(),
): Promise<PublicThesis[]> {
  if (accounts.length === 0) return [];
  const since = Math.floor(Date.now() / 1000) - PEER_WINDOW_SEC;
  const holes = accounts.map(() => "?").join(", ");
  const sources = SOURCES.map(() => "?").join(", ");
  const published: PublicThesis[] = [];
  try {
    const query = shared
      .prepare(
        `SELECT a.name AS name, a.x_handle AS x_handle, d.agent_id AS agent_id,
                d.action AS action, d.symbol AS symbol, d.size_usdg AS size_usdg,
                d.source AS source, d.reason AS reason, d.dropped_rule AS dropped_rule,
                d.hold_kind AS hold_kind,
                  p.body AS post,
                t.status AS status, t.reject_rule AS reject_rule, a.mode AS mode,
                COUNT(*) AS said, MAX(d.at) AS last_at, MIN(d.at) AS first_at
           FROM decisions d
           JOIN agents a ON a.smart_account = d.agent_id
           LEFT JOIN trades t ON t.id = (SELECT MAX(id) FROM trades WHERE decision_id = d.id)
             -- THE AGENT'S OWN WORDS, when it had any. A LEFT JOIN because
             -- almost no decision has a post: one is written only for a class
             -- trade that actually filled and whose writer cleared its gate,
             -- so absent is the overwhelmingly common case and must not drop
             -- the row. It is a separate column all the way to
             -- the renderer, because the two carry different trust: the reason
             -- column is ours and the post column is a model's.
             LEFT JOIN posts p ON p.decision_id = d.id
          WHERE a.mode IN ('live', 'paper')
            AND d.agent_id NOT LIKE 'rh:%'
            AND LOWER(d.agent_id) IN (${holes})
            AND d.at > ?
            AND d.source IN (${sources})
            AND (d.hold_kind IS NULL OR d.hold_kind <> 'GATE_FORCED_HOLD')
            AND (d.dropped_rule IS NULL OR d.dropped_rule NOT LIKE 'brain-%')
          GROUP BY a.name, a.x_handle, a.mode, d.agent_id, d.action, d.symbol, d.size_usdg,
                   d.source, d.reason, d.dropped_rule, d.hold_kind, t.status, t.reject_rule, p.body
          ORDER BY MAX(d.at) DESC, MAX(d.id) DESC
          LIMIT ? OFFSET ?`,
      );
    // Filter before applying the prompt limit. Otherwise 24 newer operational
    // rows hide every real thesis behind them and a followed desk looks silent.
    for (let offset = 0; offset < MAX_SCAN; offset += SCAN_BATCH) {
      const rows = await query.all(...accounts.map((a) => a.toLowerCase()), since, ...SOURCES, SCAN_BATCH, offset) as ThesisRow[];
      published.push(...rows
        .map((r) => ({ ...r, slug: slugFor.get((r.agent_id ?? "").toLowerCase()) ?? null }))
        .map(publishableThesis)
        .filter((t): t is PublicThesis => t !== null));
      if (published.length >= PEER_THESIS_LIMIT || rows.length < SCAN_BATCH) break;
    }
  } catch {
    return [];
  }
  // THE ONLY WAY OUT OF THIS MODULE. Everything above is a row shape; this is
  // the gate, and it is the same one the public feed publishes through.
  return published.slice(0, PEER_THESIS_LIMIT);
}

/** Slugs → published theses, in one call. What the orchestrator actually wants. */
export async function peerThesesForSlugs(
  shared: Db,
  slugs: readonly string[],
  identity: Pick<IdentityStore, "bySlug"> = getIdentityStore(),
): Promise<PublicThesis[]> {
  const peers = await resolvePeers(slugs, identity);
  return readPeerTheses(shared, peers.accounts, peers.slugFor);
}
