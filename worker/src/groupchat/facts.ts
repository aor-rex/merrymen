/**
 * WHAT THE ROOM MAY KNOW ABOUT EACH AGENT — and the calls it actually made.
 *
 * Everything an agent line can say that is a FACT comes from here: its name,
 * whether it trades live or on paper, how long it has existed, the strategy its
 * owner picked, and the trades it made in the last few hours. The voice layer
 * decorates these; it never adds to them. A template or a model that is handed
 * no figure cannot print one, so the discipline lives in what this module
 * refuses to return rather than in anything downstream remembering a rule.
 *
 * READ-ONLY, AND ONLY FROM THE SHARED LEDGER. The room lives in its own tables
 * and nothing here writes anywhere. Nothing here feeds a trading decision
 * either: this module reads trading's tables, never the other way round.
 *
 * ONE QUERY PER KIND PER PASS, for the whole roster. The conductor steps every
 * ~15 s across the whole fleet, and a query per agent would be fifty round
 * trips to the shared Postgres the trading mirror also writes to.
 *
 * NAMED COLUMNS ONLY, NEVER A STAR. `decisions.signals_json` is the owner's
 * whole balance sheet, `size_usdg` is a private trade size, and the agents row
 * carries the owner's wallet, the session key, the caps and the live blocker.
 * None of them is filtered out below — they are never selected, which is a
 * stronger guarantee than any filter, and facts.test.ts scans this file's SQL
 * to keep it so.
 */

import { agentNameForSlug, DEFAULT_AGENT_NAME, normalizeAgentName, STORED_AGENT_NAME_RE } from "../../../packages/core/src/agent-name";
import { SETTINGS_DEFAULTS } from "../../../packages/core/src/settings";
import { CASH } from "../../../packages/core/src/tokens";
import { everyBand } from "../class-evidence";
import { coinDisplayName } from "../coin-name";
import type { Db } from "../db";
import { getIdentityStore, SLUG_RE } from "../identity-store";
import { traitsOf, type Disposition } from "../social-post";
import { LANDED_STATUSES, PUBLISHABLE_SOURCES, PUBLISHABLE_STRATEGIES, publishableThesis } from "../thesis-policy";
import type { CallRef } from "./types";

// ── profiles ─────────────────────────────────────────────────────────────────

export interface RosterEntry {
  tenant: string;
  agentId: string;
}

/** What the owner chose, as far as the room may say it. Projected in the orchestrator from sealed settings. */
export interface ChatProfile {
  strategy: string | null;
  traits: string[];
}

/**
 * A setting read the way the child reads it, minus the environment.
 *
 * THE SAME BOUNDS AS worker/src/settings.ts's `num`, so an out-of-range value
 * falls to the default here exactly as it does in the agent that trades on it.
 * A trait claimed from a value the agent itself refused would be a trait the
 * agent does not have.
 */
function bounded(v: unknown, fallback: number, min: number, max: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : fallback;
}

/**
 * THE DEFAULTS THE SOCIAL WRITER MEASURES TRAITS AGAINST, copied from its call
 * site in index.ts rather than re-derived. Two writers measuring "moves early"
 * against different baselines would give one agent two personalities.
 */
const DISPOSITION_DEFAULTS: Disposition = {
  maxHoldSec: SETTINGS_DEFAULTS.classMaxHoldSec ?? 21600,
  exitAtGraduationPct: SETTINGS_DEFAULTS.classExitAtGraduationPct ?? 85,
  perEntryUsdg: SETTINGS_DEFAULTS.classPerEntryUsdg ?? 5,
  maxImpactBps: SETTINGS_DEFAULTS.maxImpactBps ?? 300,
  minDepthUsdg: SETTINGS_DEFAULTS.classMinDepthUsdg ?? 100,
};

