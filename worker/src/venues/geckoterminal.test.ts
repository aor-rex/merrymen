import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGeckoPool, screenPools, type GeckoPool } from "./geckoterminal";

/**
 * Reading the market the agent could not see.
 *
 * CHUMP below is a VERBATIM trending_pools row for chain 4663, captured
 * 2026-08-29 — not a hand-written fixture. That matters twice over: every
 * numeric field really does arrive as a string, and this pool launched on
 * 2026-07-31, so it is exactly the "trending but not new" token discovery was
 * structurally blind to. If GeckoTerminal changes its shape, this is what should
 * fail, rather than the screen quietly returning nothing forever.
 */
const CHUMP = {
  id: "robinhood_0x714442e9a611f8561a7df108d6d925132937cfb8",
  type: "pool",
  attributes: {
    base_token_price_usd: "0.0222452357304331",
    address: "0x714442e9a611f8561a7df108d6d925132937cfb8",
    name: "CHUMP / WETH 1%",
    pool_created_at: "2026-07-31T01:44:31Z",
    fdv_usd: "22254823.9491408",
    price_change_percentage: { m5: "-2.926", h1: "3.391", h24: "16.413" },
    transactions: {
      m5: { buys: 22, sells: 33, buyers: 12, sellers: 16 },
      h24: { buys: 12720, sells: 10799, buyers: 1592, sellers: 1682 },
    },
    volume_usd: { m5: "10344.8738645394", h24: "2123773.6057423" },
    reserve_in_usd: "521702.1056",
  },
  relationships: {
    base_token: { data: { id: "robinhood_0x0e0d2c89a5a019fe1cf762e5e33187631dacc21b", type: "token" } },
    quote_token: { data: { id: "robinhood_0x0bd7d308f8e1639fab988df18a8011f41eacad73", type: "token" } },
    dex: { data: { id: "uniswap-v3-robinhood", type: "dex" } },
  },
};

/**
 * A real `pons-v2-dex` trending row, same capture. Identified by a 32-byte
 * poolId rather than a contract address — as are the v4 and Bankr pools.
 */
const MICRODUCK = {
  attributes: {
    address: "0xcde4d35e341901bc0308c2ffc789448ccd0f238a59597fe702e6710484b9c370",
    name: "microduck / NVDA",
    pool_created_at: "2026-08-27T00:00:00Z",
    base_token_price_usd: "0.0031",
    reserve_in_usd: "246234.1974",
    fdv_usd: "3100000",
    volume_usd: { h24: "410000" },
    price_change_percentage: { h1: "1.5", h24: "22.4" },
    transactions: { h24: { buys: 900, sells: 700, buyers: 310, sellers: 280 } },
  },
  relationships: {
    base_token: { data: { id: "robinhood_0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725" } },
    dex: { data: { id: "pons-v2-dex" } },
  },
};

