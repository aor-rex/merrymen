/**
 * GET /api/auth/session — who am I? Returns the authenticated tenant address,
 * or { address: null } when not logged in. Read-only, safe to poll.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isHostedMode()) return NextResponse.json({ hosted: false, address: null });
  return NextResponse.json({ hosted: true, address: tenantOf(req) });
}