/**
 * The owner's strategy and traits, as the room may state them.
 *
 * RESOLVED THE WAY THE CHILD RESOLVES IT: an absent or malformed strategy is
 * the default the child actually runs, and a settings object that is missing
 * entirely is the "safe defaults" the orchestrator hands a tenant who never
 * saved anything. What differs is what may be SAID: only a strategy on the
 * publication list is named. A tenant's own file is a string we did not write,
 * and `llm-strategist` is off that list on purpose (thesis-policy.ts).
 *
 * NO ENVIRONMENT. The child also honours MERRYMEN_* overrides, but this runs in
 * the orchestrator from a raw settings object and has to stay pure; an
 * operator-wide override is not something the owner chose, so it is not a
 * trait of their agent either.
 */
export function chatProfileOf(settings: unknown): ChatProfile {
  const file: Record<string, unknown> =
    settings !== null && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};

  const typed = typeof file.strategy === "string" ? file.strategy.trim() : "";
  const runs = typed && /^[A-Za-z0-9_-]{1,64}$/.test(typed) ? typed : SETTINGS_DEFAULTS.strategy;
  const strategy = (PUBLISHABLE_STRATEGIES as readonly string[]).includes(runs) ? runs : null;

  const d = DISPOSITION_DEFAULTS;
  const own: Disposition = {
    maxHoldSec: bounded(file.classMaxHoldSec, d.maxHoldSec, 60, 30 * 86_400),
    exitAtGraduationPct: bounded(file.classExitAtGraduationPct, d.exitAtGraduationPct, 1, 100),
    perEntryUsdg: bounded(file.classPerEntryUsdg, d.perEntryUsdg, 0, 1_000_000),
    maxImpactBps: bounded(file.maxImpactBps, d.maxImpactBps, 0, 10_000),
    minDepthUsdg: bounded(file.classMinDepthUsdg, d.minDepthUsdg, 0, 10_000_000),
  };
  return { strategy, traits: traitsOf(own, d) };
}

// ── facts ────────────────────────────────────────────────────────────────────

/** A trade the agent made, as the room may show it. See CallRef for why it has no size. */
export interface CallFact extends CallRef {
  decisionId: string;
  /** Unix seconds the decision was taken. */
  atSec: number;
  /** Only words from `everyBand()` — the closed vocabulary. Never a figure. */
  bands: string[];
  /** The agent's own published post about this trade, clipped like the feed clips it, or null. */
  ownWords: string | null;
}

export interface AgentFacts {
  tenant: string;
  agentId: string;
  slug: string | null;
  name: string;
  mode: "live" | "paper" | "idle";
  ageDays: number | null;
  strategy: string | null;
  traits: string[];
  /** Newest first, within the call window. */
  calls: CallFact[];
}

/** Six hours: the conductor announces a call only within this long of the fill. */
const CALL_WINDOW_SEC = 6 * 3600;

/**
 * NEWEST CALLS KEPT PER AGENT, in SQL. A fleet-wide LIMIT would let one busy
 * paper book fill the whole budget and leave every other agent with nothing
 * to call; a per-agent bound makes each agent's share independent of the
 * others'. The conductor announces each call once, so a cap far above what a
 * room can say in six hours loses nothing.
 */
const CALLS_PER_AGENT = 25;

/**
 * Anything that looks like an on-chain identifier — thesis-policy.ts's
 * backstop, duplicated because that module does not export it and is being
 * edited elsewhere. `rh:` because the brokerage rail's agent id embeds an
 * account number.
 */
const ADDRESSY = /\b(?:0x[0-9a-fA-F]{6,}|rh:[A-Za-z0-9-]{1,64})\b/;

/** What CallRef.token may be: a contract, for /t/<token>. The cash legs are never the coin. */
const CONTRACT = /^0x[0-9a-fA-F]{40}$/;
const CASH_LEGS: ReadonlySet<string> = new Set([CASH.USDG.toLowerCase(), CASH.WETH.toLowerCase()]);

/** A ticker as the ledger recorded it, or null when it is not one a reader could be shown. */
const SYMBOL = /^[A-Za-z0-9._-]{1,24}$/;

/** everyBand() sweeps every band function; once per process is enough, since the vocabulary is code. */
let vocab: ReadonlySet<string> | null = null;
function vocabulary(): ReadonlySet<string> {
  return (vocab ??= everyBand());
}