describe("parseGeckoPool", () => {
  it("reads a real trending pool", () => {
    const p = parseGeckoPool(CHUMP);
    assert.ok(p);
    assert.equal(p!.poolAddress, "0x714442e9a611f8561a7df108d6d925132937cfb8");
    assert.equal(p!.poolId, "0x714442e9a611f8561a7df108d6d925132937cfb8");
    // The BASE token is what you would buy; the pool address is not it, and
    // confusing the two would have the agent trading the pool contract.
    assert.equal(p!.tokenAddress, "0x0e0d2c89a5a019fe1cf762e5e33187631dacc21b");
    assert.equal(p!.name, "CHUMP / WETH 1%");
    assert.equal(p!.dex, "uniswap-v3-robinhood");
  });

  it("turns the API's strings into numbers, not NaN", () => {
    // Every figure below arrives quoted. A silent NaN here would propagate into
    // a comparison that is false against every limit, and the screen would drop
    // everything while looking like it was working.
    const p = parseGeckoPool(CHUMP)!;
    for (const [k, v] of Object.entries({
      priceUsd: p.priceUsd, reserveUsd: p.reserveUsd, fdvUsd: p.fdvUsd,
      volume24hUsd: p.volume24hUsd, change24hPct: p.change24hPct,
    })) assert.ok(typeof v === "number" && Number.isFinite(v), `${k} = ${v}`);
    assert.ok(Math.abs(p.reserveUsd! - 521_702.1056) < 0.001);
    assert.ok(Math.abs(p.priceUsd! - 0.0222452357304331) < 1e-12);
  });

  it("keeps a NEGATIVE change negative", () => {
    // "-2.926" losing its sign would read as a 3% gain — the wrong direction on
    // the one field a momentum decision turns on.
    const p = parseGeckoPool({ ...CHUMP, attributes: { ...CHUMP.attributes, price_change_percentage: { h1: "-2.926", h24: "-40.5" } } })!;
    assert.equal(p.change1hPct, -2.926);
    assert.equal(p.change24hPct, -40.5);
  });

  it("counts DISTINCT buyers, not transactions", () => {
    // 12,720 buys but only 1,592 buyers. Wash trading inflates the first
    // cheaply; the second is what the screen tests.
    const p = parseGeckoPool(CHUMP)!;
    assert.equal(p.buys24h, 12_720);
    assert.equal(p.buyers24h, 1_592);
    assert.notEqual(p.buyers24h, p.buys24h);
  });

  it("dates a pool that is weeks old, not just fresh launches", () => {
    // The whole point of this source: CHUMP launched 2026-07-31 and discovery
    // (which only watches pool creation) can never see it again.
    const p = parseGeckoPool(CHUMP)!;
    assert.equal(p.createdAt, Math.floor(Date.parse("2026-07-31T01:44:31Z") / 1000));
  });

  it("strips the chain prefix off the token id", () => {
    assert.equal(parseGeckoPool(CHUMP)!.tokenAddress, `0x${"0e0d2c89a5a019fe1cf762e5e33187631dacc21b"}`);
  });

  it("KEEPS a Pons pool identified by a 32-byte poolId", () => {
    // The bug this pins: requiring a 20-byte address dropped 9 of 20 trending
    // rows — every pons-v2-dex, uniswap-v4 and bankr pool, i.e. precisely the
    // venues this source was added to reach. The parser reported success the
    // whole time.
    const p = parseGeckoPool(MICRODUCK);
    assert.ok(p, "a v4-style pool is a pool");
    assert.equal(p!.dex, "pons-v2-dex");
    assert.equal(p!.reserveUsd, 246_234.1974);
  });

  it("does not hand out a poolId as if it were a callable address", () => {
    // A 32-byte poolId is a hash of a PoolKey, not a contract. Returning it as
    // `poolAddress` would push the failure to whoever eth_calls it later.
    const p = parseGeckoPool(MICRODUCK)!;
    assert.equal(p.poolAddress, null);
    assert.equal(p.poolId.length, 66);
    // The TOKEN is a real address either way — that is what gets traded.
    assert.equal(p.tokenAddress, "0xd5f1afea47b1a9eab414d2ee740cf1d6d039e725");
    assert.equal(p.tokenAddress.length, 42);
  });

  it("returns null when the pool cannot be IDENTIFIED", () => {
    // A row with no token address is a row about nothing. Better absent than
    // present with a zero address the rest of the code would treat as a token.
    const noRel = { ...CHUMP, relationships: {} };
    assert.equal(parseGeckoPool(noRel), null);
    assert.equal(parseGeckoPool({ ...CHUMP, attributes: { ...CHUMP.attributes, address: "nonsense" } }), null);
    assert.equal(parseGeckoPool(null), null);
    assert.equal(parseGeckoPool({}), null);
  });

  it("allows a MISSING figure to be null instead of dropping the pool", () => {
    // A brand-new curve legitimately has no 24h volume yet. That is a fact the
    // screen should weigh, not a parse failure.
    const fresh = { ...CHUMP, attributes: { ...CHUMP.attributes, volume_usd: {}, fdv_usd: null, price_change_percentage: {} } };
    const p = parseGeckoPool(fresh);
    assert.ok(p, "a pool with no history is still a pool");
    assert.equal(p!.volume24hUsd, null);
    assert.equal(p!.fdvUsd, null);
    assert.equal(p!.change24hPct, null);
    // Crucially null, NOT 0 — zero volume is a claim, absence is not.
    assert.notEqual(p!.volume24hUsd, 0);
  });
});

const pool = (over: Partial<GeckoPool> = {}): GeckoPool => ({
  ...parseGeckoPool(CHUMP)!,
  ...over,
});

describe("screenPools", () => {
  const LIMITS = { minReserveUsd: 25_000, minVolume24hUsd: 50_000, minBuyers24h: 100 };

  it("keeps a real, liquid, actively traded pool", () => {
    const { kept } = screenPools([pool()], LIMITS);
    assert.equal(kept.length, 1);
  });

  it("drops a pool for each limit, and says which", () => {
    const thin = pool({ name: "THIN", reserveUsd: 900 });
    const quiet = pool({ name: "QUIET", volume24hUsd: 12 });
    const lonely = pool({ name: "LONELY", buyers24h: 3 });
    const { kept, dropped } = screenPools([thin, quiet, lonely], LIMITS);
    assert.equal(kept.length, 0);
    assert.match(dropped.find((d) => d.name === "THIN")!.why, /depth/);
    assert.match(dropped.find((d) => d.name === "QUIET")!.why, /volume/);
    assert.match(dropped.find((d) => d.name === "LONELY")!.why, /buyers/);
  });

  it("REFUSES a pool whose figures are unknown", () => {
    // The failure that matters: absent evidence must not read as passing
    // evidence on a step whose whole job is to exclude. A null must never
    // compare as "fine".
    for (const missing of [{ reserveUsd: null }, { volume24hUsd: null }, { buyers24h: null }]) {
      const { kept, dropped } = screenPools([pool(missing as Partial<GeckoPool>)], LIMITS);
      assert.equal(kept.length, 0, `${JSON.stringify(missing)} should not survive`);
      assert.match(dropped[0]!.why, /unknown/);
    }
  });

  it("is a cheapness filter, not a safety one — it cannot approve anything", () => {
    // Everything it returns is still only a CANDIDATE. Nothing here has looked
    // at the chain, and nothing here may stand in for the wall.
    const { kept } = screenPools([pool({ name: "RUG", fdvUsd: 1e12, change24hPct: 9999 })], LIMITS);
    assert.equal(kept.length, 1, "an absurd token still passes a liquidity screen");
  });

  it("returns empty, not everything, on a quiet chain", () => {
    assert.deepEqual(screenPools([], LIMITS), { kept: [], dropped: [] });
  });
});
