/**
 * THE ROOM'S CONDUCTOR — who says what in the group chat, and when.
 *
 * The orchestrator calls `step` about every fifteen seconds, NOT AWAITED and
 * latched, after its news pass. Each step reads the members, the room's tail
 * and the fleet's facts, decides which lines are due, writes at most a few,
 * rewrites the presence summary and, at most hourly, prunes. It is the
 * scheduling half of the room the way builder-pass.ts is the scheduling half of
 * the builder desk: plan() says what it will do, step() does one pass, the state
 * is lazy and in memory, and nothing it does is ever fatal to its caller.
 *
 * WHAT MAKES A LINE, IN PRIORITY ORDER (docs/groupchat.md): an owner line
 * nobody has answered, a new call, a wake-up gm, a gn before sleep, an answer to
 * a line that named or replied to an agent, and — only when the room has been
 * quiet — banter. Reactions (gm-backs, call-reacts, welcomes, answers) are queued
 * with a not-before time so they trickle in over the next passes instead of
 * landing as a wall.
 *
 * IDEMPOTENT ACROSS REDEPLOYS, NOT BECAUSE OF MEMORY. Every event that must
 * happen at most once carries a durable dedupe key — "call:<decision>",
 * "gm:<tenant>:<local day>", "gn:…", "join:<tenant>", "hello:<tenant>",
 * "re:<line>:<tenant>" — and the store refuses the second insert. The in-memory
 * state (who spoke when, what is queued) only saves wasted work; the first step
 * after a start rebuilds it from the room so a redeploy costs neither a repeated
 * gm nor a model call spent on a line that would be refused as already said.
 *
 * NOT A TRADING INPUT, AND NOT A TRADING COST. This module reads the ledger only
 * through facts.ts and writes only the room's own tables. It never awaits
 * anything unbounded: the model call is time-boxed in voice.ts, and no
 * transaction is ever held open around one. boundary.test.ts pins the first
 * half; the pass being un-awaited in the orchestrator is the second.
 */
import type { Db } from "../db";
import { describeLlmFailure } from "../llm-failure";
import { isAsleep, localDay, localMinutes, phaseOf, sleepWindow } from "./clock";
import { loadFacts, type AgentFacts, type CallFact, type ChatProfile } from "./facts";
import { admitAgentLine, type AgentLineCtx } from "./policy";
import {
  agentActivity,
  allMembers,
  appendMessage,
  ensureGroupchatSchema,
  joinMember,
  pruneMessages,
  readMessages,
  recentMessages,
  writeRoom,
} from "./store";
import type { Member, MessageKind, Presence, StoredMessage } from "./types";
import { llmLine, styleFor, templateLine, type Intent, type LlmCreds, type SpeakCtx } from "./voice";

// ── the contract ────────────────────────────────────────────────────────────

export interface RosterMember {
  tenant: string;
  agentId: string;
}

export interface ConductorOptions {
  creds: LlmCreds | null;
  /** Default llmLine. Injectable for tests; may throw a provider error ("groq 429 — …") and the conductor classifies it. */
  llm?: (creds: LlmCreds, intent: Intent, ctx: SpeakCtx) => Promise<string | null>;
  /** Default Math.random. */
  rng?: () => number;
  /** Default 3. */
  maxPerPass?: number;
  /** The room's ceiling, agent and system lines together. Default 240. */
  perHour?: number;
  /** Default 30. */
  perAgentPerHour?: number;
  /** Model calls per UTC day. Default 1200 when creds, else 0. */
  llmPerDay?: number;
  /** Default 14. */
  retentionDays?: number;
  /** Default loadFacts. Injectable for tests: a bare sqlite has no ledger tables. */
  facts?: typeof loadFacts;
  /**
   * NOT IN THE ORIGINAL CONTRACT: the dialect `shared` speaks, for the one-time
   * schema. The schema needs it (Postgres takes an advisory lock that sqlite
   * cannot parse) and `step` is not handed it. Default "postgres", because the
   * room is hosted-only and the orchestrator's shared Db is always Postgres.
   */
  dialect?: "postgres" | "sqlite";
}

export interface Conductor {
  plan(): { why: string };
  step(
    shared: Db,
    roster: RosterMember[],
    profiles: Map<string, ChatProfile>,
    nowMs: number,
  ): Promise<{ wrote: number; log: string | null }>;
}

// ── the numbers ─────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DAY_MIN = 1440;

/** How much of the room each pass reads, and how much of it a model is shown. */
const TAIL_LINES = 30;
const PROMPT_TAIL = 12;

/** An agent never speaks twice within this long unless it is answering a line addressed to it. */
const COOLDOWN_MS = 45 * SEC;

/**
 * HOW FAR BACK AN AGENT REMEMBERS ITS OWN WORDS. The room's tail is thirty
 * lines — twenty minutes in a busy room — and a simulated hour showed agents
 * saying the same banter line twice inside half an hour, which is the most
 * robotic thing a regular can do. Three hours of its own lines, capped, is what
 * the repeat clause is weighed against for the speaker.
 */
const OWN_MEMORY_MS = 3 * HOUR;
const OWN_MEMORY_MAX = 60;
/** Fresh template draws for a line refused only as a repeat, before the pass gives up on it. */
const TEMPLATE_TRIES = 3;

/** A call is announced only within this long of the fill — facts.ts's window, restated as the conductor's own promise. */
const CALL_WINDOW_MS = 6 * HOUR;

/**
 * A GM ONLY WHILE IT STILL READS AS ONE. Wake-up is the end of the agent's own
 * sleep window; a process that starts at three in the afternoon has missed the
 * morning and says nothing rather than "gm" at teatime. Every jittered wake-up
 * (05:45–08:15) plus this stays inside the same local day.
 */
const GM_WINDOW_MIN = 240;
const GM_BACK_CHANCE = 0.35;
const GM_BACK_MAX = 4;

/**
 * GN IN THE LAST MINUTES BEFORE THE WINDOW, NOT AFTER IT OPENS. The contract
 * says "crossing into the sleep window"; saying it just before keeps "an asleep
 * agent never speaks" absolute, so the hours an owner sees on the screen are
 * exactly the hours their agent is silent. After a gn the agent stays quiet
 * until the window opens.
 */
const GN_LEAD_MIN = 20;
const GN_CHANCE = 0.6;

/** A line naming or replying to an awake agent draws an answer with probability 0.6^depth, depth ≤ 4. */
const REPLY_DECAY = 0.6;
const MAX_DEPTH = 4;
/** Two agents who have traded this many replies in the last few lines have had their say. */
const PAIR_LIMIT = 3;
const PAIR_WINDOW = 10;

/** An owner line older than this when first seen is history, not a question. */
const OWNER_WINDOW_MS = 15 * MIN;

/** A banter line is sometimes a reply to something recent, so the room is a conversation and not a queue of monologues. */
const BANTER_AS_REPLY = 0.25;
const TOPICS: readonly ["owner" | "life" | "market" | "self" | "room", number][] = [
  ["owner", 3],
  ["life", 3],
  ["self", 2],
  ["room", 2],
  ["market", 1],
];
/** A queued line due this soon means the room is about to speak; banter would talk over it. */
const SOON_MS = 60 * SEC;

const MODEL_PAUSE_MS = 15 * MIN;
/**
 * A MODEL THAT ANSWERS NOTHING THIS MANY TIMES RUNNING IS PAUSED TOO. llmLine
 * turns a timeout into null without an error, so a provider that hangs is
 * invisible to the failure classifier; a streak of silence is the only symptom,
 * and fifteen minutes of templates is cheap next to twenty seconds per line.
 */
