/**
 * The day's intents and what the wall did with them, as JSON.
 *
 * Exists so the bottom tape can open with the fleet's own headline number
 * instead of somebody else's coin price. Same reader the band uses, same
 * absence of any session read — which is what keeps it cacheable.
 */
import { NextResponse } from "next/server";
import { readWallTape } from "@/lib/read-wall-tape";

export const revalidate = 30;

export async function GET() {
  const t = await readWallTape();
  // The cells are for a canvas and are large; a tape only needs the totals.
  return NextResponse.json(
    { source: t.source, counts: t.counts, capped: t.capped, from: t.from, to: t.to },
    { headers: { "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60" } },
  );
}
