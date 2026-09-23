import { NextResponse } from "next/server";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { readOwnBook } from "@/lib/read-agent";

/**
 * THE OWNER'S OWN VIEW OF THEIR PROFILE: its trades with their sizes and
 * dollars, which the public route withholds from everyone on a private book.
 *
 * A SEPARATE ROUTE, NOT A BRANCH OF THE PUBLIC ONE. /api/agents/[slug] answers
 * the same thing to every caller and takes no session; mixing a per-owner
 * answer into it would make one URL public for some callers and private for
 * others, one cache header away from serving an owner's dollars to a stranger.
 *
 * HOSTED ONLY. The owner is the SIWE session's tenant, matched against the
 * identity store's record of whose slug this is (readOwnBook); nothing in the
 * request can name an owner. Self-hosted has no sessions to check, so there is
 * no owner's view to serve — the owner's desk shows those dollars there.
 *
 * Never cached: `private, no-store`, so no shared cache can keep it.
 */
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(slug)) return NextResponse.json({ error: "Invalid agent" }, { status: 400, headers: PRIVATE });
  if (!isHostedMode()) return NextResponse.json({ error: "Not available on a self-hosted install." }, { status: 404, headers: PRIVATE });
  const tenant = tenantOf(req);
  if (!tenant) return NextResponse.json({ error: "Sign in to see your own agent's figures." }, { status: 401, headers: PRIVATE });
  const r = await readOwnBook(slug, tenant);
  if (r.status !== 200) return NextResponse.json({ error: r.error }, { status: r.status, headers: PRIVATE });
  return NextResponse.json(r.book, { headers: PRIVATE });
}
