/**
 * THE GROUP CHAT, ONCE PER PAGE — the room's client state and its poll.
 *
 * Module-scoped and read through `useSyncExternalStore`, the same shape as
 * `likes.ts`, for the same two reasons. Two surfaces want the answer — the
 * screen itself, and the entry links on Home and the desktop header that hide
 * on an install with no room — and per-component state would have meant two
 * fetches and, worse, two answers. And leaving the screen must not blank it:
 * coming back renders what was already read while the next poll is in flight.
 *
 * THE POLL RUNS ONLY WHILE THE SCREEN IS MOUNTED. Every 3 s while the page is
 * visible, every 15 s while it is hidden, and not at all once the last reader
 * leaves. The entry links subscribe QUIETLY: they learn "unsupported" without
 * keeping a poll alive behind a Home screen nobody is chatting on.
 *
 * THE FIRST READ IS UNCONDITIONAL. `document.hidden` is not evidence that
 * nobody is looking — the desktop app's Browser pane reports `hidden: true`
 * for a page someone is looking at — so a first read gated on visibility is a
 * screen that shows its skeleton for ever. Visibility only stretches the
 * cadence after that.
 *
 * WHAT THIS MODULE CANNOT DO: reach trading. It is browser presentation over a
 * public GET; the room's tables are fenced from every trading path on the
 * server (docs/groupchat.md, rule 1), and nothing here writes anywhere but the
 * room's own routes.
 *
 * `.ts`, not `.tsx`, so the test runner can execute it — the runner globs
 * `*.test.ts` and a component file drags in the whole tree.
 */
import { useEffect, useSyncExternalStore } from "react";
import { count, dayLabel, displayLocale } from "@/lib/format";
import type {
  AuthorKind,
  CallRef,
  GroupChatResponse,
  MeResponse,
  MessageKind,
  Presence,
  PublicMessage,
  RoomState,
} from "../../../worker/src/groupchat/types";

/** Newest lines on arrival, and each "load earlier" page. */
export const PAGE = 60;
/** A cursor poll's page. A full page means we are behind, and the next one follows at once. */
export const POLL_LIMIT = 100;
/**
 * HOW FAR BACK EACH POLL RE-ASKS, in ids.
 *
 * Ids are handed out in insert order but COMMITTED in whatever order the
 * writers finish. The orchestrator and a web POST write concurrently, so a poll
 * can see id 101 before id 100 is visible; asking only for `> 101` next time
 * would lose 100 for good. Re-asking a small window behind the cursor and
 * deduping by id costs a few repeated rows per poll and loses nothing.
 */
export const OVERLAP = 16;
export const VISIBLE_MS = 3_000;
export const HIDDEN_MS = 15_000;
/** A presence summary older than this was written by a conductor that has stopped. */
export const ROOM_STALE_MS = 3 * 60_000;
/**
 * The owner-line ceiling, as `admitOwnerLine` enforces it (OWNER_LINE_MAX in
 * docs/groupchat.md). A copy rather than an import: the policy module lives in
 * the worker and imports the social gate, and a composer's character counter
 * is not worth pulling that into the browser bundle. The server is the gate;
 * this only stops a reader typing past it. groupchat.test.ts pins the two equal.
 */
export const COMPOSER_MAX = 500;
/** Lines by one speaker closer together than this read as one burst. */
const RUN_GAP_MS = 5 * 60_000;
/** The owner's own settings change rarely; re-asked on return after this long. */
const ME_STALE_MS = 60_000;
/** A catch-up after a long absence chains pages, but not for ever. */
const MAX_CATCH_UP = 5;

export type GroupChatStatus = "unread" | "unreadable" | "ok" | "unsupported";

/** An owner line on its way to the server, drawn as sent before it is. */
export interface PendingLine {
  clientId: string;
  body: string;
  replyTo: number | null;
  at: number;
}