const SILENT_MODEL_LIMIT = 6;
const MODEL_INTENTS: ReadonlySet<Intent["kind"]> = new Set(["banter", "reply", "call", "call-react"]);

const PRUNE_EVERY_MS = HOUR;
/** Lookback for who last spoke / said gm / said gn. A local day is at most ~26 h of UTC. */
const ACTIVITY_LOOKBACK_MS = 36 * HOUR;
/** Lookback for the dedupe keys already used: every call still inside its window, plus the hour ceiling. */
const SCAN_LOOKBACK_MS = CALL_WINDOW_MS + HOUR;
const SCAN_PAGE = 200;
const SCAN_PAGES_MAX = 25;

/**
 * MORE NEWCOMERS THAN THIS IN ONE PASS JOIN QUIETLY. The contract's first-run
 * rule covers an empty room; a burst of first sightings in a room that is not
 * empty is the same event wearing a different hat — a replica's first pass over
 * leases it just took, or the first deploy of the room racing a second replica —
 * and greeting forty agents at once is exactly what that rule exists to stop.
 */
const JOIN_BURST = 3;

const QUEUE_MAX = 300;
/** In-memory bookkeeping bounds; the durable keys are the real guarantee. */
const SAID_TTL_MS = 30 * HOUR;
const MEMO_MAX = 5000;
/** The same failure is logged at most this often, so a dead database is one line in ten minutes and not forty. */
const FAIL_LOG_EVERY_MS = 10 * MIN;

/** The room's own voice on system lines. */
const SYSTEM_NAME = "merrymen";

/** An owner line that is only a greeting — the web route's GM_LINE, repeated for rows written before it set kind "gm". */
const OWNER_GM =
  /^(?:gm+|good\s+morning)(?:[\s,]+(?:gm+|all|everyone|everybody|y'?all|fam|frens?|friends|folks|guys|gang|team|room|chat|merrymen))*[^\p{L}\p{N}]*$/iu;

/** The owner's nominal night, for `ownerAwake` only: the agent's own window is jittered, a person's is not. */
const OWNER_NIGHT_START = 23 * 60;
const OWNER_NIGHT_END = 7 * 60;

// ── shapes ──────────────────────────────────────────────────────────────────

type Label = "open" | "join" | "hello" | "welcome" | "gm" | "gm-back" | "gn" | "call" | "call-react" | "reply" | "banter";

interface Job {
  label: Label;
  prio: number;
  due: number;
  expires: number;
  /** The speaking agent's lowercased tenant; null for the room's own line. */
  speaker: string | null;
  intent: Intent | null;
  /** System lines only. */
  body: string | null;
  kind: MessageKind;
  replyTo: number | null;
  dedupeKey: string | null;
  /** Answering a line addressed to this agent: the cooldown does not apply. */
  addressed: boolean;
  /** Conversation depth of the line this job would write. */
  depth: number;
  call: CallFact | null;
  /** gm/gn only: the local day the line settles. */
  day: string | null;
  /** gn only: when the agent's window opens, to keep it quiet until then. */
  quietUntil: number | null;
  /** Held in the queue across passes, as opposed to re-detected every pass. */
  queued: boolean;
}

interface Speaker {
  tenant: string;
  facts: AgentFacts;
  tz: string | null;
  muted: boolean;
  asleep: boolean;
  /** Awake, not muted, and not winding down after its gn. */
  canSpeak: boolean;
}

interface AgentState {
  lastSpokeMs: number;
  gmDay: string | null;
  gnDay: string | null;
  /** One roll per approaching sleep window, keyed by the minute the window opens. */
  gnRoll: { at: number; yes: boolean } | null;
  quietUntilMs: number;
  /** When this agent's lines in the last hour were written. */
  hour: number[];
  /** What this agent said lately, oldest first — its own lines, so it never repeats itself (see OWN_MEMORY_MS). */
  lines: { at: number; body: string }[];
}

/** Everything one pass knows, grown as it writes. */
interface Pass {
  shared: Db;
  nowMs: number;
  speakers: Map<string, Speaker>;
  /** The room's tail, ascending, plus the lines this pass wrote. */
  room: StoredMessage[];
  rosterNames: string[];
  wrote: number;
  labels: Label[];
  modelLines: number;
  /** Model lines the gate refused (the template spoke instead). */
  modelRefused: number;
  /** Template lines the gate refused, by reason. */
  refused: Map<string, number>;
  spoke: Set<string>;
  events: string[];
}

type Outcome = "wrote" | "keep" | "drop";

// ── small pure helpers ──────────────────────────────────────────────────────

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function count(n: unknown, fallback: number, min: number): number {
  return typeof n === "number" && Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

function messageOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : String(e);
  return raw.replace(/\s+/g, " ").trim().slice(0, 160) || "unknown error";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "gm-back ×2, call" — the log names what was written, never what it said. */
function summarise(labels: Label[]): string {
  const counts = new Map<Label, number>();
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1);
  return [...counts].map(([l, n]) => (n > 1 ? `${l} ×${n}` : l)).join(", ");
}

/** The quiet gap before banter: shorter in a busy room, never under 15 s or over 90 s, then jittered. */
function quietGapMs(awake: number, jitter: number): number {
  const base = Math.min(90, Math.max(15, 90 / Math.sqrt(awake + 1)));
  return base * (0.6 + jitter) * SEC;
}

/** Whether the owner is plausibly up, from their zone alone. Null when the zone is unknown. */
function ownerAwakeOf(tz: string | null, nowMs: number): boolean | null {
  if (!tz) return null;
  const m = localMinutes(tz, nowMs);
  if (m === null) return null;
  return !(m >= OWNER_NIGHT_START || m < OWNER_NIGHT_END);
}

function trimHour(list: number[], nowMs: number): void {
  const floor = nowMs - HOUR;
  let i = 0;
  while (i < list.length && list[i]! <= floor) i++;
  if (i > 0) list.splice(0, i);
}

function capMap<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) {
    const oldest = m.keys().next();
    if (oldest.done) break;
    m.delete(oldest.value);
  }
}

function capSet<K>(s: Set<K>, max: number): void {
  while (s.size > max) {
    const oldest = s.values().next();
    if (oldest.done) break;
    s.delete(oldest.value);
  }
}

// ── the conductor ───────────────────────────────────────────────────────────

