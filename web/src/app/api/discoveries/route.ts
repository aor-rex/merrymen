import { NextResponse } from "next/server";
import { createPublicClient, http } from "viem";
import {
  fetchGeckoPoolsResult,
  screenPools,
  type GeckoPool,
} from "../../../../../worker/src/venues/geckoterminal";
import { recentPonsLaunches } from "../../../../../worker/src/venues/pons";
import {
  readCurveActivity,
  isActive,
  MAX_ACTIVITY_BLOCKS,
} from "../../../../../worker/src/venues/pons-activity";
import { readTokenMeta } from "../../../../../worker/src/venues/pons-meta";
import {
  readCardFacts,
  readBlockClock,
  ageSecOf,
} from "../../../../../worker/src/venues/pons-card";

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

/** A launch from the last few minutes that people are actually trading. */
export interface FreshRow {
  token: string;
  curve: string;
  trades: number;
  /** Distinct trading ADDRESSES, from the trade event's own indexed field. */
  traders: number;
  /** The launcher's own words. Sanitised, and a claim rather than a fact. */
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  /** Published nothing at all — the shape an abandoned template has. */
  bare: boolean;
  /** The ERC-20's own ticker, from the chain. Empty when unreadable. */
  symbol: string;
  /** The ERC-20's own name, from the chain. Empty when unreadable. */
  name: string;
  /**
   * The launcher's logo URI, usually `ipfs://…`. Never given to a browser
   * directly — it goes through /api/coin-image, which is both what makes it
   * load at all (every gateway 403s a browser User-Agent) and what keeps an
   * attacker-chosen URL out of the reader's browser.
   */
  logo: string;
  /** Seconds since it launched, measured from a real block clock. Null when unknown. */
  ageSec: number | null;
  /** Basis points of its own graduation threshold, net of the virtual seed. */
  progressBps: number | null;
}

/**
 * The other end of the launchpad: what launched in the last quarter hour and
 * has a tape.
 *
 * Pons runs at roughly 940 launches an hour, so this is a FUNNEL rather than a
 * list. The gate is trading — 25 trades and 3 distinct addresses — which keeps
 * about an eighth of launches and holds 96% of the ones that go on to graduate.
 * A dev buy, having socials, and the creator's history were all measured and
 * are worth nothing as filters.
 *
 * Three RPC calls for the whole thing, whatever the launch rate: the launches,
 * one chain-wide sweep of every curve trade, and one Multicall3 batch for the
 * survivors' metadata.
 */
async function readFresh(): Promise<FreshRow[]> {
  try {
    const client = createPublicClient({ transport: http("https://rpc.mainnet.chain.robinhood.com") });
    const W = MAX_ACTIVITY_BLOCKS;
    const [scan, activity] = await Promise.all([
      recentPonsLaunches(client as never, W),
      readCurveActivity(client as never, W),
    ]);
    // A null activity map means the node refused, which is a different fact
    // from a quiet launchpad — showing nothing is right, inventing an empty
    // tape for every launch is not.
    if (scan.failed || !activity) return [];
    const live = scan.launches.filter((l) => isActive(activity.get(l.curve.toLowerCase())));
    // Three more reads for the whole page, not per coin: the launcher's claims,
    // the chain's own symbol/name/curve-progress, and one block clock so age
    // can be derived from a block number without asking per launch.
    const [meta, facts, clock] = await Promise.all([
      readTokenMeta(client as never, live.map((l) => l.token)),
      readCardFacts(client as never, live),
      readBlockClock(client as never),
    ]);
    return live
      .map((l) => {
        const a = activity.get(l.curve.toLowerCase())!;
        const m = meta.get(l.token.toLowerCase());
        const f = facts.get(l.token.toLowerCase());
        return {
          token: l.token,
          curve: l.curve,
          trades: a.buys + a.sells,
          traders: a.traders,
          description: m?.description ?? "",
          twitter: m?.twitter ?? "",
          telegram: m?.telegram ?? "",
          website: m?.website ?? "",
          bare: m ? m.bare : true,
          symbol: f?.symbol ?? "",
          name: f?.name ?? "",
          logo: m?.logo ?? "",
          ageSec: ageSecOf(clock, l.blockNumber),
          progressBps: f?.progressBps ?? null,
        };
      })
      // By distinct addresses, not trade count: 291 trades from 25 addresses is
      // a different thing from 223 trades from 176, and only one of them looks
      // like people.
      .sort((x, y) => y.traders - x.traders);
  } catch {
    return [];
  }
}

export async function GET() {
  const nowSec = Math.floor(Date.now() / 1000);
  const fresh = await readFresh();
  const byToken = new Map<string, GeckoPool>();
  // Every feed refused is a different fact from every feed being empty, and
  // only one of them means the market is quiet. This API is keyless and
  // rate-limited, so the refusal is routine — and a page that renders it as
  // "nothing clearing the floor" states something false while looking normal.
  let asked = 0;
  let reached = 0;
  for (const feed of ["trending_pools", "new_pools", "pools"] as const) {
    const r = await fetchGeckoPoolsResult(feed);
    asked++;
    if (!r.failed) reached++;
    for (const p of r.pools) {
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
      // False only when NOT ONE feed answered. A partial read is still a read.
      indexUnreachable: reached === 0 && asked > 0,
      rows,
      graduated: rows.filter((r) => r.graduated).length,
      fresh,
    },
    {
      // 120s, not the 30s /api/market uses: this API is keyless and
      // rate-limited, and every viewer shares one server-side fetch.
      headers: { "Cache-Control": "public, s-maxage=120, stale-while-revalidate=240" },
    },
  );
}