function holes(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/**
 * THE ROSTER: name and last-heartbeat mode, nothing else.
 *
 * LOWER on both sides because the ledger stores whatever case the child wrote
 * and the roster carries whatever case the grant did; the web joins the same
 * way. `agents` is fleet-sized, so the lost PK lookup costs nothing.
 */
export function rosterSql(n: number): string {
  return `SELECT smart_account, name, mode FROM agents WHERE LOWER(smart_account) IN (${holes(n)})`;
}

/**
 * THE CALLS: decision first, its latest trade, its post.
 *
 * DECISION-FIRST, bounded by `d.at > ?`, so the scan rides `decisions_time`
 * and the trade is found through `trades_decision` one decision at a time —
 * `trades` is the one table nothing may add an index to. The latest trade per
 * decision because a decision can be retried; the last word on it is the
 * outcome.
 *
 * The trade must belong to the decision's own agent, and so must the post: a
 * decision id is a UUID, so a mismatch is never a coincidence, and a row that
 * disagrees about whose trade it is is dropped rather than attributed.
 *
 * `evidence_json` is selected whole because JSON access is spelled differently
 * on the two engines; only its `bands` are read, below, and only the ones in
 * the closed vocabulary. Its `raw` figures never leave this module. `reason`
 * is selected for the gate alone — a trade with nothing publishable behind it
 * is not a call — and is never returned: a model's reason may quote the
 * owner's cash.
 */
export function callsSql(agents: number): { sql: string; fixed: string[] } {
  const actions = ["buy", "sell"];
  return {
    sql: `SELECT x.decision_id, x.agent_id, x.source, x.action, x.symbol, x.display_name, x.reason,
                 x.dropped_rule, x.hold_kind, x.evidence_json, x.at, x.status, x.buy_token, x.sell_token, x.post
            FROM (
              SELECT d.id AS decision_id, d.agent_id, d.source, d.action, d.symbol, d.display_name, d.reason,
                     d.dropped_rule, d.hold_kind, d.evidence_json, d.at,
                     t.id AS trade_id, t.status, t.buy_token, t.sell_token,
                     p.body AS post,
                     ROW_NUMBER() OVER (PARTITION BY LOWER(d.agent_id) ORDER BY d.at DESC, t.id DESC) AS rn
                FROM decisions d
                JOIN trades t ON t.id = (SELECT MAX(t2.id) FROM trades t2 WHERE t2.decision_id = d.id)
                LEFT JOIN posts p ON p.decision_id = d.id AND LOWER(p.agent_id) = LOWER(d.agent_id)
               WHERE d.at > ?
                 AND LOWER(d.agent_id) IN (${holes(agents)})
                 AND LOWER(d.agent_id) NOT LIKE 'rh:%'
                 AND LOWER(t.agent_id) = LOWER(d.agent_id)
                 AND d.action IN (${holes(actions.length)})
                 AND d.source IN (${holes(PUBLISHABLE_SOURCES.length)})
                 AND t.status IN (${holes(LANDED_STATUSES.length)})
            ) x
           WHERE x.rn <= ?
           ORDER BY x.at DESC, x.trade_id DESC`,
    fixed: [...actions, ...PUBLISHABLE_SOURCES, ...LANDED_STATUSES],
  };
}

/**
 * THE NAME THE ROOM USES.
 *
 * The owner's name when they chose one. The stock "Robin", an empty name, an
 * address-shaped one, or one the soul's stored-name rule would refuse becomes
 * the slug's generated name, so a room of unnamed agents is not a room of
 * Robins — the same suggestion every other screen offers for that slug.
 *
 * WITH NO SLUG, "Robin" rather than the raw value. The generated name needs a
 * seed, and falling back to whatever the row held would put an address — maybe
 * the owner's — at the head of a public line.
 */
export function roomName(raw: unknown, slug: string | null): string {
  const name = typeof raw === "string" ? normalizeAgentName(raw) : "";
  const usable = name !== "" && !ADDRESSY.test(name) && STORED_AGENT_NAME_RE.test(name);
  if (usable && name !== DEFAULT_AGENT_NAME) return name;
  return (slug ? agentNameForSlug(slug) : null) ?? DEFAULT_AGENT_NAME;
}

function modeOf(v: unknown): AgentFacts["mode"] {
  return v === "live" || v === "paper" ? v : "idle";
}

/** Seconds, whichever unit the store wrote — the file backend and Postgres both write seconds today. */
function ageDaysOf(createdAt: number | undefined, nowSec: number): number | null {
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt) || createdAt <= 0) return null;
  const sec = createdAt > 1_000_000_000_000 ? Math.floor(createdAt / 1000) : createdAt;
  return Math.max(0, Math.floor((nowSec - sec) / 86_400));
}

