/**
 * Looking a coin up before deciding anything about it.
 *
 * WHERE THIS SITS. The screen decides what is worth LOOKING at, using numbers
 * from an index. The scout decides what is worth BUYING, using a model. Between
 * them there was nothing that actually looked — and "does this coin have anyone
 * behind it" is the question a person answers first and this agent could not
 * answer at all.
 *
 * IT FEEDS THE SCOUT RATHER THAN REPORTING BESIDE IT. An earlier shape wrote
 * research to its own table and left the model deciding on the same numbers as
 * before, which would have made the browser expensive theatre. The signals go
 * into the candidate list the model ranks, so a site that never names its own
 * contract is something the model can weigh against a coin's volume.
 *
 * WHAT THE MODEL SEES IS STILL NOT AN ADDRESS. memecoin-scout deliberately shows
 * no address and takes answers as indices into the list it was handed; that
 * property is load-bearing and survives here. Site signals are booleans and
 * counts, which cannot name a token either.
 *
 * BOUNDED, BECAUSE A BROWSER IS THE MOST EXPENSIVE THING IN THE FLEET. One page
 * at a time, a hard ceiling per pass, and only for coins that published a site
 * worth visiting. A pass that researches nothing is a normal pass.
 */

import type { PublicClient } from "viem";
import type { GeckoPool } from "../venues/geckoterminal";
import { readTokenMeta, type TokenMeta } from "../venues/pons-meta";
import {
  readPage,
  signalsFrom,
  describeSignals,
  type BrowserConfig,
  type SiteSignals,
} from "../venues/research";

/**
 * How many coins one pass will visit.
 *
 * The browser serves one page at a time and a page takes a few seconds, so this
 * is a wall-clock budget as much as a cost one. Six keeps a discovery pass under
 * half a minute even when every site is slow, and the screen has already cut the
 * field to the handful worth the trouble.
 */
export const RESEARCH_PER_PASS = 6;

export interface CoinResearch {
  token: `0x${string}`;
  /** What the launcher published, from the chain. Claims, not facts. */
  meta: TokenMeta | null;
  /** What its website actually said. Absent when there was nothing to visit. */
  site: SiteSignals | null;
  /** One line for a human, and for the decision row. */
  summary: string;
}

/** Everything research needs, injected so the pipeline is testable offline. */
export interface ResearchDeps {
  client: PublicClient;
  browser: BrowserConfig | null;
  /** Injected for tests; defaults to the real reader. */
  fetchMeta?: typeof readTokenMeta;
  fetchPage?: typeof readPage;
  limit?: number;
}

/**
 * Research a shortlist of coins.
 *
 * Never throws into a discovery pass. A coin whose site is down is a coin whose
 * site is down — a fact worth recording, not an error worth stopping for.
 */
export async function researchCoins(
  pools: readonly GeckoPool[],
  deps: ResearchDeps,
): Promise<Map<string, CoinResearch>> {
  const out = new Map<string, CoinResearch>();
  if (!pools.length) return out;

  const fetchMeta = deps.fetchMeta ?? readTokenMeta;
  const fetchPage = deps.fetchPage ?? readPage;

  // One batched call for every coin's on-chain claims — cheap, and it decides
  // which of them are even worth a page visit.
  let meta = new Map<string, TokenMeta>();
  try {
    meta = await fetchMeta(deps.client, pools.map((p) => p.tokenAddress));
  } catch {
    /* the chain read failing is not a reason to skip the rest */
  }

  // Visit only coins that published a site. A coin with no website is not
  // researched and is not thereby condemned: `site: null` means "nothing to
  // visit", which the model reads differently from "visited and empty".
  const withSite = pools.filter((p) => (meta.get(p.tokenAddress.toLowerCase())?.website ?? "").length > 0);
  const budget = deps.limit ?? RESEARCH_PER_PASS;

  for (const p of pools) {
    const m = meta.get(p.tokenAddress.toLowerCase()) ?? null;
    out.set(p.tokenAddress.toLowerCase(), {
      token: p.tokenAddress,
      meta: m,
      site: null,
      summary: m ? (m.bare ? "published nothing about itself" : "published claims, site not visited") : "no on-chain metadata",
    });
  }

  let spent = 0;
  for (const p of withSite) {
    if (spent >= budget) break;
    spent++;
    const m = meta.get(p.tokenAddress.toLowerCase())!;
    const read = await fetchPage(deps.browser, m.website);
    const site = signalsFrom({ read, token: p.tokenAddress, claimedSocial: m.twitter });
    out.set(p.tokenAddress.toLowerCase(), {
      token: p.tokenAddress,
      meta: m,
      site,
      summary: describeSignals(site),
    });
  }
  return out;
}

/**
 * The research fields the model is shown, alongside the market numbers.
 *
 * Booleans and counts only — never the page text, and never an address. Handing
 * a model launcher-written prose to reason over is handing it an instruction
 * channel; `siteHype: 3` is a number it can weigh and cannot be told by.
 */
export interface ScoutSiteFields {
  /** null = nothing published to visit. false = published a site that did not answer. */
  siteReachable: boolean | null;
  siteNamesContract: boolean | null;
  siteTextLength: number | null;
  siteOutboundDomains: number | null;
  siteHypeWords: number | null;
  /** Published no description and no socials at all — an abandoned template. */
  publishedNothing: boolean | null;
}

export function scoutFieldsFor(r: CoinResearch | undefined): ScoutSiteFields {
  if (!r) {
    return {
      siteReachable: null,
      siteNamesContract: null,
      siteTextLength: null,
      siteOutboundDomains: null,
      siteHypeWords: null,
      publishedNothing: null,
    };
  }
  return {
    siteReachable: r.site ? r.site.reachable : null,
    siteNamesContract: r.site ? r.site.mentionsContract : null,
    siteTextLength: r.site ? r.site.textLength : null,
    siteOutboundDomains: r.site ? r.site.outboundDomains : null,
    siteHypeWords: r.site ? r.site.hypeWords : null,
    publishedNothing: r.meta ? r.meta.bare : null,
  };
}
