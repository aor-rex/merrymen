/**
 * The round trip that could not book P&L.
 *
 * A live buy booked its quantity from `minOut` — the slippage FLOOR — while
 * paying the full cash amount. The comment defending it was right that a fill
 * can come in worse than quoted but never better, so the bound is conservative
 * on PRICE. The consequence it missed: the tracked quantity ends up about
 * slippageBps BELOW the balance actually sitting on-chain.
 *
 * Every full exit sells `held.rawBalance`, the real balance. That exceeds the
 * tracked basis, so applyFill flags partlyUnbacked, returns zero realized, and
 * the row is written with realized_pnl_usdg NULL — excluded from every sum.
 * So a live round trip could not produce a realized figure AT ALL, and the
 * warning blamed a position that "predates basis tracking".
 *
 * These tests run the two booking strategies through the REAL basis engine and
 * show the difference, so the fix cannot be quietly reverted.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyFill, ZERO_BASIS } from "./basis";
import { fillFromDeltas, netTokenDeltas, type ReceiptLog } from "./fills";
import { minOutWithSlippage } from "./venues/uniswap";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ME = "0x00000000000000000000000000000000000000a1";
const ROUTER = "0x00000000000000000000000000000000000000b2";
const USDG = "0x0000000000000000000000000000000000000dd0";
const NVDA = "0x0000000000000000000000000000000000000ee0";

const topic = (a: string) => `0x${"0".repeat(24)}${a.slice(2)}`;
const hex = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
const transfer = (token: string, from: string, to: string, value: bigint): ReceiptLog => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)],
  data: hex(value),
});

const ONE = 10n ** 18n;
const usdg = (v: number) => BigInt(Math.round(v * 1e6));

// One realistic buy: 50 USDG in, a quote of 0.25 NVDA, and a fill that lands
// slightly better than the 1% floor — which is the normal case.
const SPEND = usdg(50);
const QUOTED_OUT = ONE / 4n;
const RECEIVED = (QUOTED_OUT * 9_985n) / 10_000n; // 0.15% worse than quoted
const MIN_OUT = minOutWithSlippage(QUOTED_OUT, 100); // the old booked quantity

const buyReceipt = [transfer(USDG, ME, ROUTER, SPEND), transfer(NVDA, ROUTER, ME, RECEIVED)];

describe("booking a buy from the quote vs from the receipt", () => {
  it("minOut under-records the position — the tracked quantity is below the real balance", () => {
    assert.ok(MIN_OUT < RECEIVED, "the slippage floor is below what actually arrived");
    const shortfall = RECEIVED - MIN_OUT;
    assert.ok(shortfall > 0n);
  });

  it("THE BUG: a full exit against a minOut-derived basis books NO realized P&L", () => {
    // Buy, booked the old way.
    const afterBuy = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: MIN_OUT, cashUsdg: SPEND });
    // Sell the whole on-chain balance, which is what every full-exit path does.
    const exit = applyFill(afterBuy.basis, { side: "sell", qtyRaw: RECEIVED, cashUsdg: usdg(60) });

    assert.equal(exit.basisUnknown, true);
    assert.equal(exit.realizedUsdg, 0n); // a 10 USDG gain, recorded as nothing
  });

  it("THE FIX: booking the received quantity makes the same exit fully backed", () => {
    const deltas = netTokenDeltas(buyReceipt, ME);
    const measured = fillFromDeltas({ deltas, usdgToken: USDG, stockToken: NVDA, symbol: "NVDA" })!;
    assert.equal(measured.qtyRaw, RECEIVED);

    const afterBuy = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: measured.qtyRaw, cashUsdg: measured.cashUsdg });
    const exit = applyFill(afterBuy.basis, { side: "sell", qtyRaw: RECEIVED, cashUsdg: usdg(60) });

    assert.equal(exit.basisUnknown, false);
    assert.equal(exit.realizedUsdg, usdg(10)); // sold for 60, cost 50
    assert.equal(exit.basis.qtyRaw, 0n); // flat, no stranded residue
    assert.equal(exit.basis.costUsdg, 0n);
  });

  it("a genuinely unbacked sell is STILL refused — the fix must not paper over that", () => {
    // Selling something never bought has no cost to attribute, and booking the
    // proceeds as profit is the failure basis.ts exists to prevent.
    const exit = applyFill(ZERO_BASIS, { side: "sell", qtyRaw: ONE, cashUsdg: usdg(888) });
    assert.equal(exit.basisUnknown, true);
    assert.equal(exit.realizedUsdg, 0n);
  });

  it("a partial exit books the weighted-average cost of the part sold", () => {
    const deltas = netTokenDeltas(buyReceipt, ME);
    const measured = fillFromDeltas({ deltas, usdgToken: USDG, stockToken: NVDA, symbol: "NVDA" })!;
    const afterBuy = applyFill(ZERO_BASIS, { side: "buy", qtyRaw: measured.qtyRaw, cashUsdg: measured.cashUsdg });

    const half = measured.qtyRaw / 2n;
    const exit = applyFill(afterBuy.basis, { side: "sell", qtyRaw: half, cashUsdg: usdg(30) });
    assert.equal(exit.basisUnknown, false);
    // Half the position cost ~25, sold for 30.
    assert.ok(exit.realizedUsdg > usdg(4.99) && exit.realizedUsdg < usdg(5.01), `realized ${exit.realizedUsdg}`);
  });
});
