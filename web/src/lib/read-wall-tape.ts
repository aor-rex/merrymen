/**
 * EVERY INTENT THIS LEDGER RECORDED IN THE LAST DAY, AND WHAT THE WALL DID
 * WITH IT.
 *
 * This feeds a picture, not a table, so it reads the fewest columns that can
 * possibly make one: when it happened, what became of it, and — when the wall
 * turned it back — which rule did the turning. `amount_usdg`, `agent_id`,
 * `tx_hash` and `user_op_hash` are ABSENT rather than filtered, the same
 * discipline read-theses.ts applies to `signals_json`. A graphic cannot leak a
 * column it never selected.
 *
 * WHY THIS IS THE PICTURE. merrymen is a boundary. Its most distinctive fact is
 * that agents are refused constantly and visibly — one live agent is sitting on
 * 1,225 refusals and zero fills — and the product already shipped that fact as
 * a button ("prove the wall") rendered as a list of grey rows. This draws it.
 *
 * NO SESSION READ. No `tenantOf`, no `isHostedMode`, no per-caller anything —
 * which is what keeps every caller cacheable, exactly as read-theses.ts
 * documents. If a session read ever appears here, the caches above it become
 * leaks.
 */
import { withReadDb } from "@/lib/ledger";
import { WINDOW_SEC } from "@/lib/read-theses";
import { REJECT_RULES, outcomeOf } from "@/lib/thesis";
import { getIdentityStore } from "@merrymen/identity-store";

/**
 * Rows examined. PINNED — never widen this to make the picture denser.
 *
 * The band draws what the day actually held; a quiet night is meant to look
 * like a quiet night, and topping it up would make the graphic a decoration
 * that lies about volume.
 */
const CAP = 400;

/** Named lanes, plus one catch-all. More than this and a lane is 2px tall. */
const MAX_NAMED_LANES = 7;

/** What the wall did with it. */
export type Fate = "turned" | "through" | "flight";

export interface WallCell {
  /** Unix seconds. */
  t: number;
  /** Index into `lanes`. */
  lane: number;
  fate: Fate;
}

export interface WallTape {
  /** "none" means the ledger could not be read — NOT that nothing happened. */
  source: "sqlite" | "none";
  /** Oldest first. */
  cells: WallCell[];
  /** Index-aligned labels. The last is always the catch-all. */
  lanes: string[];
  counts: { intents: number; turned: number; through: number; flight: number };
  from: number;
  to: number;
  /** Stable identity for the render, so an effect does not restart on every poll. */
  key: string;
}

const EMPTY: WallTape = {
  source: "none",
  cells: [],
  lanes: [],
  counts: { intents: 0, turned: 0, through: 0, flight: 0 },
  from: 0,
  to: 0,
  key: "0:0",
};

/** The catch-all lane's label — a word the badge vocabulary already ships. */
const CATCH_ALL = "turned back";

export async function readWallTape(opts: { agentSlug?: string } = {}): Promise<WallTape> {
  // Scoping to an agent means scoping to every account it has ever held; a
  // re-grant must not split its history into two strangers.
  let only: string[] | null = null;
  if (opts.agentSlug) {
    try {
      const id = await getIdentityStore().bySlug(opts.agentSlug);
      only = (id?.accounts ?? []).map((a) => a.toLowerCase());
    } catch {
      only = [];
    }
    if (only.length === 0) return { ...EMPTY, source: "sqlite" };
  }

  return withReadDb(async (db): Promise<WallTape> => {
    if (!db) return EMPTY;

    const to = Math.floor(Date.now() / 1000);
    const from = to - WINDOW_SEC;

    const where = [
      "t.created_at > ?",
      "t.agent_id NOT LIKE 'rh:%'",
      "a.mode IN ('live','paper')",
    ];
    const args: unknown[] = [from];
    if (only) {
      where.push(`LOWER(t.agent_id) IN (${only.map(() => "?").join(", ")})`);
      args.push(...only);
    }
    args.push(CAP);

    let rows: { at: number; status: string | null; rule: string | null }[] = [];
    try {
      rows = (await db
        .prepare(
          `SELECT t.created_at AS at, t.status AS status, t.reject_rule AS rule
             FROM trades t
             JOIN agents a ON a.smart_account = t.agent_id
            WHERE ${where.join(" AND ")}
            ORDER BY t.created_at DESC
            LIMIT ?`,
        )
        .all(...args)) as typeof rows;
    } catch {
      // An older ledger has no `mode`. An empty band is the honest render of
      // that; it is never a 500 and never a claim that nothing happened.
      return { ...EMPTY, source: "sqlite", from, to };
    }

    // ── lanes ──────────────────────────────────────────────────────────────
    // The vocabulary comes from the publication policy, not from a second
    // hand-rolled copy of it. `reject_rule` demonstrably carries free-form text
    // — truncated bundler exceptions, `review: <reason>` — so anything outside
    // the known set is the catch-all rather than a new lane. The graphic never
    // invents a category and never echoes a raw string.
    const known = new Set(REJECT_RULES);
    const tally = new Map<string, number>();
    for (const r of rows) {
      const rule = r.rule && known.has(r.rule) ? r.rule : null;
      if (rule) tally.set(rule, (tally.get(rule) ?? 0) + 1);
    }
    const named = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_NAMED_LANES)
      .map(([k]) => k);
    const lanes = [...named, CATCH_ALL];
    const laneOf = new Map(named.map((n, i) => [n, i]));
    const catchAll = lanes.length - 1;

    const cells: WallCell[] = [];
    const counts = { intents: 0, turned: 0, through: 0, flight: 0 };

    // Oldest first, so the replay runs forward through the day.
    for (const r of [...rows].reverse()) {
      const { outcome } = outcomeOf(r.status, r.rule);
      const fate: Fate =
        outcome === "refused" || outcome === "reverted"
          ? "turned"
          : outcome === "landed"
            ? "through"
            : "flight";
      // A decision that never reached the wall is not an intent flying at it.
      if (outcome === "dropped" || outcome === "view") continue;
      const lane =
        fate === "turned" ? (r.rule && laneOf.has(r.rule) ? laneOf.get(r.rule)! : catchAll) : catchAll;
      cells.push({ t: Number(r.at), lane, fate });
      counts.intents += 1;
      counts[fate] += 1;
    }

    return {
      source: "sqlite",
      cells,
      lanes,
      counts,
      from,
      to,
      key: `${cells.length}:${to}`,
    };
  });
}
