import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import type { StockToken } from "../../../packages/core/src/index";
import { readCurvePrices, type CurveRef } from "./curve-prices";
import { CURVE_GUARD_DEFAULTS } from "./pons-price";

/**
 * Pricing a token that trades on a bonding curve.
 *
 * The thing under test is mostly REFUSAL. Most curves hold almost nothing and
 * roughly half are quoted in assets this repo cannot value at all, so the
 * common path is "no price, and here is why" — and the reason has to be the
 * true one, because it is what the owner reads.
 *
 * The one assertion that is really about safety is the source tag: a curve
 * quote must carry `source: "curve"`, because that single field is what keeps
 * the token inside the scout ceiling and out of the high-water mark. If this
 * module ever emitted "pool", both protections would vanish with nothing to
 * show for it.
 */

const NATIVE = `0x${"0".repeat(40)}` as const;
const THRESHOLD = 4_200_000_000_000_000_000n;
const SEED = (THRESHOLD * 4n) / 10n;
const ETH_USD8 = 244_016_000_000n;

const TOKEN: StockToken = {
  symbol: "PONSY",
  name: "PONSY",
  address: "0x00000000000000000000000000000000000000c1",
  chainlinkFeed: null,
  kind: "memecoin",
  decimals: 18,
};

const REF: CurveRef = {
  curve: "0x00000000000000000000000000000000000000e1",
  quoteToken: NATIVE,
  graduationThresholdRaw: THRESHOLD,
};

/** A client whose curve reports the given reserves. */
function clientAt(quoteRaw: bigint, tokenRaw?: bigint): PublicClient {
  const k = SEED * 10n ** 27n;
  const t = tokenRaw ?? k / quoteRaw;
  const word = (v: bigint) => v.toString(16).padStart(64, "0");
  return {
    async call() {
      return { data: `0x${word(quoteRaw)}${word(t)}` };
    },
  } as unknown as PublicClient;
}

/** quoteRaw for a curve that has really raised `f` of its threshold. */
const at = (f: number) => SEED + BigInt(Math.round(f * 4.2e18));

const deps = (over: Partial<Parameters<typeof readCurvePrices>[0]> = {}) => ({
  client: clientAt(at(0.05)),
  tokens: [TOKEN],
  curveOf: async () => REF,
  quoteUsd8Of: () => ETH_USD8,
  quoteDecimalsOf: () => 18,
  guard: CURVE_GUARD_DEFAULTS,
  ...over,
});

describe("readCurvePrices", () => {
  it("prices a curve with real money in it", async () => {
    const r = await readCurvePrices(deps());
    const q = r.quotes.get("PONSY");
    assert.ok(q, `expected a quote, refused: ${JSON.stringify(r.refused)}`);
    assert.ok(q!.price8 > 0n);
  });

  it("tags it `curve`, which is what keeps the safety rails on", async () => {
    // Not cosmetic. `source === "curve"` is read in two places that matter:
    // the scout ceiling keeps the token in lastUnpriceable, and the fee path
    // refuses to ratchet the high-water mark. Emitting "pool" here would turn
    // both off with no other code change.
    const q = (await readCurvePrices(deps())).quotes.get("PONSY")!;
    assert.equal(q.source, "curve");
  });

  it("carries depth in 6dp USDG, not the 8dp the curve maths uses", async () => {
    // depthUsd8 is the only 8dp depth in the worker. Under a 6dp field name it
    // would let a $250 curve clear a $25,000 floor.
    const q = (await readCurvePrices(deps())).quotes.get("PONSY")!;
    const usd = Number(q.liquidityUsdg!) / 1e6;
    // 5% of 4.2 ETH at $2,440 is about $512.
    assert.ok(usd > 400 && usd < 650, `expected ~$512, got $${usd.toFixed(0)}`);
  });

  it("never reports the virtual seed as depth", async () => {
    // A curve nobody has bought reports 1.68 ETH of reserve while holding
    // nothing. It must be refused for having no market, not priced at $4,099.
    const r = await readCurvePrices(deps({ client: clientAt(SEED) }));
    assert.equal(r.quotes.size, 0);
    assert.equal(r.refused[0]!.kind, "too-thin");
  });

  it("refuses a curve carrying too much overhang, however deep", async () => {
    // The inversion. A curve at 25% of threshold has MORE money in it than one
    // at 5% and is refused precisely because of that: 62% of its price is other
    // people's cost basis.
    const r = await readCurvePrices(deps({ client: clientAt(at(0.25)) }));
    assert.equal(r.quotes.size, 0);
    assert.equal(r.refused[0]!.kind, "overhang");
    assert.match(r.refused[0]!.reason, /other people/);
  });

  it("refuses a graduated curve by name, not as 'too thin'", async () => {
    // Token side drained means the market moved to a Uniswap v4 pool this repo
    // cannot read. Its reserves look identical to a curve nobody bought, so
    // without the explicit check the owner would be told the wrong thing.
    const r = await readCurvePrices(deps({ client: clientAt(SEED, 0n) }));
    assert.equal(r.refused[0]!.kind, "graduated");
    assert.match(r.refused[0]!.reason, /graduated/);
  });

  it("says plainly when it cannot price the quote asset", async () => {
    // 42.8% of launches are quoted in stock tokens and 2.3% in cbBTC. Null is
    // the honest answer and it must not become a zero price.
    const r = await readCurvePrices(deps({ quoteUsd8Of: () => null }));
    assert.equal(r.quotes.size, 0);
    assert.equal(r.refused[0]!.kind, "no-quote-price");
  });

  it("says when it does not know where a token trades, rather than scanning", async () => {
    // The launch log only reaches ~8.4 hours back, so a scan would succeed for
    // recent tokens and silently fail for older ones — trustworthy often
    // enough to be relied on and wrong often enough to matter.
    const r = await readCurvePrices(deps({ curveOf: async () => null }));
    assert.equal(r.refused[0]!.kind, "no-curve");
    assert.match(r.refused[0]!.reason, /not where it trades/);
  });

  it("survives a curve that does not answer", async () => {
    const dead = { async call() { throw new Error("reverted"); } } as unknown as PublicClient;
    const r = await readCurvePrices(deps({ client: dead }));
    assert.equal(r.quotes.size, 0);
    assert.equal(r.refused[0]!.kind, "no-curve");
  });

  it("is not marked stale — that flag means a Chainlink feed stopped", async () => {
    // Repurposing it would make dip-hunter skip the token outright and print
    // market-hours language about something that trades 24/7. Freshness is
    // handled by refusing, not by flagging a quote that was let through.
    assert.equal((await readCurvePrices(deps())).quotes.get("PONSY")!.stale, false);
  });
});