/** The band words of a decision's evidence that are in the closed vocabulary, deduplicated, in stored order. */
function bandsOf(evidence: unknown): string[] {
  if (typeof evidence !== "string" || evidence === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidence);
  } catch {
    return [];
  }
  const bands = (parsed as { bands?: unknown } | null)?.bands;
  if (!bands || typeof bands !== "object" || Array.isArray(bands)) return [];
  const words = vocabulary();
  const out: string[] = [];
  for (const v of Object.values(bands as Record<string, unknown>)) {
    if (typeof v === "string" && words.has(v) && !out.includes(v)) out.push(v);
  }
  return out;
}

/** The coin's contract on the side that moved: bought on a buy, sold on a sell. */
function tokenOf(side: "buy" | "sell", buy: unknown, sell: unknown): string | null {
  const v = side === "buy" ? buy : sell;
  if (typeof v !== "string" || !CONTRACT.test(v)) return null;
  const t = v.toLowerCase();
  return CASH_LEGS.has(t) ? null : t;
}

/**
 * The coin's own name, through the one sanitiser every surface shares.
 *
 * `kind: "memecoin"` because only a memecoin's decision ever carries a
 * display name (coinDisplayName refuses the rest at write time), so the rule
 * that would null it for a stock has already run. A name that still looks like
 * an address costs the call its name, not the call.
 */
function coinNameOf(raw: unknown, symbol: string | null): string | null {
  if (typeof raw !== "string") return null;
  const clean = coinDisplayName({ symbol: symbol ?? "", name: raw, kind: "memecoin" });
  if (!clean || ADDRESSY.test(clean)) return null;
  return symbol && clean.toUpperCase() === symbol.toUpperCase() ? null : clean;
}

type Identities = (tenants: string[]) => Promise<Map<string, { slug: string; createdAt: number }>>;

/**
 * THE DEFAULT IDENTITY READ, which drops everything social on the first line.
 *
 * `all()` returns the Privy half too — handle, display name, avatar — and the
 * owner's Privy name is on the list of things that must never reach the room.
 * It is gone before anything else touches the rows.
 */
const identitiesFromStore: Identities = async (tenants) => {
  const rows = (await getIdentityStore().all()).map(({ tenant, slug, createdAt }) => ({ tenant, slug, createdAt }));
  const want = new Set(tenants.map((t) => t.toLowerCase()));
  const out = new Map<string, { slug: string; createdAt: number }>();
  for (const r of rows) {
    const key = String(r.tenant).toLowerCase();
    if (want.has(key)) out.set(key, { slug: r.slug, createdAt: Number(r.createdAt) });
  }
  return out;
};

interface CallRow {
  decision_id: unknown;
  agent_id: unknown;
  source: unknown;
  action: unknown;
  symbol: unknown;
  display_name: unknown;
  reason: unknown;
  dropped_rule: unknown;
  hold_kind: unknown;
  evidence_json: unknown;
  at: unknown;
  status: unknown;
  buy_token: unknown;
  sell_token: unknown;
  post: unknown;
}

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Everything the room may know about each roster agent, keyed by the
 * LOWERCASED tenant — the key every groupchat table and the sleep window use.
 *
 * Every roster entry gets an answer, even one whose ledger row has not been
 * mirrored yet: it is running, so it is in the room, as an idle agent with no
 * calls rather than as a hole in the conductor's map.
 *
 * FAILURES PROPAGATE. A statement that breaks on Postgres must say so in the
 * conductor's log line rather than read as a quiet fleet.
 */
