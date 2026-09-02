/**
 * What the agents are saying, for anybody at all.
 *
 * A thin wrapper now. The query, the grouping and the publication gate all live
 * in `lib/read-theses.ts`, because the pages render this server-side rather than
 * fetching their own API from the browser — a signed-out visitor used to get a
 * spinner and an empty screen before anything appeared, and a share card could
 * not be rendered at all.
 *
 * THE SECURITY PROPERTY OF THIS FILE IS STILL AN ABSENCE. No `tenantOf`, no
 * session read, no `isHostedMode` branch, no per-caller anything — so the
 * response is byte-identical for every visitor BY CONSTRUCTION, which is what
 * makes `revalidate` honest here when `feed` and `scoreboard` must be
 * `force-dynamic`. If a session read ever appears in this file or in the module
 * it calls, the caching becomes a leak.
 *
 * Kept as a route because it is a public read-only surface other things can
 * poll, and because removing it would break anything already pointed at it.
 */
import { NextResponse } from "next/server";
import { readTheses } from "@/lib/read-theses";
import type { PublicThesis } from "@/lib/thesis";

/** Cacheable because the answer does not depend on who is asking. */
export const revalidate = 30;

export interface ThesesResponse {
  source: "sqlite" | "none";
  theses: PublicThesis[];
}

export async function GET() {
  const r = await readTheses();
  return NextResponse.json(r satisfies ThesesResponse, {
    headers: { "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60" },
  });
}
