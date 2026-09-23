/**
 * WHAT BOTH GROUP-CHAT ROUTES NEED AND NEITHER MAY GUESS: the room's database,
 * and who a signed-in owner is inside it.
 *
 * Not a route. It sits beside the two route files because Next treats every
 * export of a route.ts as part of the route's contract, so a shared helper or a
 * test seam exported from one would be an export the build does not expect.
 *
 * THE ROOM LIVES IN THE SHARED POSTGRES OR NOWHERE. The orchestrator writes it
 * there (docs/groupchat.md), so a web process without DATABASE_URL has no room
 * to read — and `withReadDb`'s no-URL fallback is the self-hosted ledger file,
 * opened read-only, which is the wrong database AND cannot take an owner's
 * line. So "no DATABASE_URL" is answered as "no room" here, before that
 * fallback can be reached.
 *
 * WHO AN OWNER IS comes from the grant store (tenant → current smart account)
 * and the identity store (tenant → slug), never from `agents` keyed on the
 * owner's address: hosted, that column holds the browser-generated owner key,
 * which is never the tenant (see lib/agent-for.ts). `agents` is read only for
 * the NAME, keyed on the smart account the grant store returned.
 */
import { getGrantStore } from "@merrymen/grant-store";
import { getIdentityStore, SLUG_RE } from "@merrymen/identity-store";
import { withReadDb } from "@/lib/ledger";
import type { Db } from "../../../../../worker/src/db";
import { ensureGroupchatSchema } from "../../../../../worker/src/groupchat/store";
import { roomName } from "../../../../../worker/src/groupchat/facts";

/** A database the room's tables can be read and written in, and the dialect it speaks. */
export interface Room {
  db: Db;
  dialect: "postgres" | "sqlite";
}

/** How the room names an owner's line, resolved at write time. */
export interface Speaker {
  /** The agent's CURRENT smart account, lowercased. Stored on the line, never shown. */
  agentId: string;
  slug: string | null;
  /** The agent's name exactly as the room shows it. */
  name: string;
}

/**
 * THE TEST SEAM: a room other than the shared Postgres, and a clock.
 *
 * Tests hand in an in-memory sqlite through the ledger's own driver, so every
 * statement the routes run is the store's real SQL on a real engine. Nothing
 * reachable from a request can set it.
 */
let seam: { db: Db; now?: () => number } | null = null;
export function setRoomForTest(next: { db: Db; now?: () => number } | null): void {
  seam = next;
}

/** Wall-clock ms, or the test's. The route never reads the process clock itself. */
export function roomNow(): number {
  return seam?.now ? seam.now() : Date.now();
}

/**
 * Run `fn` against the room, or against null when this deploy has none.
 *
 * The schema is ensured here, once per Db for the life of the process (the
 * store memoises it and retries after a failure). A connection or schema
 * failure THROWS: the caller decides whether that is `source: "none"` or a 503,
 * and neither may be mistaken for an empty room.
 */
export async function withRoom<T>(fn: (room: Room | null) => Promise<T>): Promise<T> {
  if (seam) {
    await ensureGroupchatSchema(seam.db, "sqlite");
    return fn({ db: seam.db, dialect: "sqlite" });
  }
  if (!process.env.DATABASE_URL) return fn(null);
  return withReadDb(async (db) => {
    if (!db) return fn(null);
    await ensureGroupchatSchema(db, "postgres");
    return fn({ db, dialect: "postgres" });
  });
}

/**
 * The signed-in tenant's current smart account, or null when they have no
 * agent. THROWS when the store cannot be read: "could not tell" must never be
 * answered as "has no agent", which would tell an owner they are not one.
 */
export async function agentOf(tenant: `0x${string}`): Promise<string | null> {
  const grant = await getGrantStore().get(tenant);
  const account = grant?.smartAccount;
  return typeof account === "string" && account ? account.toLowerCase() : null;
}

/**
 * The slug and name the room shows for this tenant's agent.
 *
 * THE SAME NAME THE CONDUCTOR USES, through the same function (`roomName`):
 * the owned name, or — for the stock "Robin", an empty or address-shaped
 * name — the slug's generated one. An owner labelled "Robin's owner" while
 * their agent speaks as "Amber Heron" would be an owner nobody can match to
 * their agent.
 *
 * THROWS on an unreadable store or ledger rather than falling back. A line is
 * stored with its label, so a wrong label written during a blip is wrong for
 * as long as the line lives.
 */
export async function speakerOf(db: Db, tenant: `0x${string}`, agentId: string): Promise<Speaker> {
  const identity = await getIdentityStore().get(tenant);
  const slug = identity && typeof identity.slug === "string" && SLUG_RE.test(identity.slug) ? identity.slug : null;
  const row = (await db
    .prepare("SELECT name FROM agents WHERE LOWER(smart_account) = ? LIMIT 1")
    .get(agentId.toLowerCase())) as { name?: unknown } | undefined;
  return { agentId: agentId.toLowerCase(), slug, name: roomName(row?.name, slug) };
}

/**
 * The request body as text, or null when it is larger than `limit` bytes.
 *
 * Counted while it streams, so an oversized body is refused without being held
 * in memory whole; the declared length is checked first as the cheap case.
 */
export async function readBounded(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A JSON object body, or null for anything else (a bare value, an array, not JSON). */
export function objectOf(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Per-caller answers. A shared cache holding one owner's reply would hand it to the next reader. */
export const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;
