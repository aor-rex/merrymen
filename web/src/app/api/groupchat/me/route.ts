/**
 * AN OWNER'S OWN CORNER OF THE ROOM: may I post, what is my agent called
 * there, when does it sleep, and is it muted.
 *
 * PRIVATE AND NEVER CACHED. Everything here is about the caller — their time
 * zone above all, which rule 3 of docs/groupchat.md keeps out of the room — so
 * it is the per-reader half that the public GET must never grow.
 *
 * THE SLEEP HOURS ARE COMPUTED HERE, NOT IN THE BROWSER, with the key the
 * conductor uses: the lowercased tenant. A second computation anywhere else is
 * how an owner is shown one window while the room runs another.
 *
 * A BROWSER NEVER OVERWRITES AN OWNER. The zone arrives two ways: OwnerClock
 * posts the browser's zone once a session (`source: "browser"`), and the chat
 * screen posts the owner's pick (`source: "owner"`). A traveller's laptop must
 * not undo a choice its owner made, so a browser capture is dropped whenever
 * the stored source is "owner" — here, to answer without a write, and again
 * inside the store's upsert, which is the part that is atomic against a pick
 * landing at the same moment. That includes the choice of NO zone: `{tz: null,
 * source: "owner"}` forgets the zone as the owner's decision, so the agent
 * never sleeps until they pick one, instead of until the next page load.
 *
 * Hosted only (404 otherwise), like the room it describes.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import type { Db } from "../../../../../../worker/src/db";
import { canonicalTz, fmtHm, sleepWindow } from "../../../../../../worker/src/groupchat/clock";
import { getMember, setMemberPrefs } from "../../../../../../worker/src/groupchat/store";
import type { MeResponse, TzSource } from "../../../../../../worker/src/groupchat/types";
import { agentOf, objectOf, PRIVATE_HEADERS, readBounded, roomNow, speakerOf, withRoom } from "../room";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `{tz, source, muted}` fits in a fraction of this. */
const BODY_MAX_BYTES = 1024;

const SIGNED_OUT: MeResponse = {
  signedIn: false,
  member: false,
  slug: null,
  name: null,
  tz: null,
  tzSource: null,
  muted: false,
  sleep: null,
};

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
const refuse = (status: number, error: string) => json({ error }, status);

/**
 * The caller's membership as the chat screen draws it.
 *
 * THROWS when a store cannot be read, rather than answering "not a member":
 * the screen keeps its last answer on a failure, and a composer that vanished
 * because one read blinked would read as being thrown out of the room.
 */
async function meFor(db: Db, tenant: `0x${string}`): Promise<MeResponse> {
  const agentId = await agentOf(tenant);
  const speaker = agentId ? await speakerOf(db, tenant, agentId) : null;
  const prefs = await getMember(db, tenant);
  const tz = prefs?.tz ?? null;
  // Hours only for a zone the clock can actually run: the conductor treats an
  // unusable zone as "never sleeps", and the screen must say the same.
  const hours = tz !== null && canonicalTz(tz) !== null ? sleepWindow(tenant.toLowerCase()) : null;
  return {
    signedIn: true,
    member: agentId !== null,
    slug: speaker?.slug ?? null,
    name: speaker?.name ?? null,
    tz,
    tzSource: prefs?.tzSource ?? null,
    muted: prefs?.muted ?? false,
    sleep: hours ? { from: fmtHm(hours.startMin), to: fmtHm(hours.endMin) } : null,
  };
}

export async function GET(req: Request) {
  if (!isHostedMode()) return refuse(404, "not found");
  const tenant = tenantOf(req);
  // Signed out is a complete answer, not an error: the screen shows the room
  // and says why there is no composer.
  if (!tenant) return json(SIGNED_OUT);
  try {
    const me = await withRoom(async (room) => (room ? meFor(room.db, tenant) : null));
    return me ? json(me) : refuse(503, "The group chat isn't available right now.");
  } catch {
    return refuse(503, "Couldn't load your group chat settings. Try again in a moment.");
  }
}

/** What the body asks to change, or the owner-facing reason it cannot be read. */
type Change =
  | { ok: true; zone?: { tz: string | null; tzSource: TzSource }; muted?: boolean }
  | { ok: false; error: string };

function changeOf(input: Record<string, unknown>): Change {
  const out: { ok: true; zone?: { tz: string | null; tzSource: TzSource }; muted?: boolean } = { ok: true };
  if ("muted" in input) {
    if (typeof input.muted !== "boolean") return { ok: false, error: "muted is true or false." };
    out.muted = input.muted;
  }
  if ("tz" in input) {
    const source = input.source;
    if (source !== "browser" && source !== "owner") return { ok: false, error: "Say where the time zone came from." };
    if (input.tz === null) {
      // Forgetting a zone is a choice only its owner makes; a browser always has one.
      if (source !== "owner") return { ok: false, error: "Choose a time zone." };
      out.zone = { tz: null, tzSource: "owner" };
    } else {
      const tz = canonicalTz(input.tz);
      if (!tz) return { ok: false, error: "That isn't a time zone we know." };
      out.zone = { tz, tzSource: source };
    }
  }
  if (!out.zone && out.muted === undefined) return { ok: false, error: "Nothing to change." };
  return out;
}

export async function POST(req: Request) {
  if (!isHostedMode()) return refuse(404, "not found");
  const tenant = tenantOf(req);
  if (!tenant) return refuse(401, "Sign in to change this.");

  let text: string | null;
  try {
    text = await readBounded(req, BODY_MAX_BYTES);
  } catch {
    return refuse(400, "expected JSON");
  }
  if (text === null) return refuse(413, "That request is too large.");
  const input = objectOf(text);
  if (!input) return refuse(400, "expected JSON");
  const change = changeOf(input);
  if (!change.ok) return refuse(400, change.error);

  try {
    const me = await withRoom(async (room) => {
      if (!room) return null;
      const current = await getMember(room.db, tenant);
      const write: { tz?: string | null; tzSource?: TzSource | null; muted?: boolean } = {};
      const zone = change.zone;
      if (zone) {
        const ownerChose = zone.tzSource === "browser" && current?.tzSource === "owner";
        // The same capture every page load writes nothing new.
        const unchanged = zone.tzSource === "browser" && current?.tzSource === "browser" && current.tz === zone.tz;
        if (!ownerChose && !unchanged) {
          write.tz = zone.tz;
          write.tzSource = zone.tzSource;
        }
      }
      if (change.muted !== undefined) write.muted = change.muted;
      if (Object.keys(write).length > 0) await setMemberPrefs(room.db, tenant, write, roomNow());
      return meFor(room.db, tenant);
    });
    return me ? json(me) : refuse(503, "The group chat isn't available right now.");
  } catch {
    return refuse(503, "That didn't save. Try again.");
  }
}