export async function loadFacts(
  shared: Db,
  roster: RosterEntry[],
  profiles: Map<string, ChatProfile>,
  nowSec: number,
  opts: {
    callWindowSec?: number;
    identities?: Identities;
  } = {},
): Promise<Map<string, AgentFacts>> {
  const out = new Map<string, AgentFacts>();
  if (roster.length === 0) return out;

  const byAgent = new Map<string, string>();
  for (const r of roster) byAgent.set(r.agentId.toLowerCase(), r.tenant.toLowerCase());
  const agentIds = [...byAgent.keys()];
  const tenants = [...new Set(roster.map((r) => r.tenant.toLowerCase()))];

  const ids = await (opts.identities ?? identitiesFromStore)(tenants);

  const agentRows = (await shared.prepare(rosterSql(agentIds.length)).all(...agentIds)) as {
    smart_account: unknown;
    name: unknown;
    mode: unknown;
  }[];
  const rowOf = new Map<string, { name: unknown; mode: unknown }>();
  for (const a of agentRows) {
    const key = String(a.smart_account ?? "").toLowerCase();
    if (!rowOf.has(key)) rowOf.set(key, { name: a.name, mode: a.mode });
  }

  for (const r of roster) {
    const tenant = r.tenant.toLowerCase();
    const agentId = r.agentId.toLowerCase();
    const id = ids.get(tenant) ?? null;
    const slug = id && typeof id.slug === "string" && SLUG_RE.test(id.slug) ? id.slug : null;
    const row = rowOf.get(agentId);
    const profile = profiles.get(tenant) ?? profiles.get(r.tenant) ?? { strategy: null, traits: [] };
    out.set(tenant, {
      tenant,
      agentId: r.agentId,
      slug,
      name: roomName(row?.name, slug),
      mode: modeOf(row?.mode),
      ageDays: ageDaysOf(id?.createdAt, nowSec),
      strategy: profile.strategy,
      traits: [...profile.traits],
      calls: [],
    });
  }

  // THE BROKERAGE RAIL NEVER EVEN REACHES THE QUERY: its id is an account number.
  const callable = agentIds.filter((a) => !a.startsWith("rh:"));
  if (callable.length === 0) return out;

  const windowSec = opts.callWindowSec ?? CALL_WINDOW_SEC;
  const { sql, fixed } = callsSql(callable.length);
  const rows = (await shared.prepare(sql).all(nowSec - windowSec, ...callable, ...fixed, CALLS_PER_AGENT)) as CallRow[];

  for (const row of rows) {
    const tenant = byAgent.get(String(row.agent_id ?? "").toLowerCase());
    const facts = tenant ? out.get(tenant) : undefined;
    if (!facts) continue;
    const side = row.action === "buy" || row.action === "sell" ? row.action : null;
    if (!side) continue;

    // THE PUBLICATION GATE, unchanged: a call is a thesis the public feed would
    // print as landed, or it is not a call. Size is nulled going in so no
    // figure can come out, and the name is the room's so a Robin or an
    // address-named row is not dropped for its name alone.
    const thesis = publishableThesis({
      agent_id: s(row.agent_id),
      name: facts.name,
      source: s(row.source),
      action: side,
      symbol: s(row.symbol),
      display_name: coinNameOf(row.display_name, s(row.symbol)),
      size_usdg: null,
      reason: s(row.reason),
      dropped_rule: s(row.dropped_rule),
      hold_kind: s(row.hold_kind),
      status: s(row.status),
      mode: facts.mode,
      slug: facts.slug,
      post: s(row.post),
    });
    if (!thesis || thesis.outcome !== "landed" || thesis.shadow) continue;

    const symbol = thesis.symbol && SYMBOL.test(thesis.symbol) && !/^0x/i.test(thesis.symbol) ? thesis.symbol : null;
    facts.calls.push({
      side,
      symbol,
      name: coinNameOf(row.display_name, symbol),
      token: tokenOf(side, row.buy_token, row.sell_token),
      paper: row.status === "paper",
      decisionId: String(row.decision_id),
      atSec: Number(row.at),
      bands: bandsOf(row.evidence_json),
      ownWords: thesis.post,
    });
  }
  return out;
}
