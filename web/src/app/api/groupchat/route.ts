/**
 * THE GROUP CHAT, OVER HTTP: read the room, post an owner's line, take one back.
 *
 * The room itself is written by the orchestrator (docs/groupchat.md); this route
 * is the only other writer, and it writes exactly one kind of line — an OWNER's
 * own words, under their agent's name. No model is called here, ever: a web
 * request that could spend a key is a web request anybody signed in can
 * repeat, and rule 4 of the contract is that the room never spends an owner's
 * key or starves trading of the fleet's.
 *
 * GET IS SESSION-FREE BY CONSTRUCTION. It never reads a cookie, never calls
 * `tenantOf`, and answers every visitor with the same bytes — which is what
 * makes its short public cache honest rather than a leak. Anything
 * per-reader (may I post, what are my agent's sleep hours) is `/me`, which is
 * private and never cached. If a session read ever appears in GET, the cache
 * header becomes a way to hand one owner's answer to the next reader.
 *
 * NOT PRERENDERED. `force-dynamic` and never `revalidate`: there is no
 * DATABASE_URL inside the image build, and a prerendered GET would bake
 * `source: "none"` into every first visit after a deploy (app/prerender.test.ts).
 *
 * HOSTED ONLY. Self-hosted is one agent with no fleet, so there is no room;
 * 404 is what hides the entry links there (terminal/groupchat.ts).
 *
 * Cross-site writes are refused before this file runs, by middleware.ts's
 * Sec-Fetch-Site guard and the SameSite=Strict session cookie.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import type { Db } from "../../../../../worker/src/db";
import { admitOwnerLine, OWNER_LINE_MAX } from "../../../../../worker/src/groupchat/policy";
import {
  appendMessage,
  countOwnerLinesSince,
  hideOwnMessage,
  messageById,
  readMessages,
  readRoom,
  toPublic,
} from "../../../../../worker/src/groupchat/store";
import type { GroupChatResponse, MessageKind, NewMessage, PublicMessage } from "../../../../../worker/src/groupchat/types";
import { agentOf, objectOf, PRIVATE_HEADERS, readBounded, roomNow, speakerOf, withRoom, type Room } from "./room";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE ONE SHARED CACHE LINE, and it is short on purpose: the room polls every
 * three seconds, so two seconds of edge cache absorbs a crowd without making
 * anybody's own line arrive noticeably late.
 */
const PUBLIC_HEADERS = { "Cache-Control": "public, max-age=2, s-maxage=2" } as const;
/** A failure is never cached: "could not read" must not outlive the outage. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The store's page ceiling; asking for more is answered with this many. */
const PAGE_MAX = 200;
const PAGE_DEFAULT = 50;

/** A line is at most 500 characters; 4 KiB leaves room for the JSON around it and nothing else. */
const BODY_MAX_BYTES = 4096;

/**
 * THE RATE LIMIT, per owner. Six a minute is a fast conversation; two hundred a
 * day is a lot of talking and still a ceiling on what one account can pour
 * into a room every other owner reads.
 */
const PER_MINUTE = 6;
const PER_DAY = 200;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * THE LIMIT'S LOCK, transaction-scoped, per tenant. Without it, N requests
 * fired together all count the same lines and all insert — a burst limit that
 * a script walks straight through. Distinct from the store's schema lock
 * (1_297_692_090) and every other advisory key in the repo; the two-int form
 * keeps it apart from the single-key ones entirely.
 */
const OWNER_LOCK_CLASS = 1_297_692_091;

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  NextResponse.json(body, { status, headers });
const refuse = (status: number, error: string, headers: Record<string, string> = PRIVATE_HEADERS) =>
  json({ error }, status, headers);
const notFound = () => refuse(404, "not found", NO_STORE);

// ── GET ─────────────────────────────────────────────────────────────────────

/**
 * A cursor as the query string spells it: digits only, inside the safe range.
 * `undefined` when absent, `null` when malformed. Strict because the value
 * reaches a BIGINT parameter, and "1e3", "-1" or "2.5" mean nothing a client
 * of ours would send.
 */
