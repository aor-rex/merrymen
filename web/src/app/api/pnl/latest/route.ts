import { NextResponse } from "next/server";
import { hostedAgentFor } from "@/lib/agent-for";
import { withReadDb } from "@/lib/ledger";
import { findLatestCardableInDb } from "@/lib/pnl-latest";

/**
 * The owner's latest cardable closed trade, as JSON — the lookup half of the
 * chat `pnl` command. The picture itself still comes from GET /api/pnl, so
 * there is exactly one renderer; this route answers only "WHICH trade",
 * never drawing anything.
 *
 * CARDABLE, not merely closed: fill_side sell, realized + cash present, a
 * nameable coin, and at least a cent invested (see findLatestCardable — same
 * gates as pnlCardFromFill, which re-validates before drawing). The sell
 * predicate lives in SQL with keyset pagination, so newer buys/refusals can
 * never truncate a valid close out of the window. No closed trades at all
 * (or none cardable) is `{ none: true }`, not an error — the panel says so
 * plainly instead of failing.
 *
 * SCOPED exactly like /api/pnl: agent bound from the session's grant, never
 * the query. Signed-out callers get 404, for the same reason (existence is
 * not theirs to learn).
 */

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: Request) {
  const agent = await hostedAgentFor(req);
  if (!agent) return new NextResponse("not found", { status: 404 });

  const found = await withReadDb(async (db) => {
    if (!db) return null;
    try {
      return await findLatestCardableInDb(db, agent);
    } catch {
      return null;
    }
  });

  if (!found) return NextResponse.json({ none: true }, { headers: { "Cache-Control": "private, no-store" } });
  return NextResponse.json(found, { headers: { "Cache-Control": "private, no-store" } });
}