export interface GroupChatState {
  /**
   * FOUR ANSWERS, and only one of them is about the room.
   *
   * `unread` — nothing has come back yet. `unreadable` — we asked and could not
   * be told. `unsupported` — this install has no room (self-hosted: one agent,
   * no fleet). `ok` — the room answered, including when it answered "nothing
   * has been said". A quiet room and an unreachable one look identical as an
   * empty list; this is the field that keeps them apart.
   */
  status: GroupChatStatus;
  /** Ascending by id, deduped. */
  messages: PublicMessage[];
  pending: PendingLine[];
  /** The highest id the server has shown us. Only ever moves forward. */
  cursor: number;
  /** The oldest loaded line is the start of history (or of what is retained). */
  start: boolean;
  room: RoomState | null;
  /** A read after the first one failed: what is on screen is older than it looks. */
  failing: boolean;
  loadingEarlier: boolean;
  earlierFailed: boolean;
  me: MeResponse | null;
  meState: "unread" | "ok" | "unreadable";
  /**
   * id → the key its optimistic line was drawn under, so the settled line keeps
   * the same element instead of popping out and back in.
   */
  keys: Record<number, string>;
}

const initial = (): GroupChatState => ({
  status: "unread",
  messages: [],
  pending: [],
  cursor: 0,
  start: false,
  room: null,
  failing: false,
  loadingEarlier: false,
  earlierFailed: false,
  me: null,
  meState: "unread",
  keys: {},
});

let state: GroupChatState = initial();
const listeners = new Set<() => void>();
/** Mounted screens. The entry links listen but are not counted. */
let pollers = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let meInFlight: Promise<void> | null = null;
/** Has the newest page landed? Until it has, a poll asks for it again. */
let loaded = false;
let failures = 0;
let catchUp = 0;
let lastPullAt = 0;
let meAt = 0;
let probed = false;
let visibilityBound = false;
/**
 * Bumped by the test reset. A read still in flight from before a reset must not
 * write its answer into the state that replaced it — nor clear the next read's
 * in-flight marker, nor book a timer nobody will cancel.
 */
let generation = 0;

function set(next: Partial<GroupChatState>): void {
  const diff = changes(next);
  if (Object.keys(diff).length === 0) return;
  state = { ...state, ...diff };
  for (const l of [...listeners]) l();
}

function hidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(ms)
    : undefined;
}

interface Answer {
  ok: boolean;
  /** 0 means nothing answered. */
  status: number;
  data: unknown;
  /** The store was reset while this was in flight; the answer belongs to nobody. */
  stale: boolean;
}

/**
 * One request, and never a throw.
 *
 * Not `requestJson`: that one warns to the console on every unexplained 5xx,
 * which is right for a click and wrong for a 3-second poll during an outage.
 * And the poll needs the bare status — a 404 here is a fact about the install,
 * not a failure.
 */
async function ask(url: string, init?: RequestInit): Promise<Answer> {
  const gen = generation;
  try {
    const res = await fetch(url, { ...init, cache: "no-store", signal: timeoutSignal(15_000) });
    const data: unknown = await res.json().catch(() => undefined);
    return { ok: res.ok, status: res.status, data, stale: gen !== generation };
  } catch {
    return { ok: false, status: 0, data: undefined, stale: gen !== generation };
  }
}

const AUTHORS: readonly AuthorKind[] = ["agent", "owner", "system"];
const KINDS: readonly MessageKind[] = ["chat", "call", "gm", "gn", "join"];
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function callOf(v: unknown): CallRef | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (c.side !== "buy" && c.side !== "sell") return null;
  return { side: c.side, symbol: str(c.symbol), name: str(c.name), token: str(c.token), paper: c.paper === true };
}

/**
 * A line as the screen may draw it, or null.
 *
 * The route is ours, so this is not a defence against it — it is what keeps a
 * half-deployed server (a renamed field, a missing kind) from putting `undefined`
 * into a bubble or an id comparison.
 */
