/**
 * The public ranking.
 *
 * Distinct from /api/scoreboard, which is per-caller and deliberately scoped —
 * its own header calls the unscoped version "a customer-list dump". This one
 * publishes a much narrower row: no smart account, no caps, no fees, no
 * high-water mark, and no absolute dollar figure at all. See lib/read-leaderboard.
 *
 * Cacheable for the same reason /api/theses is: there is no `tenantOf` and no
 * per-caller anything in this file or in the module it calls.
 */
import { NextResponse } from "next/server";
import { readLeaderboard } from "@/lib/read-leaderboard";

export const revalidate = 60;

export async function GET() {
  const r = await readLeaderboard();
  return NextResponse.json(r, {
    headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" },
  });
}
