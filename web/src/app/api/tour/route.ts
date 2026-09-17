/**
 * HAS THIS OWNER BEEN SHOWN AROUND, AND SAY THAT THEY HAVE.
 *
 * ── NOT SIGNED IN IS AN ANSWER, NOT AN ERROR ────────────────────────────────
 *
 * Every other hosted-only route here answers 401 to a signed-out caller, and
 * that is right for them: following an agent or liking a post is meaningless
 * without an owner, so refusing is the honest reply.
 *
 * This route is different, and the difference is the whole design. The tour is
 * shown to EVERYONE, including a visitor who has never signed in — they are the
 * people it exists for. If a signed-out GET answered 401, the component would
 * have to treat its own normal case as a failure, and the first thing anyone
 * does with a failing fetch is stop calling it or start ignoring it. Either way
 * a real error would then be invisible.
 *
 * So both verbs answer 200 with `signedIn: false`, which the caller reads as
 * "the server has no opinion about you" — a different fact from "the server says
 * you have not seen it". The component keeps `localStorage`, which is the layer
 * that is always present, and treats the server as an upgrade that survives a
 * new browser rather than as the source of truth.
 *
 * Self-hosted gets the same shape for the same reason: one operator, one
 * machine, nothing to attribute a dismissal to. The rest of the hosted-only
 * surface 404s there; a 404 here would again turn the ordinary case into an
 * error the client must special-case.
 *
 * ── WHY THERE IS NO "UNDO" VERB ─────────────────────────────────────────────
 *
 * `clear` exists on the store for the kill path and for tests, and deliberately
 * has no route. A public way to un-dismiss would be a way to make somebody
 * else's product interrupt them, and the owner-facing need it would serve —
 * "show me that again" — is already met without touching the server: the
 * component's own relaunch control reopens the tour locally for whoever pressed
 * it, which is exactly who asked.
 */
import { NextResponse } from "next/server";
import { tenantOf } from "@/lib/auth";
import { getTourStore } from "@/lib/tour-store";

export const dynamic = "force-dynamic";

export interface TourResponse {
  /** Whether the SERVER has a record of this owner finishing or skipping. */
  done: boolean;
  /**
   * Whether there was anybody to ask about.
   *
   * `done:false, signedIn:false` means "no opinion" and must never be read as
   * "this person has not seen the tour" — the client's own storage is the only
   * thing that knows, and it should win.
   */
  signedIn: boolean;
}

export async function GET(req: Request) {
  const tenant = tenantOf(req);
  if (!tenant) return NextResponse.json({ done: false, signedIn: false } satisfies TourResponse);
  try {
    return NextResponse.json({ done: await getTourStore().done(tenant), signedIn: true } satisfies TourResponse);
  } catch {
    // A STORE THAT WILL NOT ANSWER IS NOT A "NO". Reporting `done:false` here
    // would reopen the tour for someone who dismissed it the moment the
    // database hiccuped, which is precisely the complaint this route was built
    // to end. `signedIn:false` is the honest shape: we could not ask.
    return NextResponse.json({ done: false, signedIn: false } satisfies TourResponse);
  }
}

export async function POST(req: Request) {
  const tenant = tenantOf(req);
  if (!tenant) return NextResponse.json({ done: false, signedIn: false } satisfies TourResponse);
  try {
    await getTourStore().markDone(tenant);
    return NextResponse.json({ done: true, signedIn: true } satisfies TourResponse);
  } catch {
    // The client has already written its own copy before calling this, so a
    // failure here costs a re-show on a DIFFERENT device and nothing on this
    // one. Saying so plainly beats a 500 the component would have to swallow.
    return NextResponse.json({ done: false, signedIn: false } satisfies TourResponse);
  }
}