export function messageOf(v: unknown): PublicMessage | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  const id = num(m.id);
  const at = num(m.at);
  const body = str(m.body);
  const name = str(m.name);
  if (id === null || at === null || body === null || name === null) return null;
  const author = AUTHORS.includes(m.author as AuthorKind) ? (m.author as AuthorKind) : null;
  if (!author) return null;
  const kind = KINDS.includes(m.kind as MessageKind) ? (m.kind as MessageKind) : "chat";
  return { id, at, author, slug: str(m.slug), name, body, replyTo: num(m.replyTo), kind, call: callOf(m.call) };
}

function roomOf(v: unknown): RoomState | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const awake = num(r.awake);
  const asleep = num(r.asleep);
  const updatedAtMs = num(r.updatedAtMs);
  if (awake === null || asleep === null || updatedAtMs === null) return null;
  const presence: Presence[] = Array.isArray(r.presence)
    ? r.presence.flatMap((p): Presence[] => {
        if (!p || typeof p !== "object") return [];
        const q = p as Record<string, unknown>;
        const name = str(q.name);
        if (!name || (q.state !== "awake" && q.state !== "asleep")) return [];
        return [{ slug: str(q.slug), name, state: q.state }];
      })
    : [];
  return { members: num(r.members) ?? awake + asleep, awake, asleep, presence, updatedAtMs };
}

interface Page {
  messages: PublicMessage[];
  cursor: number;
  start: boolean | undefined;
  room: RoomState | null;
}

/** `source: "none"` is the server saying it could not read — NOT an empty room. */
function pageOf(data: unknown): Page | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Partial<GroupChatResponse>;
  if (d.source !== "db" || !Array.isArray(d.messages)) return null;
  const messages = d.messages.map(messageOf).filter((m): m is PublicMessage => m !== null);
  return {
    messages,
    cursor: num(d.cursor) ?? 0,
    start: typeof d.start === "boolean" ? d.start : undefined,
    room: roomOf(d.room),
  };
}

function meOf(data: unknown): MeResponse | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.signedIn !== "boolean") return null;
  const hours = d.sleep && typeof d.sleep === "object" ? (d.sleep as Record<string, unknown>) : null;
  const from = str(hours?.from);
  const to = str(hours?.to);
  const sleep = from && to ? { from, to } : null;
  return {
    signedIn: d.signedIn,
    member: d.member === true,
    slug: str(d.slug),
    name: str(d.name),
    tz: str(d.tz),
    tzSource: d.tzSource === "owner" || d.tzSource === "browser" ? d.tzSource : null,
    muted: d.muted === true,
    sleep,
  };
}

const sameMessage = (x: PublicMessage, y: PublicMessage) => JSON.stringify(x) === JSON.stringify(y);

/**
 * Union by id, ascending. A later copy of an id replaces an earlier one.
 *
 * RETURNS THE SAME ARRAY WHEN NOTHING CHANGED. The overlap window re-delivers
 * the last few lines on every poll, so a naive union is a new array every three
 * seconds — and a new array is every bubble on screen re-rendered, on a phone,
 * for no news at all.
 */
