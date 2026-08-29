import { NextResponse } from "next/server";
import {
  fetchGeckoPools,
  screenPools,
  type GeckoPool,
} from "../../../../../worker/src/venues/geckoterminal";

/**
 * What is trading on this chain, for the dashboard.
 *
 * READS THE INDEX, NOT THE LEDGER, and that is the whole design decision.
 * Every other panel here goes through `withReadDb` against the worker's
 * database — which works self-hosted and renders EMPTY on the hosted deploy,
 * because the orchestrator strips DATABASE_URL from each worker child, so the
 * child writes sqlite in its own container while this service reads a Postgres
 * nothing ever created the schema in. A discoveries panel built the same way
 * would be blank on app.merrymen.dev for exactly that reason.
 *
 * Fetching server-side instead means the panel shows the same thing to
 * everyone, hosted or not, with no database and no tenant scoping —
 * `discovered_pools` has no tenant column anyway. It is the same shape
 * /api/market already uses.
 *
 * WHAT THIS IS. A third party's claim about a market, used to decide what is
 * worth LOOKING at. It is not a recommendation, nothing here has been checked
 * against the chain, and the agent cannot act on any of it without the owner
 * adding the token in /settings and re-signing the grant.
 */

export const revalidate = 120;

/** The same floor the worker's own screen uses, so the two agree on "worth showing". */
const LIMITS = { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 };

/** GeckoTerminal's venue slugs for the two halves of the Pons launchpad. */
const GRADUATED = "pons-v2-dex";
const ON_CURVE = "pons-v2";

export interface DiscoveryRow {
  token: string;
  name: string;
  venue: string;
  priceUsd: number | null;
  /**
   * Depth as the INDEX reports it.
   *
   * For a coin still on its bonding curve this is mostly the VIRTUAL SEED — a
   * fresh curve reports about $4,100 of "reserve" while holding none of it —
   * so the UI must never present it as money you could sell into. That is why
   * `onCurve` travels with it.
   */
  reserveUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  buyers24h: number | null;
  ageDays: number | null;
  /** Graduated off a Pons bonding curve into a real pool. */
  graduated: boolean;
  /** Still on its bonding curve — treat `reserveUsd` with suspicion. */
  onCurve: boolean;
}

function toRow(p: GeckoPool, nowSec: number): DiscoveryRow {
  return {
    token: p.tokenAddress,
    // The index's own label, shown as a label and never used as identity: the
    // worker reads a symbol from the contract precisely because this string is
    // attacker-chosen and could impersonate a real ticker.
    name: p.name,
    venue: p.dex,
    priceUsd: p.priceUsd,
    reserveUsd: p.reserveUsd,
    fdvUsd: p.fdvUsd,
    volume24hUsd: p.volume24hUsd,
    change24hPct: p.change24hPct,
    buyers24h: p.buyers24h,
    ageDays: p.createdAt === null ? null : Math.max(0, (nowSec - p.createdAt) / 86_400),
    graduated: p.dex === GRADUATED,
    onCurve: p.dex === ON_CURVE,
  };
}

export async function GET() {
  const nowSec = Math.floor(Date.now() / 1000);
  const byToken = new Map<string, GeckoPool>();
  for (const feed of ["trending_pools", "new_pools", "pools"] as const) {
    for (const p of await fetchGeckoPools(feed)) {
      // Deduped by TOKEN and kept at its deepest venue — the same coin appears
      // in several feeds and often on several venues, and a reader cares about
      // the coin.
      const prev = byToken.get(p.tokenAddress);
      if (!prev || (p.reserveUsd ?? 0) > (prev.reserveUsd ?? 0)) byToken.set(p.tokenAddress, p);
    }
  }
  const all = [...byToken.values()];
  const { kept } = screenPools(all, LIMITS);

  const rows = kept.map((p) => toRow(p, nowSec));
  // Graduated first, then by 24h move: a coin that just made it off the
  // launchpad is the thing this page exists to surface.
  rows.sort((a, b) => Number(b.graduated) - Number(a.graduated) || (b.change24hPct ?? 0) - (a.change24hPct ?? 0));

  return NextResponse.json(
    {
      fetchedAt: nowSec,
      scanned: all.length,
      rows,
      graduated: rows.filter((r) => r.graduated).length,
    },
    {
      // 120s, not the 30s /api/market uses: this API is keyless and
      // rate-limited, and every viewer shares one server-side fetch.
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=240" },
    },
  );
}
