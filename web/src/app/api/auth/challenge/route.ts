/**
 * GET /api/auth/challenge — issue a one-time nonce for wallet login.
 *
 * The browser signs the message built from this nonce with the owner key, then
 * POSTs the signature to /api/auth/verify. The nonce is signed and origin-bound
 * so it cannot be forged or reused at another site.
 *
 * Hosted mode only. Self-hosted has no login (the localhost guard is its
 * perimeter), so this returns 404 there rather than inventing an auth flow
 * nobody asked for.
 */
import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { challengeMessage, issueChallengeNonce } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function originOf(req: Request): string {
  // Trust the deployment's own configured origin over a client-settable Host —
  // the signed message binds to THIS, so it must be the real public origin.
  const configured = process.env.MERRYMEN_PUBLIC_ORIGIN;
  if (configured) return configured.replace(/\/$/, "");
  return new URL(req.url).origin;
}

export async function GET(req: Request) {
  if (!isHostedMode()) return new NextResponse("not found", { status: 404 });
  try {
    const origin = originOf(req);
    const nonce = issueChallengeNonce(origin);
    return NextResponse.json({ origin, nonce, message: challengeMessage(origin, nonce) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "challenge failed" }, { status: 500 });
  }
}