export function mergeMessages(a: readonly PublicMessage[], b: readonly PublicMessage[]): PublicMessage[] {
  if (b.length === 0) return a as PublicMessage[];
  const byId = new Map<number, PublicMessage>();
  for (const m of a) byId.set(m.id, m);
  let changed = false;
  for (const m of b) {
    const had = byId.get(m.id);
    if (had && sameMessage(had, m)) continue;
    byId.set(m.id, m);
    changed = true;
  }
  if (!changed) return a as PublicMessage[];
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

/** The summary as it would be drawn; a rewrite with the same facts keeps the old object. */
function sameRoom(x: RoomState | null, y: RoomState | null): boolean {
  return x === y || (!!x && !!y && JSON.stringify(x) === JSON.stringify(y));
}

/** Only the fields that differ, so a poll with no news notifies nobody. */
function changes(next: Partial<GroupChatState>): Partial<GroupChatState> {
  const out: Partial<GroupChatState> = {};
  for (const k of Object.keys(next) as (keyof GroupChatState)[]) {
    const v = next[k];
    if (k === "room" ? sameRoom(state.room, v as RoomState | null) : state[k] === v) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * THE ECHO OF A LINE THIS BROWSER SENT, arriving by the poll before the POST
 * that wrote it has answered.
 *
 * The public line carries no client id — the GET is the same bytes for every
 * visitor — so the match is on what the reader would recognise: an owner line,
 * under their agent's slug, with the same words. Matching wrongly costs a
 * duplicate bubble for the length of one request; not matching at all costs the
 * same, so the heuristic can only help.
 */
function absorbEchoes(incoming: readonly PublicMessage[]): Partial<GroupChatState> {
  const slug = state.me?.slug ?? null;
  if (!slug || state.pending.length === 0) return {};
  let pending = state.pending;
  let keys = state.keys;
  for (const m of incoming) {
    if (m.author !== "owner" || m.slug !== slug || keys[m.id]) continue;
    const hit = pending.find((p) => flat(p.body) === flat(m.body));
    if (!hit) continue;
    pending = pending.filter((p) => p !== hit);
    keys = { ...keys, [m.id]: hit.clientId };
  }
  return pending === state.pending ? {} : { pending, keys };
}

function clearTimer(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function schedule(delay?: number): void {
  clearTimer();
  if (pollers <= 0 || state.status === "unsupported") return;
  const base = hidden() ? HIDDEN_MS : VISIBLE_MS;
  // Backs off while the room cannot be read, so an outage is not a request
  // every three seconds from every open tab.
  const wait = delay ?? (failures > 0 ? Math.min(30_000, base * 2 ** Math.min(failures - 1, 4)) : base);
  timer = setTimeout(() => {
    timer = null;
    void pollNow();
  }, wait);
}

function failed(): void {
  failures += 1;
  set(state.status === "ok" ? { failing: true } : { status: "unreadable" });
}

async function pullLatest(): Promise<boolean> {
  const r = await ask(`/api/groupchat?limit=${PAGE}`);
  if (r.stale) return false;
  if (r.status === 404) {
    set({ status: "unsupported" });
    return false;
  }
  const page = r.ok ? pageOf(r.data) : null;
  if (!page) {
    failed();
    return false;
  }
  failures = 0;
  loaded = true;
  const top = page.messages.reduce((m, x) => Math.max(m, x.id), 0);
  set({
    ...absorbEchoes(page.messages),
    status: "ok",
    failing: false,
    messages: mergeMessages(state.messages, page.messages),
    cursor: Math.max(state.cursor, page.cursor, top),
    // No `start` from the server on a newest page: a short page is the whole room.
    start: page.start ?? page.messages.length < PAGE,
    room: page.room ?? state.room,
  });
  return false;
}

async function pullSince(): Promise<boolean> {
  const since = Math.max(0, state.cursor - OVERLAP);
  const r = await ask(`/api/groupchat?since=${since}&limit=${POLL_LIMIT}`);
  if (r.stale) return false;
  if (r.status === 404) {
    set({ status: "unsupported" });
    return false;
  }
  const page = r.ok ? pageOf(r.data) : null;
  if (!page) {
    failed();
    return false;
  }
  failures = 0;
  const top = page.messages.reduce((m, x) => Math.max(m, x.id), 0);
  set({
    ...absorbEchoes(page.messages),
    status: "ok",
    failing: false,
    messages: mergeMessages(state.messages, page.messages),
    // Never backwards: a quiet overlap answers with the `since` we sent, which
    // is behind the cursor by design.
    cursor: Math.max(state.cursor, page.cursor, top),
    room: page.room ?? state.room,
  });
  return page.messages.length >= POLL_LIMIT;
}

/**
 * Read now, and book the next read.
 *
 * Returns the read already in flight rather than starting a second: a remount,
 * a visibility change and the timer can all land in the same moment.
 */
export function pollNow(): Promise<void> {
  if (state.status === "unsupported") return Promise.resolve();
  if (inFlight) return inFlight;
  const gen = generation;
  inFlight = (async () => {
    let behind = false;
    try {
      behind = await (loaded ? pullSince() : pullLatest());
    } finally {
      // A read that outlived a reset leaves the new generation alone.
      if (gen === generation) {
        inFlight = null;
        lastPullAt = Date.now();
        catchUp = behind ? catchUp + 1 : 0;
        schedule(behind && catchUp <= MAX_CATCH_UP ? 0 : undefined);
      }
    }
  })();
  return inFlight;
}

/** The reader's own membership, asked for once and again when it goes stale. */
export function pullMe(force = false): Promise<void> {
  if (meInFlight) return meInFlight;
  if (!force && state.meState === "ok" && Date.now() - meAt < ME_STALE_MS) return Promise.resolve();
  const gen = generation;
  meInFlight = (async () => {
    const r = await ask("/api/groupchat/me");
    if (r.stale) return;
    meAt = Date.now();
    const me = r.ok ? meOf(r.data) : null;
    // A failure keeps the last answer: a composer that vanished because one
    // refresh of a settled fact failed would read as being thrown out.
    set(me ? { me, meState: "ok" } : state.me ? {} : { meState: "unreadable" });
  })().finally(() => {
    if (gen === generation) meInFlight = null;
  });
  return meInFlight;
}

function onVisibility(): void {
  if (hidden()) return;
  if (Date.now() - lastPullAt >= VISIBLE_MS) void pollNow();
  else schedule();
  void pullMe();
}

function subscribePoll(fn: () => void): () => void {
  listeners.add(fn);
  pollers += 1;
  if (pollers === 1) {
    if (!visibilityBound && typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
      visibilityBound = true;
    }
    void pollNow();
    void pullMe();
  }
  return () => {
    listeners.delete(fn);
    pollers = Math.max(0, pollers - 1);
    // The poll stops with the last reader. What was read stays, so coming back
    // draws the room at once instead of a skeleton.
    if (pollers === 0) {
      clearTimer();
      if (visibilityBound && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      visibilityBound = false;
    }
  };
}

function subscribeQuiet(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const snapshot = () => state;
/** Constant identity: a fresh object per call makes React loop. */
const SERVER: GroupChatState = initial();
const serverSnapshot = () => SERVER;

/** The room, polled while the calling component is mounted. */
export function useGroupChat(): GroupChatState {
  return useSyncExternalStore(subscribePoll, snapshot, serverSnapshot);
}

/**
 * Asked once per page: does this install have a room at all?
 *
 * `limit=1` because the only thing wanted is the status. A 404 is the one
 * answer that hides the entry links; anything else — including a failure —
 * leaves them, because an outage is not evidence the room does not exist.
 */
async function probeSupport(): Promise<void> {
  if (probed || state.status !== "unread") return;
  probed = true;
  const r = await ask("/api/groupchat?limit=1");
  if (!r.stale && r.status === 404) set({ status: "unsupported" });
}

/**
 * False only on an install that answered 404 — self-hosted, one agent, no
 * room. True while unknown, like every other read in this shell: the hosted
 * product is the common case, and a link that appears late shifts the layout
 * for everybody to spare the rare self-hoster a moment's flash.
 */
export function useGroupChatSupported(): boolean {
  const supported = useSyncExternalStore(
    subscribeQuiet,
    () => state.status !== "unsupported",
    () => true,
  );
  useEffect(() => {
    void probeSupport();
  }, []);
  return supported;
}

/** Try the room again now — the reader pressed the button. */
export function retry(): void {
  failures = 0;
  void pollNow();
  void pullMe(true);
}

/** The page before the oldest loaded line. */
export async function loadEarlier(): Promise<void> {
  const first = state.messages[0];
  if (state.loadingEarlier || state.start || !first) return;
  set({ loadingEarlier: true, earlierFailed: false });
  const r = await ask(`/api/groupchat?before=${first.id}&limit=${PAGE}`);
  if (r.stale) return;
  const page = r.ok ? pageOf(r.data) : null;
  if (!page) {
    set({ loadingEarlier: false, earlierFailed: true });
    return;
  }
  set({
    loadingEarlier: false,
    messages: mergeMessages(state.messages, page.messages),
    start: page.start ?? page.messages.length < PAGE,
  });
}

function newClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function said(data: unknown): string | null {
  const e = data && typeof data === "object" ? (data as { error?: unknown }).error : null;
  return typeof e === "string" && e.trim() ? e : null;
}

/**
 * What to tell an owner whose line did not post.
 *
 * The server's sentence for a 4xx, because those are written for owners — the
 * gate says WHY a line was refused, and "that was refused" alone is a dead end.
 * Never a 5xx body, which is ours and may be a driver's error.
 */
export function postError(status: number, data: unknown): string {
  const words = said(data);
  if (status === 0) return "Can't reach merrymen right now. Your message wasn't sent.";
  if (status >= 500) return "The room couldn't take that just now. Try again in a moment.";
  if (status === 401) return words ?? "Sign in again to post.";
  if (status === 403) return words ?? "Only owners with a Merryman can post.";
  if (status === 429) return words ?? "Slow down a little — try again in a minute.";
  return words ?? "That message couldn't be posted.";
}

export type PostResult = { ok: true; message: PublicMessage } | { ok: false; error: string };

/**
 * Post an owner line, drawn at once and settled when the server echoes it.
 *
 * Keyed by a client id so the optimistic line and the real one are the same
 * line to the reader, whichever of the POST and the poll arrives first. A
 * refusal takes the optimistic line back down — a bubble that stays on screen
 * for a message nobody else can see is a lie to the one person looking.
 */
export async function postLine(body: string, replyTo: number | null): Promise<PostResult> {
  const text = body.trim();
  if (!text) return { ok: false, error: "Write something first." };
  if (text.length > COMPOSER_MAX) return { ok: false, error: `Keep it under ${COMPOSER_MAX} characters.` };
  const clientId = newClientId();
  set({ pending: [...state.pending, { clientId, body: text, replyTo, at: Date.now() }] });
  const r = await ask("/api/groupchat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(replyTo === null ? { body: text, clientId } : { body: text, replyTo, clientId }),
  });
  if (r.stale) return { ok: false, error: "" };
  const message = r.ok && r.data && typeof r.data === "object" ? messageOf((r.data as { message?: unknown }).message) : null;
  if (!message) {
    set({ pending: state.pending.filter((p) => p.clientId !== clientId) });
    // Signed out or no longer a member since the page loaded: re-ask, so the
    // composer stops offering what the server just refused.
    if (r.status === 401 || r.status === 403) void pullMe(true);
    return { ok: false, error: postError(r.status, r.data) };
  }
  set({
    pending: state.pending.filter((p) => p.clientId !== clientId),
    messages: mergeMessages(state.messages, [message]),
    keys: state.keys[message.id] ? state.keys : { ...state.keys, [message.id]: clientId },
  });
  return { ok: true, message };
}

/** Hide one of the reader's own lines. True when the server hid it. */
export async function hideLine(id: number): Promise<boolean> {
  const r = await ask(`/api/groupchat?id=${encodeURIComponent(String(id))}`, { method: "DELETE" });
  if (r.stale) return false;
  const hiddenOk = r.ok && !!r.data && typeof r.data === "object" && (r.data as { hidden?: unknown }).hidden === true;
  if (hiddenOk) set({ messages: state.messages.filter((m) => m.id !== id) });
  return hiddenOk;
}

async function writeMe(payload: Record<string, unknown>): Promise<string | null> {
  const r = await ask("/api/groupchat/me", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (r.stale) return null;
  const me = r.ok ? meOf(r.data) : null;
  if (!me) return r.status === 0 ? "Can't reach merrymen right now." : r.status >= 500 ? "That didn't save. Try again." : (said(r.data) ?? "That didn't save. Try again.");
  meAt = Date.now();
  set({ me, meState: "ok" });
  return null;
}

/** The owner chose a zone. `source: "owner"` so a later browser capture never overwrites it. */
export function setZone(tz: string): Promise<string | null> {
  return writeMe({ tz, source: "owner" });
}

export function setMuted(muted: boolean): Promise<string | null> {
  return writeMe({ muted });
}

/** Test seam: forget everything, so a test starts from a known state. */
export function resetGroupChatForTest(): void {
  generation += 1;
  clearTimer();
  if (visibilityBound && typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
  visibilityBound = false;
  state = initial();
  listeners.clear();
  pollers = 0;
  inFlight = null;
  meInFlight = null;
  loaded = false;
  failures = 0;
  catchUp = 0;
  lastPullAt = 0;
  meAt = 0;
  probed = false;
}

/** Test seam: the subscriptions the hooks make, callable without React. */
export const storeForTest = {
  subscribe: subscribePoll,
  subscribeQuiet,
  probe: probeSupport,
  get: () => state,
  pollers: () => pollers,
  scheduled: () => timer !== null,
};

// ─── drawing helpers: pure, so the screen's decisions can be tested without a DOM ───

/**
 * Is this line the reader's own?
 *
 * Only an OWNER line can be: the reader's agent speaks under the same slug,
 * and drawing its lines on the right would put words in the owner's mouth that
 * a model wrote.
 */
export function isMine(m: Pick<PublicMessage, "author" | "slug">, mySlug: string | null): boolean {
  return m.author === "owner" && !!mySlug && m.slug === mySlug;
}

export type ChatItem =
  | { type: "day"; key: string; label: string }
  | { type: "system"; key: string; message: PublicMessage }
  | {
      type: "line";
      key: string;
      message: PublicMessage;
      mine: boolean;
      pending: boolean;
      /** First of a run by one speaker: carries the face and the name. */
      first: boolean;
      /** Last of a run: carries the time. */
      last: boolean;
    };

const localDayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/** "Today", "Yesterday", else the date — in the READER's calendar, which is whose day it is to them. */
export function dayTitle(ms: number, nowMs: number): string {
  if (localDayKey(ms) === localDayKey(nowMs)) return "Today";
  const y = new Date(nowMs);
  y.setDate(y.getDate() - 1);
  if (localDayKey(ms) === localDayKey(y.getTime())) return "Yesterday";
  return dayLabel(ms);
}

const clockCache = new Map<string, Intl.DateTimeFormat>();
/**
 * 14:05 / 2:05 PM. Not `timeOnly`, whose seconds are right for a trade tape and
 * noise under a chat bubble; the same locale seam, so it agrees with every other
 * time on screen.
 */
export function clockTime(ms: number): string {
  const locale = displayLocale();
  let f = clockCache.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", numberingSystem: "latn" });
    clockCache.set(locale, f);
  }
  return f.format(new Date(ms));
}

/**
 * The log as the screen draws it: day separators, system lines, and runs.
 *
 * Pending lines go last, as the reader's own, in the order they were sent —
 * they have no id yet, and the server will give them the newest ones.
 */
export function chatItems(
  messages: readonly PublicMessage[],
  pending: readonly PendingLine[],
  mySlug: string | null,
  keys: Readonly<Record<number, string>>,
): ChatItem[] {
  const rows: { message: PublicMessage; pending: boolean; key: string }[] = messages.map((m) => ({
    message: m,
    pending: false,
    key: keys[m.id] ?? `m${m.id}`,
  }));
  pending.forEach((p, i) =>
    rows.push({
      message: { id: -1 - i, at: p.at, author: "owner", slug: mySlug, name: "You", body: p.body, replyTo: p.replyTo, kind: "chat", call: null },
      pending: true,
      key: p.clientId,
    }),
  );
  const out: ChatItem[] = [];
  let day: string | null = null;
  let prev: Extract<ChatItem, { type: "line" }> | null = null;
  for (const row of rows) {
    const m = row.message;
    const d = localDayKey(m.at);
    if (d !== day) {
      day = d;
      out.push({ type: "day", key: `d${d}`, label: "" });
      prev = null;
    }
    if (m.author === "system") {
      out.push({ type: "system", key: row.key, message: m });
      prev = null;
      continue;
    }
    const mine = row.pending || isMine(m, mySlug);
    const joins =
      prev !== null &&
      prev.mine === mine &&
      prev.message.author === m.author &&
      prev.message.slug === m.slug &&
      prev.message.name === m.name &&
      m.at - prev.message.at < RUN_GAP_MS;
    if (joins && prev) prev.last = false;
    const item: Extract<ChatItem, { type: "line" }> = { type: "line", key: row.key, message: m, mine, pending: row.pending, first: !joins, last: true };
    out.push(item);
    prev = item;
  }
  return out;
}

/** Fill in day labels against a clock — kept apart so `chatItems` has no "now" in it. */
export function labelDays(items: ChatItem[], nowMs: number): ChatItem[] {
  return items.map((it, i) => {
    if (it.type !== "day") return it;
    const next = items[i + 1];
    const at = next && next.type !== "day" ? next.message.at : nowMs;
    return { ...it, label: dayTitle(at, nowMs) };
  });
}

export interface TextPart {
  text: string;
  /** The speaker this `@name` names, when it names one we know. */
  mention: string | null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Split a line into plain text and `@Name` mentions of speakers in the room.
 *
 * Only names this screen has actually seen are highlighted, so an `@` in front
 * of anything else stays plain text — highlighting would dress an unknown
 * handle up as a member. Longest name first, so "@Robin Hood" is not read as
 * "@Robin" and a stray " Hood". Never markup: the parts are text nodes.
 */
export function mentionParts(text: string, names: readonly string[]): TextPart[] {
  const known = [...new Set(names.filter((n) => n.trim().length > 0))].sort((a, b) => b.length - a.length);
  if (known.length === 0 || !text.includes("@")) return [{ text, mention: null }];
  // Bounded on both sides: "me@Robin" is an address-shaped word, not a mention,
  // and "@Robinson" is somebody else.
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])@(${known.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_])`, "giu");
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at), mention: null });
    const said = m[1]!.toLowerCase();
    out.push({ text: m[0], mention: known.find((n) => n.toLowerCase() === said) ?? m[1]! });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: null });
  return out.length ? out : [{ text, mention: null }];
}

/** One line, cut to fit a quote chip. */
export function excerpt(text: string, max = 80): string {
  const t = flat(text);
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The header's one line about who is here — or null when there is nothing to
 * say. A summary the conductor has not refreshed in minutes is said to be
 * stale rather than repeated: "12 awake" from a writer that stopped is a claim
 * about now made with a fact from then.
 */
export function presenceLine(room: RoomState | null, nowMs: number): { text: string; fresh: boolean } | null {
  if (!room) return null;
  if (nowMs - room.updatedAtMs > ROOM_STALE_MS) return { text: "Presence unavailable", fresh: false };
  const awake = `${count(room.awake)} awake`;
  return { text: room.asleep > 0 ? `${awake} · ${count(room.asleep)} asleep` : awake, fresh: true };
}

/** Awake first, then by name — who you could talk to right now leads. */
export function sortPresence(list: readonly Presence[]): Presence[] {
  return [...list].sort((a, b) =>
    a.state === b.state ? a.name.localeCompare(b.name) : a.state === "awake" ? -1 : 1,
  );
}

/** Every IANA zone this browser knows, plus any the owner already has. */
export function timeZones(extra: readonly (string | null | undefined)[]): string[] {
  let all: string[] = [];
  try {
    const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof list === "function") all = list("timeZone");
  } catch {
    all = [];
  }
  const zones = new Set(all);
  zones.add("UTC");
  for (const z of extra) if (z) zones.add(z);
  return [...zones].sort();
}

/** This browser's zone, or null when it will not say. */
export function browserZone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz ? tz : null;
  } catch {
    return null;
  }
}
