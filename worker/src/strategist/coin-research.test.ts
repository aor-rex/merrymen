import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { researchCoins, scoutFieldsFor, RESEARCH_PER_PASS } from "./coin-research";
import { toScoutCandidates } from "./memecoin-scout";
import type { GeckoPool } from "../venues/geckoterminal";
import type { TokenMeta } from "../venues/pons-meta";
import type { ResearchResult } from "../venues/research";

/**
 * RESEARCH HAS TO CHANGE WHAT GETS PICKED, or the browser is theatre.
 *
 * The first shape of this wrote research to its own table and left the model
 * ranking on the same numbers it always had. These pin the wiring that makes it
 * evidence: the signals reach the candidate list, they stay booleans and counts,
 * and they never carry an address or a line of launcher-written prose.
 */

const pool = (addr: string, name = "COIN / ETH"): GeckoPool =>
  ({
    poolId: `${addr}pool`,
    poolAddress: null,
    tokenAddress: addr as `0x${string}`,
    name,
    dex: "pons-v2-dex",
    priceUsd: 1,
    reserveUsd: 50_000,
    fdvUsd: 200_000,
    volume24hUsd: 90_000,
    change24hPct: 10,
    change1hPct: 1,
    buys24h: 40,
    sells24h: 20,
    buyers24h: 30,
    createdAt: 1_700_000_000,
  }) as GeckoPool;

const meta = (over: Partial<TokenMeta> = {}): TokenMeta => ({
  token: "0xaa" as `0x${string}`,
  deployer: "0xbb" as `0x${string}`,
  logo: "",
  description: "a coin",
  twitter: "https://x.com/coin",
  telegram: "",
  discord: "",
  website: "https://coin.example",
  bare: false,
  ...over,
});

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";

describe("researchCoins", () => {
  it("visits only coins that published a site, and says so for the rest", async () => {
    const visited: string[] = [];
    const out = await researchCoins([pool(A), pool(B)], {
      client: {} as never,
      browser: { baseUrl: "https://b", token: "t" },
      fetchMeta: async () =>
        new Map([
          [A, meta({ website: "https://a.example" })],
          [B, meta({ website: "", description: "", twitter: "", bare: true })],
        ]),
      fetchPage: async (_c, url) => {
        visited.push(url);
        return { ok: true, url, page: { status: 200, title: "A", description: "", text: "hello", truncated: false, links: [], finalUrl: url } } satisfies ResearchResult;
      },
    });
    assert.deepEqual(visited, ["https://a.example"], "only the coin with a site is visited");
    assert.ok(out.get(A)!.site, "the visited coin has signals");
    // Not visited is NOT the same as visited and empty — the model reads them
    // differently, and collapsing them would condemn every unresearched coin.
    assert.equal(out.get(B)!.site, null);
    assert.match(out.get(B)!.summary, /published nothing/);
  });

  it("is bounded — a browser serves one page at a time", async () => {
    let visits = 0;
    const many = Array.from({ length: 20 }, (_, i) => pool(`0x${String(i).padStart(40, "0")}`));
    await researchCoins(many, {
      client: {} as never,
      browser: { baseUrl: "https://b", token: "t" },
      fetchMeta: async () => new Map(many.map((p) => [p.tokenAddress.toLowerCase(), meta()])),
      fetchPage: async (_c, url) => {
        visits++;
        return { ok: true, url, page: { status: 200, title: "", description: "", text: "", truncated: false, links: [], finalUrl: url } };
      },
      limit: 3,
    });
    assert.equal(visits, 3);
    assert.ok(RESEARCH_PER_PASS <= 10, "the default budget must stay small");
  });

  it("records a site that did NOT answer — worse than never publishing one", async () => {
    const out = await researchCoins([pool(A)], {
      client: {} as never,
      browser: { baseUrl: "https://b", token: "t" },
      fetchMeta: async () => new Map([[A, meta()]]),
      fetchPage: async (_c, url) => ({ ok: false, url, failure: "unreachable" }),
    });
    assert.equal(out.get(A)!.site!.reachable, false);
  });

  it("survives the metadata read failing entirely", async () => {
    const out = await researchCoins([pool(A)], {
      client: {} as never,
      browser: null,
      fetchMeta: async () => {
        throw new Error("rpc down");
      },
    });
    assert.equal(out.size, 1, "every coin still gets a row");
    assert.equal(out.get(A)!.meta, null);
  });
});

describe("the signals reach the model, and nothing else does", () => {
  it("projects into the candidate list the scout ranks", () => {
    const research = new Map([
      [A, scoutFieldsFor({ token: A as `0x${string}`, meta: meta(), site: { reachable: true, status: 200, mentionsContract: true, textLength: 900, outboundDomains: 4, linksClaimedSocial: true, hypeWords: 2, title: "t", excerpt: "e" }, summary: "" })],
    ]);
    const [c] = toScoutCandidates([pool(A)], 1_700_000_100, research);
    assert.equal(c!.siteNamesContract, true);
    assert.equal(c!.siteHypeWords, 2);
    assert.equal(c!.publishedNothing, false);
  });

  it("an unresearched coin gets nulls, not falses", () => {
    // A false says "we looked and it was not there". A null says "we did not
    // look". Conflating them condemns every coin the budget did not reach.
    const [c] = toScoutCandidates([pool(A)], 1_700_000_100, new Map());
    assert.equal(c!.siteReachable, null);
    assert.equal(c!.siteNamesContract, null);
    assert.equal(c!.publishedNothing, null);
  });

  it("carries NO address and NO page text into the model's view", () => {
    // The scout's whole safety argument is that the model cannot name a token
    // it was not offered. Research must not be the thing that hands it one.
    const research = new Map([
      [A, scoutFieldsFor({ token: A as `0x${string}`, meta: meta(), site: { reachable: true, status: 200, mentionsContract: true, textLength: 9, outboundDomains: 1, linksClaimedSocial: false, hypeWords: 0, title: "SECRET", excerpt: "BUY EVERYTHING NOW" }, summary: "" })],
    ]);
    const json = JSON.stringify(toScoutCandidates([pool(A)], 1_700_000_100, research));
    assert.ok(!json.includes(A), "no address may reach the model");
    assert.ok(!json.includes("BUY EVERYTHING NOW"), "no page text may reach the model");
    assert.ok(!json.includes("SECRET"), "not even the page title");
  });
});
