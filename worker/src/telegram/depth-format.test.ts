import assert from "node:assert/strict";
import test from "node:test";
import { parseSlash } from "./interpreter";
import { formatDepth, formatNoDepth, money, price8 } from "./depth-format";
import { deriveZones, getSqrtRatioAtTick, type DepthLevel, type PoolDepth } from "../venues/depth";

test("/depth parses a ticker, and its aliases land on the same command", () => {
  assert.deepEqual(parseSlash("/depth NVDA"), { kind: "depth", symbol: "NVDA" });
  assert.deepEqual(parseSlash("/depth nvda"), { kind: "depth", symbol: "NVDA" }, "case is normalised");
  assert.deepEqual(parseSlash("/liquidity SPY"), { kind: "depth", symbol: "SPY" });
  assert.deepEqual(parseSlash("/levels QQQ"), { kind: "depth", symbol: "QQQ" });
  assert.deepEqual(parseSlash("/depth@MyBot TSLA"), { kind: "depth", symbol: "TSLA" }, "group suffix stripped");
});

test("/depth with no ticker asks for one instead of guessing", () => {
  const parsed = parseSlash("/depth");
  assert.equal(parsed?.kind, "unknown");
  assert.match((parsed as { text: string }).text, /usage/);
});

test("/depth does not accept an address or junk as a ticker", () => {
  // The symbol is interpolated into a URL for the NBBO cross-check, so the
  // parser is the place that keeps it to a plain ticker.
  for (const bad of ["/depth 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "/depth ../../etc", "/depth TOOLONGSYM"]) {
    assert.equal(parseSlash(bad)?.kind, "unknown", `${bad} must not parse as a ticker`);
  }
});

test("money and price8 stay readable at chat width", () => {
  assert.equal(money(507_000), "$507k");
  assert.equal(money(1_240_000), "$1.2m");
  assert.equal(money(93), "$93");
  assert.equal(price8(21_722_000_000n), "$217.22");
  assert.equal(price8(150_000_000n), "$1.500");
});

function fixture(over: Partial<PoolDepth> = {}): PoolDepth {
  const levels: DepthLevel[] = [
    { tickLower: -600, tickUpper: -100, priceLower8: 20_750_000_000n, priceUpper8: 21_722_000_000n, liquidity: 1n, cashRaw: 506_579_000_000n, side: "bid" },
    { tickLower: -2000, tickUpper: -1500, priceLower8: 19_367_000_000n, priceUpper8: 19_503_000_000n, liquidity: 1n, cashRaw: 32_283_000_000n, side: "bid" },
    { tickLower: 100, tickUpper: 900, priceLower8: 21_722_000_000n, priceUpper8: 22_659_000_000n, liquidity: 1n, cashRaw: 408_826_000_000n, side: "ask" },
  ];
  const spot8 = 21_722_000_000n;
  return {
    pool: "0x00000000000000000000000000000000000000aa",
    tick: 222_512,
    sqrtPriceX96: getSqrtRatioAtTick(0),
    spot8,
    tickSpacing: 10,
    bandBps: 2000,
    levels,
    zones: deriveZones(levels, spot8),
    bidCashRaw: 538_862_000_000n,
    askCashRaw: 408_826_000_000n,
    truncated: false,
    cashDecimals: 6,
    ...over,
  };
}

test("the depth read names the pool price, the cross-check, and the tradable size", () => {
  const out = formatDepth({ symbol: "NVDA", depth: fixture(), nbboMid: 217.09, fee: 500 });
  assert.match(out, /<b>NVDA<\/b>/);
  assert.match(out, /\$217\.22/, "pool spot is shown");
  assert.match(out, /\$217\.09/, "the independent quote is shown next to it");
  assert.match(out, /\+6\.0bps/, "and the gap between them, signed");
  assert.match(out, /Trade without moving it more than 0\.5%/);
  assert.match(out, /0\.05% tier/, "the fee tier, so it can be checked on the explorer");
});

test("the read never claims resting orders or stacked buyers", () => {
  const out = formatDepth({ symbol: "NVDA", depth: fixture(), nbboMid: 217.09 });
  // THE WHOLE POINT OF THIS TEST. A v3 range is a two-sided quote whose owner
  // can withdraw in a block — it is not somebody's bid. Copy that says otherwise
  // would be describing a market that does not exist on this chain, and the
  // feature this mirrors is precisely the one people will assume it is.
  // Check the BODY only: the closing disclaimer legitimately contains these
  // phrases in the negative ("posted liquidity, not resting orders"), and a
  // blunt whole-string match would forbid the very sentence doing the work.
  const body = out.split("<i>Read live")[0] ?? out;
  for (const forbidden of [/order book/i, /buyers are stacked/i, /resting order/i, /bids? and asks? stacked/i]) {
    assert.equal(forbidden.test(body), false, `must not claim: ${forbidden}`);
  }
  assert.match(out, /posted liquidity, not resting orders/, "and it says so explicitly");
  assert.match(out, /pull it in a block/, "including that it can vanish");
  assert.match(out, /one pool/, "and that the router may fill elsewhere");
});

test("a truncated map is never presented as a complete one", () => {
  const out = formatDepth({ symbol: "NVDA", depth: fixture({ truncated: true }) });
  assert.match(out, /floors, not totals/);
  assert.equal(/floors, not totals/.test(formatDepth({ symbol: "NVDA", depth: fixture() })), false, "and only then");
});

test("a missing cross-check quote is simply absent, never rendered as NaN or zero", () => {
  for (const mid of [null, undefined, Number.NaN, 0]) {
    const out = formatDepth({ symbol: "NVDA", depth: fixture(), nbboMid: mid as number | null });
    assert.equal(/NaN/.test(out), false, `nbboMid=${String(mid)} must not print NaN`);
    assert.equal(/Robinhood/.test(out), false, "the line is dropped entirely rather than shown empty");
    assert.match(out, /\$217\.22/, "the on-chain map still stands on its own");
  }
});

test("a flat pool says so rather than inventing zones", () => {
  const out = formatDepth({ symbol: "XYZ", depth: fixture({ levels: [], zones: [] }) });
  assert.match(out, /flat across the band/);
});

test("formatNoDepth explains why rather than just failing", () => {
  const out = formatNoDepth("WEIRD");
  assert.match(out, /<b>WEIRD<\/b>/);
  assert.match(out, /too little to say anything honest/);
});