function cursorParam(raw: string | null): number | undefined | null {
  if (raw === null || raw === "") return undefined;
  if (!/^\d{1,16}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function limitParam(raw: string | null): number | null {
  if (raw === null || raw === "") return PAGE_DEFAULT;
  if (!/^\d{1,6}$/.test(raw)) return null;
  return Math.min(PAGE_MAX, Math.max(1, Number(raw)));
}

/** "Could not read" — never an empty room. The poll keeps its cursor. */
function unreadable(since: number | undefined): NextResponse {
  return json(
    { source: "none", messages: [], cursor: since ?? 0, room: null } satisfies GroupChatResponse,
    200,
    NO_STORE,
  );
}

export async function GET(req: Request) {
  if (!isHostedMode()) return notFound();
  const q = new URL(req.url).searchParams;
  const since = cursorParam(q.get("since"));
  const before = cursorParam(q.get("before"));
  const limit = limitParam(q.get("limit"));
  if (since === null || before === null || limit === null) {
    return refuse(400, "since, before and limit are whole numbers", NO_STORE);
  }
  try {
    const answer = await withRoom(async (room): Promise<GroupChatResponse | null> => {
      if (!room) return null;
      const page = await readMessages(room.db, { since, before: before ?? null, limit });
      // The presence line is decoration; a summary that will not parse must not
      // cost the reader the conversation.
      const summary = await readRoom(room.db).catch(() => null);
      const messages = page.messages.map(toPublic);
      return {
        source: "db",
        messages,
        cursor: messages.reduce((top, m) => Math.max(top, m.id), since ?? 0),
        start: page.start,
        room: summary,
      };
    });
    return answer ? json(answer, 200, PUBLIC_HEADERS) : unreadable(since);
  } catch {
    return unreadable(since);
  }
}

// ── POST ────────────────────────────────────────────────────────────────────

/** Why the gate refused, in words an owner can act on. Codes are policy.ts's. */
function refusalWords(reason: string): string {
  switch (reason) {
    case "empty":
      return "Write something first.";
    case "too-long":
      return `Keep it under ${OWNER_LINE_MAX} characters.`;
    case "secret":
      return "That looks like a private key or a secret, so it wasn't posted. Never paste one anywhere.";
    case "address":
      return "Addresses can't be posted in the room. It's public, and an address is somebody's wallet.";
    case "link":
      return "Links can't be posted in the room.";
    default:
      return "That message couldn't be posted.";
  }
}

/**
 * A LINE THAT IS ONLY A GREETING is a gm, so the room can answer it as one
 * (the conductor sends gm-backs to an owner's gm). Deliberately narrow: "gm,
 * how's everyone" is conversation and gets a reply, not a chorus.
 */
const GM_LINE =
  /^(?:gm+|good\s+morning)(?:[\s,]+(?:gm+|all|everyone|everybody|y'?all|fam|frens?|friends|folks|guys|gang|team|room|chat|merrymen))*[^\p{L}\p{N}]*$/iu;

function kindOf(text: string): MessageKind {
  return GM_LINE.test(text.trim()) ? "gm" : "chat";
}

/** Seconds until the next UTC midnight, when the daily count starts again. */
function secondsToUtcMidnight(now: number): number {
  return Math.max(1, Math.ceil((utcDayStart(now) + DAY_MS - now) / 1000));
}

function utcDayStart(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

/** A 32-bit key from the tenant, for the second half of the advisory lock. */
function lockKey(tenant: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tenant.length; i++) {
    h ^= tenant.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/**
 * Count and insert as one step per tenant. On sqlite the driver already runs a
 * transaction alone; on Postgres the advisory lock makes a second request by
 * the same owner wait for the first to commit before it counts.
 */
function underOwnerLock<T>(room: Room, tenant: string, fn: (db: Db) => Promise<T>): Promise<T> {
  return room.db.tx(async (tx) => {
    if (room.dialect === "postgres") {
      await tx.prepare("SELECT pg_advisory_xact_lock(?, ?)").get(OWNER_LOCK_CLASS, lockKey(tenant));
    }
    return fn(tx);
  });
}

/** No reply (null), a line id, or `undefined` for anything that is neither. */
function replyOf(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
}

type Posted =
  | { ok: true; message: PublicMessage }
  | { ok: false; status: number; error: string; retryAfter?: number };

export async function POST(req: Request) {
  if (!isHostedMode()) return notFound();
  const tenant = tenantOf(req);
  if (!tenant) return refuse(401, "Sign in to post.");

  let text: string | null;
  try {
    text = await readBounded(req, BODY_MAX_BYTES);
  } catch {
    return refuse(400, "expected JSON with a body");
  }
  if (text === null) return refuse(413, `That's too long to post. Keep it under ${OWNER_LINE_MAX} characters.`);
  const input = objectOf(text);
  if (!input || typeof input.body !== "string") return refuse(400, "expected JSON with a body");

  let owned: string | null;
  try {
    owned = await agentOf(tenant);
  } catch {
    return refuse(503, "Couldn't check that you have a Merryman. Try again in a moment.");
  }
  if (!owned) return refuse(403, "Only owners with a Merryman can post.");
  const agentId = owned;

  const verdict = admitOwnerLine(input.body);
  if (!verdict.ok) return refuse(400, refusalWords(verdict.reason));

  // A reply pointer is the client's claim about which line this answers; it
  // must be a line id, and (below) a line the room still shows.
  const replyTo = replyOf(input.replyTo);
  if (replyTo === undefined) return refuse(400, "That reply points at no message.");

  let posted: Posted;
  try {
    posted = await withRoom(async (room): Promise<Posted> => {
      if (!room) return { ok: false, status: 503, error: "The group chat isn't available right now." };
      if (replyTo !== null) {
        const target = await messageById(room.db, replyTo);
        // A hidden line is one its owner took back; answering it would quote
        // a line nobody can see.
        if (!target || target.hidden) {
          return { ok: false, status: 400, error: "The message you replied to isn't in the room any more." };
        }
      }
      const speaker = await speakerOf(room.db, tenant, agentId);
      return underOwnerLock(room, tenant, async (db): Promise<Posted> => {
        const now = roomNow();
        // Hidden lines count (the store's rule): post-then-hide is not a way around the limit.
        if ((await countOwnerLinesSince(db, tenant, now - MINUTE_MS)) >= PER_MINUTE) {
          return { ok: false, status: 429, error: "You're posting fast. Wait a minute and try again.", retryAfter: 60 };
        }
        if ((await countOwnerLinesSince(db, tenant, utcDayStart(now))) >= PER_DAY) {
          return {
            ok: false,
            status: 429,
            error: "That's the most you can post today. The count resets at midnight UTC.",
            retryAfter: secondsToUtcMidnight(now),
          };
        }
        const line: NewMessage = {
          createdAtMs: now,
          authorKind: "owner",
          // INTERNAL: who wrote it, for hide-your-own and the limit. toPublic drops both.
          tenant,
          agentId: speaker.agentId,
          speakerSlug: speaker.slug,
          speakerName: `${speaker.name}'s owner`,
          body: verdict.text,
          replyTo,
          kind: kindOf(verdict.text),
          call: null,
          callDecisionId: null,
          // Free chat has no idempotence key: saying the same thing twice is allowed.
          dedupeKey: null,
        };
        const id = await appendMessage(db, line);
        if (id === null) return { ok: false, status: 503, error: "The room couldn't take that just now. Try again in a moment." };
        return { ok: true, message: toPublic({ ...line, id, hidden: false }) };
      });
    });
  } catch {
    return refuse(503, "The room couldn't take that just now. Try again in a moment.");
  }

  if (!posted.ok) {
    const headers: Record<string, string> = { ...PRIVATE_HEADERS };
    if (posted.retryAfter !== undefined) headers["Retry-After"] = String(posted.retryAfter);
    return refuse(posted.status, posted.error, headers);
  }
  return json({ message: posted.message }, 200, PRIVATE_HEADERS);
}

// ── DELETE ──────────────────────────────────────────────────────────────────

/**
 * Take back one of your own lines. The store checks author and tenant in the
 * same statement that hides it, so a caller can never silence an agent, the
 * room, or another owner — the answer for those is simply `hidden: false`.
 */
export async function DELETE(req: Request) {
  if (!isHostedMode()) return notFound();
  const tenant = tenantOf(req);
  if (!tenant) return refuse(401, "Sign in first.");
  const id = cursorParam(new URL(req.url).searchParams.get("id"));
  if (id === undefined || id === null || id <= 0) return refuse(400, "Which message?");
  try {
    const hidden = await withRoom(async (room) => (room ? hideOwnMessage(room.db, id, tenant) : null));
    if (hidden === null) return refuse(503, "The group chat isn't available right now.");
    return json({ hidden }, 200, PRIVATE_HEADERS);
  } catch {
    return refuse(503, "That didn't go through. Try again in a moment.");
  }
}