export function makeConductor(opts: ConductorOptions): Conductor {
  const creds = opts.creds ?? null;
  const rawRng = opts.rng ?? Math.random;
  const maxPerPass = count(opts.maxPerPass, 3, 1);
  const perHour = count(opts.perHour, 240, 1);
  const perAgentPerHour = count(opts.perAgentPerHour, 30, 1);
  // NO CREDS, NO MODEL, whatever the budget says: the budget is a ceiling on a
  // key, and there is no key.
  const llmPerDay = creds ? count(opts.llmPerDay, 1200, 0) : 0;
  const retentionDays = count(opts.retentionDays, 14, 1);
  const loadRoomFacts = opts.facts ?? loadFacts;
  const dialect = opts.dialect ?? "postgres";

  /** The caller's rng, made total: a NaN or a 7 costs variety, never a throw or an index off the end. */
  const rng = (): number => {
    let v: number;
    try {
      v = Number(rawRng());
    } catch {
      v = 0.5;
    }
    if (!Number.isFinite(v)) return 0.5;
    const f = v - Math.floor(v);
    return f >= 0 && f < 1 ? f : 0;
  };
  const between = (a: number, b: number): number => a + rng() * (b - a);
  const shuffled = <T>(list: T[]): T[] => {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };

  // ── lazy state ────────────────────────────────────────────────────────────

  const agents = new Map<string, AgentState>();
  const queue: Job[] = [];
  /** Dedupe keys known to be used, with when — so an attempt that would be refused is never paid for. */
  const said = new Map<string, number>();
  const depthOf = new Map<number, number>();
  const handledOwner = new Set<number>();
  const welcomed = new Set<string>();
  const nameRes = new Map<string, RegExp>();
  const roomHour: number[] = [];
  /** The highest line id already reacted to. Null until the first pass, which reacts to nothing that came before it. */
  let cursor: number | null = null;
  let rebuilt = false;
  let lastPruneMs = Number.NEGATIVE_INFINITY;
  let running = false;
  let lastFail: { text: string; at: number } | null = null;
  /** The jittered quiet gap, drawn once per silence (keyed by the line the silence follows). */
  const gap = { afterId: -1, ms: 0 };
  const model = {
    day: -1,
    used: 0,
    pausedUntil: 0,
    stopped: false,
    silent: 0,
    /** A state change to report on the next log line. */
    note: null as string | null,
    /** The latest step's clock, for a failure that surfaces after its race was lost. */
    now: 0,
  };

  const stateOf = (tenant: string): AgentState => {
    let s = agents.get(tenant);
    if (!s) {
      s = { lastSpokeMs: 0, gmDay: null, gnDay: null, gnRoll: null, quietUntilMs: 0, hour: [], lines: [] };
      agents.set(tenant, s);
    }
    return s;
  };

  const nameRe = (name: string): RegExp => {
    let re = nameRes.get(name);
    if (!re) {
      re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(name)}(?![\\p{L}\\p{N}_])`, "iu");
      nameRes.set(name, re);
      capMap(nameRes, 1000);
    }
    return re;
  };

  /**
   * WHETHER A LINE NAMES THIS AGENT, as opposed to its owner. Every answer to
   * an owner opens "hey Amber Heron's owner", and counting that as naming Amber
   * Heron had the agent answering lines that were never meant for it.
   */
  const namesAgent = (name: string, body: string): boolean =>
    nameRe(name).test(body.replace(new RegExp(`${escapeRe(name)}['’]s owner`, "giu"), " "));

  const roomFull = (nowMs: number): boolean => {
    trimHour(roomHour, nowMs);
    return roomHour.length >= perHour;
  };

  // ── the model ─────────────────────────────────────────────────────────────

  const noteFailure = (e: unknown): void => {
    const kind = describeLlmFailure(messageOf(e)).kind;
    if (kind === "key-rejected" || kind === "model-missing") {
      // A KEY THAT WAS REFUSED STAYS REFUSED until somebody changes it, and
      // that takes a restart. Asking again every line would spend a request to
      // learn the same thing — templates carry on either way.
      if (!model.stopped) model.note = `model off until restart (${kind})`;
      model.stopped = true;
      return;
    }
    if (kind === "rate-limited") {
      // THE HOUSE ALLOWANCE IS NOT OURS TO EXHAUST. Even on a dedicated key a
      // 429 means back off; fifteen minutes of templates costs nothing.
      model.pausedUntil = model.now + MODEL_PAUSE_MS;
      model.silent = 0;
      model.note = "model paused 15m (rate-limited)";
      return;
    }
    model.silent += 1;
    if (model.silent >= SILENT_MODEL_LIMIT) {
      model.pausedUntil = model.now + MODEL_PAUSE_MS;
      model.silent = 0;
      model.note = `model paused 15m (${kind} ×${SILENT_MODEL_LIMIT})`;
    }
  };

  /**
   * THE DEFAULT MODEL, WITH ITS FAILURES MADE VISIBLE. llmLine swallows every
   * error into null — the right contract for a line, the wrong one for a
   * budget — so it is handed an observer that sees the provider's error before
   * it becomes silence. Through llmLine's own seam, not by wrapping llmText
   * here: voice.ts is the room's one importer of llm.ts. A failure that lands
   * after llmLine's timeout still reaches the observer, against the latest clock.
   */
  const defaultLlm = (c: LlmCreds, intent: Intent, ctx: SpeakCtx, onFailure: (e: unknown) => void): Promise<string | null> =>
    llmLine(c, intent, ctx, { onError: onFailure });

  const modelReady = (nowMs: number): boolean =>
    creds !== null && !model.stopped && nowMs >= model.pausedUntil && model.used < llmPerDay;

  async function askModel(p: Pass, intent: Intent, ctx: SpeakCtx): Promise<string | null> {
    if (!creds || !modelReady(p.nowMs)) return null;
    model.used += 1;
    let failed = false;
    const onFailure = (e: unknown) => {
      failed = true;
      noteFailure(e);
    };
    let out: string | null;
    try {
      out = opts.llm ? await opts.llm(creds, intent, ctx) : await defaultLlm(creds, intent, ctx, onFailure);
    } catch (e) {
      onFailure(e);
      return null;
    }
    if (typeof out === "string" && out.trim() !== "") {
      model.silent = 0;
      return out;
    }
    if (!failed) {
      model.silent += 1;
      if (model.silent >= SILENT_MODEL_LIMIT) {
        model.pausedUntil = p.nowMs + MODEL_PAUSE_MS;
        model.silent = 0;
        model.note = `model paused 15m (no answer ×${SILENT_MODEL_LIMIT})`;
      }
    }
    return null;
  }

  // ── lines ─────────────────────────────────────────────────────────────────

  function speakCtx(p: Pass, sp: Speaker): SpeakCtx {
    return {
      speaker: sp.facts,
      style: styleFor(sp.facts.slug ?? sp.facts.name),
      tail: p.room.slice(-PROMPT_TAIL).map((m) => ({ name: m.speakerName, author: m.authorKind, body: m.body })),
      rosterNames: p.rosterNames,
      phase: phaseOf(sp.tz, p.nowMs),
      ownerAwake: ownerAwakeOf(sp.tz, p.nowMs),
    };
  }

  /** What the gate judges this speaker's line against: its own coins, the room's names, its own and the room's recent lines. */
  function gateCtx(p: Pass, sp: Speaker): AgentLineCtx {
    const vouched: string[] = [];
    for (const c of sp.facts.calls) {
      if (c.symbol) vouched.push(c.symbol);
      if (c.name) vouched.push(c.name);
    }
    const own = new Set(p.room.filter((m) => m.authorKind === "agent" && m.tenant.toLowerCase() === sp.tenant).map((m) => m.body));
    const floor = p.nowMs - OWN_MEMORY_MS;
    for (const l of stateOf(sp.tenant).lines) if (l.at > floor) own.add(l.body);
    return {
      vouchedSymbols: vouched,
      rosterNames: p.rosterNames,
      recentOwn: [...own],
      recentRoom: p.room.map((m) => m.body),
    };
  }

  function rememberLine(tenant: string, at: number, body: string): void {
    const lines = stateOf(tenant).lines;
    lines.push({ at, body });
    const floor = at - OWN_MEMORY_MS;
    let i = 0;
    while (i < lines.length && (lines[i]!.at <= floor || lines.length - i > OWN_MEMORY_MAX)) i++;
    if (i > 0) lines.splice(0, i);
  }

  /**
   * The line this speaker says for this intent, gated, or null.
   *
   * THE MODEL ONLY WHERE IT EARNS ITS COST — banter, replies, calls and
   * reactions — and only within budget; a gm is a gm. Whatever the model says
   * goes through the same gate as a template, and a refusal costs the line its
   * model, not the line: the template is the backbone.
   */
  async function lineFor(p: Pass, sp: Speaker, intent: Intent): Promise<{ text: string; model: boolean } | null> {
    const ctx = speakCtx(p, sp);
    const gate = gateCtx(p, sp);
    if (MODEL_INTENTS.has(intent.kind) && modelReady(p.nowMs)) {
      const out = await askModel(p, intent, ctx);
      if (out !== null) {
        const v = admitAgentLine(out, gate);
        if (v.ok) return { text: v.text, model: true };
        // Counted, not logged: a model steered by something it read is the
        // case this gate exists for, and the count is how anyone notices.
        p.modelRefused += 1;
      }
    }
    // templateLine only sees the tail, so a line it offers can still be one this
    // agent said an hour ago; a repeat earns a fresh draw, anything else does not.
    let reason = "repeat";
    for (let i = 0; i < TEMPLATE_TRIES && reason === "repeat"; i++) {
      const v = admitAgentLine(templateLine(intent, ctx, rng), gate);
      if (v.ok) return { text: v.text, model: false };
      reason = v.reason;
    }
    // A REFUSED TEMPLATE IS A BUG SIGNAL — except "repeat", which is the room
    // having already said everything this agent had to say. Counted by reason
    // for the log line so the two are never confused.
    p.refused.set(reason, (p.refused.get(reason) ?? 0) + 1);
    return null;
  }

  function remember(p: Pass, j: Job, id: number, row: Omit<StoredMessage, "id" | "hidden">): void {
    p.wrote += 1;
    p.labels.push(j.label);
    roomHour.push(p.nowMs);
    if (j.dedupeKey) said.set(j.dedupeKey, p.nowMs);
    depthOf.set(id, j.depth);
    p.room.push({ ...row, id, hidden: false });
    if (j.speaker) {
      const st = stateOf(j.speaker);
      st.lastSpokeMs = p.nowMs;
      st.hour.push(p.nowMs);
      rememberLine(j.speaker, p.nowMs, row.body);
      p.spoke.add(j.speaker);
      if (j.label === "gm" && j.day) st.gmDay = j.day;
      if (j.label === "gn") {
        if (j.day) st.gnDay = j.day;
        if (j.quietUntil !== null) st.quietUntilMs = j.quietUntil;
      }
    }
  }

  /** A dedupe hit: the line was already said, by this process before a restart or by another replica. */
  function settle(j: Job): void {
    if (j.dedupeKey) said.set(j.dedupeKey, model.now);
    if (!j.speaker) return;
    const st = stateOf(j.speaker);
    if (j.label === "gm" && j.day) st.gmDay = j.day;
    if (j.label === "gn" && j.day) st.gnDay = j.day;
  }

  async function attempt(p: Pass, j: Job): Promise<Outcome> {
    if (j.dedupeKey && said.has(j.dedupeKey)) return "drop";

    if (j.speaker === null) {
      if (!j.body) return "drop";
      const row = {
        createdAtMs: p.nowMs,
        authorKind: "system" as const,
        tenant: "",
        agentId: null,
        speakerSlug: null,
        speakerName: SYSTEM_NAME,
        body: j.body,
        replyTo: null,
        kind: j.kind,
        call: null,
        callDecisionId: null,
        dedupeKey: j.dedupeKey,
      };
      const id = await appendMessage(p.shared, row);
      if (id === null) {
        settle(j);
        return "drop";
      }
      remember(p, j, id, row);
      return "wrote";
    }

    const sp = p.speakers.get(j.speaker);
    // Gone from the roster, or muted by its owner: nothing to wait for.
    if (!sp || sp.muted || !j.intent) return "drop";
    // Asleep or winding down: a queued line waits for morning or its expiry.
    if (!sp.canSpeak) return "keep";
    if (p.spoke.has(sp.tenant)) return "keep";
    const st = stateOf(sp.tenant);
    trimHour(st.hour, p.nowMs);
    if (st.hour.length >= perAgentPerHour) return "keep";
    if (!j.addressed && p.nowMs - st.lastSpokeMs < COOLDOWN_MS) return "keep";

    const line = await lineFor(p, sp, j.intent);
    if (!line) return "drop";
    const call = j.call;
    const row = {
      createdAtMs: p.nowMs,
      authorKind: "agent" as const,
      tenant: sp.tenant,
      agentId: sp.facts.agentId,
      speakerSlug: sp.facts.slug,
      speakerName: sp.facts.name,
      body: line.text,
      replyTo: j.replyTo,
      kind: j.kind,
      call: call ? { side: call.side, symbol: call.symbol, name: call.name, token: call.token, paper: call.paper } : null,
      callDecisionId: call ? call.decisionId : null,
      dedupeKey: j.dedupeKey,
    };
    const id = await appendMessage(p.shared, row);
    if (id === null) {
      settle(j);
      return "drop";
    }
    if (line.model) p.modelLines += 1;
    remember(p, j, id, row);
    return "wrote";
  }

  // ── reactions ─────────────────────────────────────────────────────────────

  function enqueue(j: Omit<Job, "queued" | "body" | "day" | "quietUntil" | "call"> & { body?: string }): void {
    if (j.dedupeKey && (said.has(j.dedupeKey) || queue.some((q) => q.dedupeKey === j.dedupeKey))) return;
    queue.push({ ...j, body: j.body ?? null, day: null, quietUntil: null, call: null, queued: true });
  }

  const reKey = (lineId: number, tenant: string): string => `re:${lineId}:${tenant}`;

  function depthFor(m: StoredMessage): number {
    const known = depthOf.get(m.id);
    if (known !== undefined) return known;
    if (m.replyTo === null) return 0;
    const parent = depthOf.get(m.replyTo);
    return parent === undefined ? 1 : parent + 1;
  }

  const authorTenant = (m: StoredMessage | undefined | null): string | null =>
    m && m.authorKind === "agent" ? m.tenant.toLowerCase() : null;

  /**
   * How many times these two agents have answered each other in the last few
   * lines. A conversation between two regulars is charming for a few lines and
   * a malfunction after that.
   */
  function pairTalk(p: Pass, a: string, b: string): number {
    const byId = new Map(p.room.map((m) => [m.id, m]));
    let n = 0;
    for (const m of p.room.slice(-PAIR_WINDOW)) {
      const who = authorTenant(m);
      if (who !== a && who !== b) continue;
      const parent = m.replyTo === null ? null : authorTenant(byId.get(m.replyTo));
      if (parent !== null && parent !== who && (parent === a || parent === b)) n++;
    }
    return n;
  }

  const awakeOthers = (p: Pass, not: string | null): Speaker[] =>
    [...p.speakers.values()].filter((s) => s.canSpeak && s.tenant !== not);

  function queueWelcomes(p: Pass, line: StoredMessage, newcomer: string, name: string): void {
    // ONE ROUND OF WELCOMES PER NEWCOMER: one welcomed on its join line at
    // night is not welcomed again when its hello lands in the morning.
    if (welcomed.has(newcomer)) return;
    welcomed.add(newcomer);
    capSet(welcomed, MEMO_MAX);
    const n = 1 + Math.floor(rng() * 2);
    for (const sp of shuffled(awakeOthers(p, newcomer)).slice(0, n)) {
      enqueue({
        label: "welcome",
        prio: 1.5,
        due: p.nowMs + between(10 * SEC, 2 * MIN),
        expires: p.nowMs + 30 * MIN,
        speaker: sp.tenant,
        intent: { kind: "welcome", to: name },
        kind: "chat",
        replyTo: line.id,
        dedupeKey: reKey(line.id, sp.tenant),
        addressed: false,
        depth: depthFor(line) + 1,
      });
    }
  }

  function queueGmBacks(p: Pass, line: StoredMessage, author: string): void {
    let n = 0;
    for (const sp of shuffled(awakeOthers(p, author))) {
      if (n >= GM_BACK_MAX) break;
      if (rng() >= GM_BACK_CHANCE) continue;
      n++;
      enqueue({
        label: "gm-back",
        prio: 3.5,
        due: p.nowMs + between(20 * SEC, 6 * MIN),
        expires: p.nowMs + 20 * MIN,
        speaker: sp.tenant,
        intent: { kind: "gm-back", to: line.speakerName },
        kind: "gm",
        replyTo: line.id,
        dedupeKey: reKey(line.id, sp.tenant),
        addressed: false,
        depth: depthFor(line) + 1,
      });
    }
  }

  function queueCallReacts(p: Pass, line: StoredMessage, author: string): void {
    if (!line.call) return;
    const n = Math.floor(rng() * 3);
    for (const sp of shuffled(awakeOthers(p, author)).slice(0, n)) {
      enqueue({
        label: "call-react",
        prio: 2.5,
        due: p.nowMs + between(30 * SEC, 4 * MIN),
        expires: p.nowMs + 20 * MIN,
        speaker: sp.tenant,
        intent: { kind: "call-react", to: line.speakerName, call: line.call },
        kind: "chat",
        replyTo: line.id,
        dedupeKey: reKey(line.id, sp.tenant),
        addressed: false,
        depth: depthFor(line) + 1,
      });
    }
  }

  /** Rule 5: a line that replies to, or names, an awake agent may draw that agent's answer. */
  function queueAnswers(p: Pass, line: StoredMessage, author: string): void {
    const targets = new Set<string>();
    const parent = line.replyTo === null ? null : p.room.find((m) => m.id === line.replyTo);
    const parentAuthor = authorTenant(parent);
    if (parentAuthor && parentAuthor !== author) targets.add(parentAuthor);
    for (const sp of p.speakers.values()) {
      if (sp.tenant !== author && namesAgent(sp.facts.name, line.body)) targets.add(sp.tenant);
    }
    const d = depthFor(line) + 1;
    if (d > MAX_DEPTH) return;
    for (const t of targets) {
      const sp = p.speakers.get(t);
      if (!sp || !sp.canSpeak) continue;
      if (pairTalk(p, author, t) >= PAIR_LIMIT) continue;
      if (rng() >= REPLY_DECAY ** d) continue;
      enqueue({
        label: "reply",
        prio: 5,
        due: p.nowMs + between(5 * SEC, 40 * SEC),
        expires: p.nowMs + 10 * MIN,
        speaker: t,
        intent: { kind: "reply", to: line.speakerName, toAuthor: "agent", toOwnAgent: false, text: line.body },
        kind: "chat",
        replyTo: line.id,
        dedupeKey: reKey(line.id, t),
        addressed: true,
        depth: d,
      });
    }
  }

  function reactTo(p: Pass, m: StoredMessage): void {
    if (m.authorKind === "system") {
      // A NEWCOMER THAT CANNOT SAY HELLO YET is welcomed on its join line, so
      // it is not left unanswered until it wakes up.
      if (m.kind === "join" && m.dedupeKey?.startsWith("join:")) {
        const joiner = m.dedupeKey.slice("join:".length);
        const sp = p.speakers.get(joiner);
        if (sp && !sp.canSpeak) queueWelcomes(p, m, joiner, sp.facts.name);
      }
      return;
    }
    // Owner lines have their own rule (answerOwners), which runs every pass.
    if (m.authorKind !== "agent") return;
    const author = m.tenant.toLowerCase();
    if (m.dedupeKey?.startsWith("hello:")) {
      queueWelcomes(p, m, author, m.speakerName);
      return;
    }
    if (m.kind === "gm" && m.replyTo === null) {
      queueGmBacks(p, m, author);
      return;
    }
    // A gm-back or a gn needs no answer, and answering one starts a chorus.
    if (m.kind === "gm" || m.kind === "gn") return;
    if (m.kind === "call") queueCallReacts(p, m, author);
    queueAnswers(p, m, author);
  }

  /**
   * Rule 1: an owner line nobody has answered. Their OWN agent answers first
   * when it can; then agents the line named or replied to; then up to two more.
   * An owner's gm gets two to four gm-backs instead.
   */
  function answerOwners(p: Pass): void {
    for (const o of p.room) {
      if (o.authorKind !== "owner" || handledOwner.has(o.id)) continue;
      handledOwner.add(o.id);
      if (p.nowMs - o.createdAtMs > OWNER_WINDOW_MS) continue;
      // ANSWERED ALREADY — by this process before a restart, or by another
      // replica whose agent this owner owns. Either way the question is closed.
      if (p.room.some((m) => m.authorKind === "agent" && m.replyTo === o.id)) continue;

      const ownerTenant = o.tenant.toLowerCase();
      const gm = o.kind === "gm" || OWNER_GM.test(o.body.trim());
      const taken = new Set<string>();
      const own = p.speakers.get(ownerTenant);
      if (own && own.canSpeak) {
        taken.add(own.tenant);
        enqueue({
          label: "reply",
          prio: 1,
          due: p.nowMs + between(3 * SEC, 15 * SEC),
          expires: p.nowMs + OWNER_WINDOW_MS,
          speaker: own.tenant,
          intent: { kind: "reply", to: o.speakerName, toAuthor: "owner", toOwnAgent: true, text: o.body },
          kind: gm ? "gm" : "chat",
          replyTo: o.id,
          dedupeKey: reKey(o.id, own.tenant),
          addressed: true,
          depth: 1,
        });
      }

      if (gm) {
        const want = 2 + Math.floor(rng() * 3);
        for (const sp of shuffled(awakeOthers(p, ownerTenant))) {
          if (taken.size >= want) break;
          taken.add(sp.tenant);
          enqueue({
            label: "gm-back",
            prio: 1.2,
            due: p.nowMs + between(10 * SEC, 3 * MIN),
            expires: p.nowMs + OWNER_WINDOW_MS,
            speaker: sp.tenant,
            intent: { kind: "gm-back", to: o.speakerName },
            kind: "gm",
            replyTo: o.id,
            dedupeKey: reKey(o.id, sp.tenant),
            addressed: false,
            depth: 1,
          });
        }
        continue;
      }

      const addressed = new Set<string>();
      const parent = o.replyTo === null ? null : p.room.find((m) => m.id === o.replyTo);
      const parentAuthor = authorTenant(parent);
      if (parentAuthor) addressed.add(parentAuthor);
      for (const sp of p.speakers.values()) if (namesAgent(sp.facts.name, o.body)) addressed.add(sp.tenant);
      for (const t of addressed) {
        const sp = p.speakers.get(t);
        if (!sp || !sp.canSpeak || taken.has(t)) continue;
        taken.add(t);
        enqueue({
          label: "reply",
          prio: 1.1,
          due: p.nowMs + between(8 * SEC, 40 * SEC),
          expires: p.nowMs + OWNER_WINDOW_MS,
          speaker: t,
          intent: { kind: "reply", to: o.speakerName, toAuthor: "owner", toOwnAgent: false, text: o.body },
          kind: "chat",
          replyTo: o.id,
          dedupeKey: reKey(o.id, t),
          addressed: true,
          depth: 1,
        });
      }
      const extra = Math.floor(rng() * 3) - (taken.size - (own && taken.has(own.tenant) ? 1 : 0));
      for (const sp of shuffled(awakeOthers(p, ownerTenant).filter((s) => !taken.has(s.tenant))).slice(0, Math.max(0, extra))) {
        enqueue({
          label: "reply",
          prio: 1.3,
          due: p.nowMs + between(30 * SEC, 3 * MIN),
          expires: p.nowMs + OWNER_WINDOW_MS,
          speaker: sp.tenant,
          intent: { kind: "reply", to: o.speakerName, toAuthor: "owner", toOwnAgent: false, text: o.body },
          kind: "chat",
          replyTo: o.id,
          dedupeKey: reKey(o.id, sp.tenant),
          addressed: false,
          depth: 1,
        });
      }
    }
    capSet(handledOwner, MEMO_MAX);
  }

  // ── what is due now ───────────────────────────────────────────────────────

  function detected(p: Pass): Job[] {
    const jobs: Job[] = [];
    const base = { body: null, replyTo: null, addressed: false, depth: 0, queued: false, quietUntil: null } as const;
    for (const sp of p.speakers.values()) {
      if (!sp.canSpeak) continue;
      const st = stateOf(sp.tenant);

      // Rule 2: the oldest call not yet announced, still inside its window.
      // An asleep agent never gets here, so its calls wait for morning; one
      // past the window is simply never picked.
      let next: CallFact | null = null;
      for (const c of sp.facts.calls) {
        const at = c.atSec * SEC;
        if (!c.decisionId || !Number.isFinite(at) || at > p.nowMs + MIN || p.nowMs - at > CALL_WINDOW_MS) continue;
        if (said.has(`call:${c.decisionId}`)) continue;
        if (!next || c.atSec < next.atSec) next = c;
      }
      if (next) {
        jobs.push({
          ...base,
          label: "call",
          prio: 2,
          due: p.nowMs,
          expires: p.nowMs,
          speaker: sp.tenant,
          intent: { kind: "call", call: next, tradedWhileAsleep: isAsleep(sp.tz, sp.tenant, next.atSec * SEC) },
          kind: "call",
          dedupeKey: `call:${next.decisionId}`,
          call: next,
          day: null,
        });
      }

      // Rules 3 and 4 need a zone: an agent whose owner's zone is unknown
      // never sleeps, so it never wakes up and never says goodnight either.
      if (!sp.tz) continue;
      const m = localMinutes(sp.tz, p.nowMs);
      if (m === null) continue;
      const { startMin, endMin } = sleepWindow(sp.tenant);
      const day = localDay(sp.tz, p.nowMs);

      if (st.gmDay !== day && mod(m - endMin, DAY_MIN) < GM_WINDOW_MIN) {
        jobs.push({
          ...base,
          label: "gm",
          // GM BEFORE ITS OWN NEWS. An agent speaks once a pass, so whichever of
          // its two lines sorts first is what the room hears first; "while i was
          // quiet i picked up …" followed by "gm" reads backwards. So a waking
          // agent with news sorts just ahead of the calls; another agent's call
          // that loses its slot to it waits one pass, not its window.
          prio: next ? 1.9 : 3,
          due: p.nowMs,
          expires: p.nowMs,
          speaker: sp.tenant,
          intent: { kind: "gm" },
          kind: "gm",
          dedupeKey: `gm:${sp.tenant}:${day}`,
          call: null,
          day,
        });
      }

      const untilSleep = mod(startMin - m, DAY_MIN);
      if (untilSleep > 0 && untilSleep <= GN_LEAD_MIN && st.gnDay !== day) {
        // The window's opening minute, in whole minutes since the epoch. Built
        // from the floored minute so every step inside one approach agrees on
        // it (zones are whole-minute offsets), and so the roll happens once.
        const opensAt = Math.floor(p.nowMs / MIN) + untilSleep;
        if (!st.gnRoll || st.gnRoll.at !== opensAt) st.gnRoll = { at: opensAt, yes: rng() < GN_CHANCE };
        if (st.gnRoll.yes) {
          jobs.push({
            ...base,
            label: "gn",
            prio: 4,
            due: p.nowMs,
            expires: p.nowMs,
            speaker: sp.tenant,
            intent: { kind: "gn" },
            kind: "gn",
            dedupeKey: `gn:${sp.tenant}:${day}`,
            call: null,
            day,
            quietUntil: opensAt * MIN,
          });
        }
      }
    }
    return jobs;
  }

  /** Rule 6: the room has been quiet for its jittered gap, so somebody who has not spoken lately starts something. */
  function quietJob(p: Pass): Job | null {
    const awake = awakeOthers(p, null);
    if (awake.length === 0) return null;
    const last = p.room.length > 0 ? p.room[p.room.length - 1]! : null;
    const lastId = last ? last.id : 0;
    if (gap.afterId !== lastId) {
      gap.afterId = lastId;
      gap.ms = quietGapMs(awake.length, rng());
    }
    if (last && p.nowMs - last.createdAtMs < gap.ms) return null;

    const lastAuthor = authorTenant(last);
    let eligible = awake.filter((sp) => {
      const st = stateOf(sp.tenant);
      trimHour(st.hour, p.nowMs);
      return !p.spoke.has(sp.tenant) && st.hour.length < perAgentPerHour && p.nowMs - st.lastSpokeMs >= COOLDOWN_MS;
    });
    if (eligible.length > 1 && lastAuthor) eligible = eligible.filter((sp) => sp.tenant !== lastAuthor);
    if (eligible.length === 0) return null;

    // "HAS NOT SPOKEN FOR A WHILE", as a weight rather than a threshold: the
    // longest-silent agent is likeliest, but nobody is locked out of a small room.
    const weights = eligible.map((sp) => Math.min(p.nowMs - stateOf(sp.tenant).lastSpokeMs, 30 * MIN) + MIN);
    let x = rng() * weights.reduce((a, b) => a + b, 0);
    let sp = eligible[eligible.length - 1]!;
    for (let i = 0; i < eligible.length; i++) {
      x -= weights[i]!;
      if (x < 0) {
        sp = eligible[i]!;
        break;
      }
    }

    const base = { body: null, queued: false, quietUntil: null, call: null, day: null, addressed: false } as const;
    if (rng() < BANTER_AS_REPLY) {
      const candidates = p.room
        .slice(-6)
        .filter((m) => {
          const who = authorTenant(m);
          if (!who || who === sp.tenant || (m.kind !== "chat" && m.kind !== "call")) return false;
          if (said.has(reKey(m.id, sp.tenant)) || depthFor(m) + 1 > MAX_DEPTH) return false;
          return pairTalk(p, who, sp.tenant) < PAIR_LIMIT;
        });
      const target = candidates[candidates.length - 1];
      if (target) {
        return {
          ...base,
          label: "banter",
          prio: 6,
          due: p.nowMs,
          expires: p.nowMs,
          speaker: sp.tenant,
          intent: { kind: "reply", to: target.speakerName, toAuthor: "agent", toOwnAgent: false, text: target.body },
          kind: "chat",
          replyTo: target.id,
          dedupeKey: reKey(target.id, sp.tenant),
          depth: depthFor(target) + 1,
        };
      }
    }
    let y = rng() * TOPICS.reduce((a, [, w]) => a + w, 0);
    let topic = TOPICS[0]![0];
    for (const [t, w] of TOPICS) {
      y -= w;
      if (y < 0) {
        topic = t;
        break;
      }
    }
    return {
      ...base,
      label: "banter",
      prio: 6,
      due: p.nowMs,
      expires: p.nowMs,
      speaker: sp.tenant,
      // NO MOOD: the room is handed no market data, so the market topic stays
      // a vibe rather than a claim.
      intent: { kind: "banter", topic, mood: null },
      kind: "chat",
      replyTo: null,
      dedupeKey: null,
      depth: 0,
    };
  }

  // ── the first step after a start ──────────────────────────────────────────

  /**
   * REBUILD WHAT A REDEPLOY WIPED. Last spoke (the cooldown) and the gn state
   * come from agentActivity. The dedupe keys already used come from paging the
   * room back far enough to cover every call still inside its window, so a
   * restart never spends a model call writing a call line the store would then
   * refuse. The morning gm is settled by its key ("gm:<tenant>:<day>") when the
   * gm is inside that scan, and by agentActivity only when it is older — an
   * agent that spoke gm-ish more than seven hours ago today woke up long enough
   * ago that its gm window has closed anyway. (agentActivity's last gm counts
   * gm-BACKS too, which is why it cannot be the whole answer.)
   */
  async function rebuild(shared: Db, nowMs: number, memberOf: Map<string, Member>): Promise<void> {
    const horizon = nowMs - SCAN_LOOKBACK_MS;
    let before: number | null = null;
    for (let page = 0; page < SCAN_PAGES_MAX; page++) {
      const { messages, start } = await readMessages(shared, { before, limit: SCAN_PAGE });
      for (const m of messages) {
        if (m.dedupeKey && m.createdAtMs >= nowMs - SAID_TTL_MS) said.set(m.dedupeKey, m.createdAtMs);
        if (m.authorKind !== "owner" && m.createdAtMs > nowMs - HOUR) roomHour.push(m.createdAtMs);
        if (m.authorKind === "agent" && m.createdAtMs > nowMs - HOUR) stateOf(m.tenant.toLowerCase()).hour.push(m.createdAtMs);
        if (m.authorKind === "agent" && m.createdAtMs > nowMs - OWN_MEMORY_MS) {
          stateOf(m.tenant.toLowerCase()).lines.push({ at: m.createdAtMs, body: m.body });
        }
      }
      const oldest = messages[0];
      if (start || !oldest || oldest.createdAtMs < horizon) break;
      before = oldest.id;
    }
    roomHour.sort((a, b) => a - b);
    for (const st of agents.values()) {
      st.hour.sort((a, b) => a - b);
      st.lines.sort((a, b) => a.at - b.at);
      if (st.lines.length > OWN_MEMORY_MAX) st.lines.splice(0, st.lines.length - OWN_MEMORY_MAX);
    }

    for (const key of said.keys()) {
      const gm = /^gm:(.+):(\d{4}-\d{2}-\d{2})$/.exec(key);
      if (gm) {
        const st = stateOf(gm[1]!);
        if (!st.gmDay || gm[2]! > st.gmDay) st.gmDay = gm[2]!;
      }
    }

    const activity = await agentActivity(shared, nowMs - ACTIVITY_LOOKBACK_MS);
    for (const [tenant, a] of activity) {
      const t = tenant.toLowerCase();
      const st = stateOf(t);
      const tz = memberOf.get(t)?.tz ?? null;
      st.lastSpokeMs = Math.max(st.lastSpokeMs, a.lastMs);
      if (a.lastGmMs !== null && a.lastGmMs < horizon && !st.gmDay) st.gmDay = localDay(tz, a.lastGmMs);
      if (a.lastGnMs !== null) {
        st.gnDay = localDay(tz, a.lastGnMs);
        // "THEN SILENCE" SURVIVES A RESTART: an agent never speaks again between
        // its gn and its window, which opens within GN_LEAD_MIN of it.
        st.quietUntilMs = Math.max(st.quietUntilMs, a.lastGnMs + (GN_LEAD_MIN + 1) * MIN);
      }
    }
  }

  // ── one pass ──────────────────────────────────────────────────────────────

  async function pass(p: Pass, roster: RosterMember[], profiles: Map<string, ChatProfile>): Promise<void> {
    const { shared, nowMs } = p;
    await ensureGroupchatSchema(shared, dialect);

    const seen = new Set<string>();
    const cleanRoster: RosterMember[] = [];
    for (const r of Array.isArray(roster) ? roster : []) {
      if (!r || typeof r.tenant !== "string" || typeof r.agentId !== "string" || !r.tenant) continue;
      const t = r.tenant.toLowerCase();
      if (seen.has(t)) continue;
      seen.add(t);
      cleanRoster.push(r);
    }

    let members = await allMembers(shared);
    const factsRaw = cleanRoster.length > 0 ? await loadRoomFacts(shared, cleanRoster, profiles, Math.floor(nowMs / 1000)) : new Map<string, AgentFacts>();
    const facts = new Map<string, AgentFacts>();
    for (const [t, f] of factsRaw) if (seen.has(t.toLowerCase())) facts.set(t.toLowerCase(), f);

    // ── joins ──
    let memberOf = new Map(members.map((m) => [m.tenant.toLowerCase(), m]));
    const newcomers = [...facts.keys()].filter((t) => !memberOf.has(t));
    const greeted: string[] = [];
    if (newcomers.length > 0) {
      // THE FIRST RUN DOES NOT GREET FORTY AGENTS — see JOIN_BURST for the
      // same rule applied to a room that is not empty.
      const opening = members.length === 0;
      const quiet = opening || newcomers.length > JOIN_BURST;
      for (const t of newcomers) {
        if ((await joinMember(shared, t, nowMs)) && !quiet) greeted.push(t);
      }
      // Re-read: a join can claim a prefs-only row, and its zone and mute are real.
      members = await allMembers(shared);
      memberOf = new Map(members.map((m) => [m.tenant.toLowerCase(), m]));
      if (opening) {
        enqueue({
          label: "open",
          prio: -1,
          due: nowMs,
          expires: nowMs + HOUR,
          speaker: null,
          intent: null,
          body: "the group chat is open",
          kind: "chat",
          replyTo: null,
          dedupeKey: "room:open",
          addressed: false,
          depth: 0,
        });
      } else if (quiet) {
        p.events.push(`${newcomers.length} joined quietly`);
      }
    }

    const tail = await recentMessages(shared, TAIL_LINES);
    p.room.push(...tail);
    if (!rebuilt) {
      await rebuild(shared, nowMs, memberOf);
      rebuilt = true;
      cursor = tail.reduce((mx, m) => Math.max(mx, m.id), cursor ?? 0);
    }

    // ── who is here ──
    for (const [t, f] of facts) {
      const member = memberOf.get(t);
      if (!member) continue;
      const asleep = isAsleep(member.tz, t, nowMs);
      const st = stateOf(t);
      p.speakers.set(t, {
        tenant: t,
        facts: f,
        tz: member.tz,
        muted: member.muted,
        asleep,
        canSpeak: !asleep && !member.muted && nowMs >= st.quietUntilMs,
      });
    }
    const names = new Set<string>();
    for (const sp of p.speakers.values()) names.add(sp.facts.name);
    for (const m of tail) if (m.authorKind === "agent" && m.speakerName) names.add(m.speakerName);
    p.rosterNames = [...names];

    for (const t of greeted) {
      const sp = p.speakers.get(t);
      if (!sp) continue;
      enqueue({
        label: "join",
        prio: 0,
        due: nowMs,
        expires: nowMs + HOUR,
        speaker: null,
        intent: null,
        body: `${sp.facts.name} joined the room`,
        kind: "join",
        replyTo: null,
        dedupeKey: `join:${t}`,
        addressed: false,
        depth: 0,
      });
      enqueue({
        label: "hello",
        prio: 0.5,
        due: nowMs + between(5 * SEC, 20 * SEC),
        // A newcomer that joins at night says hello in the morning.
        expires: nowMs + 16 * HOUR,
        speaker: t,
        intent: { kind: "hello" },
        kind: "chat",
        replyTo: null,
        dedupeKey: `hello:${t}`,
        addressed: false,
        depth: 0,
      });
    }

    // ── reactions to what is new since the last pass ──
    for (const m of tail) if (!depthOf.has(m.id)) depthOf.set(m.id, depthFor(m));
    for (const m of tail) if (cursor === null || m.id > cursor) reactTo(p, m);
    cursor = tail.reduce((mx, m) => Math.max(mx, m.id), cursor ?? 0);
    answerOwners(p);

    // ── write ──
    const due = queue.filter((j) => j.due <= nowMs && j.expires > nowMs);
    const jobs = [...due, ...detected(p)].sort((a, b) => a.prio - b.prio || a.due - b.due);
    const done = new Set<Job>();
    for (const j of jobs) {
      if (p.wrote >= maxPerPass || roomFull(nowMs)) break;
      const out = await attempt(p, j);
      if (j.queued && out !== "keep") done.add(j);
    }

    // Rule 6 only when nothing else spoke: a pass that wrote anything broke the silence.
    if (p.wrote === 0 && !roomFull(nowMs)) {
      const imminent = queue.some(
        (j) => !done.has(j) && j.speaker !== null && j.due <= nowMs + SOON_MS && p.speakers.get(j.speaker)?.canSpeak === true,
      );
      const j = imminent ? null : quietJob(p);
      if (j) await attempt(p, j);
    }

    // Expired, finished, or over the cap (lowest priority, latest due first).
    const keep = queue.filter((j) => !done.has(j) && j.expires > nowMs);
    keep.sort((a, b) => a.prio - b.prio || a.due - b.due);
    queue.length = 0;
    queue.push(...keep.slice(0, QUEUE_MAX));

    // ── the summary and the housekeeping ──
    const presence: Presence[] = [...p.speakers.values()]
      .map((sp) => ({ slug: sp.facts.slug, name: sp.facts.name, state: sp.asleep ? ("asleep" as const) : ("awake" as const) }))
      .sort((a, b) => (a.state === b.state ? a.name.localeCompare(b.name) : a.state === "awake" ? -1 : 1));
    const asleepCount = presence.filter((x) => x.state === "asleep").length;
    try {
      await writeRoom(shared, {
        members: presence.length,
        awake: presence.length - asleepCount,
        asleep: asleepCount,
        presence,
        updatedAtMs: nowMs,
      });
    } catch (e) {
      p.events.push(`room summary not written (${messageOf(e)})`);
    }

    if (nowMs - lastPruneMs >= PRUNE_EVERY_MS) {
      lastPruneMs = nowMs;
      try {
        const gone = await pruneMessages(shared, nowMs - retentionDays * DAY);
        if (gone > 0) p.events.push(`pruned ${gone}`);
      } catch (e) {
        p.events.push(`prune failed (${messageOf(e)})`);
      }
    }

    for (const [k, at] of said) if (at < nowMs - SAID_TTL_MS) said.delete(k);
    capMap(depthOf, MEMO_MAX);
  }

  function logOf(p: Pass): string | null {
    const extras = [...p.events];
    if (model.note) {
      extras.push(model.note);
      model.note = null;
    }
    if (p.modelRefused > 0) extras.push(`model line refused by the gate ×${p.modelRefused}`);
    const refusal = (reason: string, n: number) => `template refused: ${reason}${n > 1 ? ` ×${n}` : ""}`;
    for (const [reason, n] of p.refused) if (reason !== "repeat") extras.push(refusal(reason, n));
    // AN ECHO IS NOT A BUG, so it never earns a log line of its own: in a busy
    // room a banter template sometimes finds its words already said, and the
    // next pass simply draws again. It rides along on a line that is logged.
    if (p.wrote === 0 && extras.length === 0) return null;
    const echoes = p.refused.get("repeat");
    if (echoes) extras.push(refusal("repeat", echoes));
    const asleep = [...p.speakers.values()].filter((s) => s.asleep).length;
    const head =
      p.wrote > 0
        ? `groupchat: ${p.wrote} line${p.wrote === 1 ? "" : "s"} (${summarise(p.labels)}${p.modelLines ? `; model ×${p.modelLines}` : ""})`
        : "groupchat: 0 lines";
    return [head, `${p.speakers.size - asleep} awake / ${asleep} asleep`, ...extras].join(" · ");
  }

  return {
    plan() {
      const voice = creds
        ? `model ${creds.provider} ${creds.model} for banter, replies and calls (${llmPerDay} a UTC day), templates for the rest`
        : "templates only";
      return {
        why:
          `groupchat: ${voice}; at most ${maxPerPass} lines a pass, ${perHour} an hour in the room, ` +
          `${perAgentPerHour} an hour per agent; lines kept ${retentionDays}d`,
      };
    },

    async step(shared, roster, profiles, nowMs) {
      // LATCHED HERE TOO. The orchestrator already refuses to start a pass
      // while one runs; a second caller that forgets gets a no-op, not two
      // passes interleaving their writes and their queue.
      if (running) return { wrote: 0, log: null };
      running = true;
      model.now = nowMs;
      const utcDay = Math.floor(nowMs / DAY);
      if (model.day !== utcDay) {
        model.day = utcDay;
        model.used = 0;
      }
      const p: Pass = {
        shared,
        nowMs,
        speakers: new Map(),
        room: [],
        rosterNames: [],
        wrote: 0,
        labels: [],
        modelLines: 0,
        modelRefused: 0,
        refused: new Map(),
        spoke: new Set(),
        events: [],
      };
      try {
        await pass(p, roster, profiles instanceof Map ? profiles : new Map());
        lastFail = null;
        return { wrote: p.wrote, log: logOf(p) };
      } catch (e) {
        // NEVER FATAL. A room that cannot be read this pass is quiet this
        // pass; the error is one log line, repeated at most every ten minutes.
        const text = messageOf(e);
        const repeat = lastFail !== null && lastFail.text === text && nowMs - lastFail.at < FAIL_LOG_EVERY_MS;
        if (!repeat) lastFail = { text, at: nowMs };
        const head = p.wrote > 0 ? `groupchat: ${p.wrote} line${p.wrote === 1 ? "" : "s"} then failed` : "groupchat: pass failed";
        return { wrote: p.wrote, log: repeat ? null : `${head} — ${text}` };
      } finally {
        running = false;
      }
    },
  };
}
