import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gasCostUsdg, priceGas, wethPriceToken } from "./gas-price";

const usd8 = (v: number) => BigInt(Math.round(v * 1e8));
const usdg = (v: number) => BigInt(Math.round(v * 1e6));

describe("gasCostUsdg", () => {
  it("converts a real gas figure at a real ETH price", () => {
    // The measured cost floor: 2 × 270,126 gas at 26.094 Mwei ≈ 0.0000141 ETH,
    // which at $2,446 is ~$0.0345 — the 6.9 bps of a 50 USDG round trip.
    const gasWei = 2n * 270_126n * 26_094_000n;
    const cost = gasCostUsdg(gasWei, usd8(2446));
    assert.ok(cost > usdg(0.034) && cost < usdg(0.035), `got ${cost}`);
  });

  it("scales linearly with the ETH price", () => {
    const gasWei = 10n ** 15n; // 0.001 ETH
    assert.equal(gasCostUsdg(gasWei, usd8(2000)), usdg(2));
    assert.equal(gasCostUsdg(gasWei, usd8(4000)), usdg(4));
  });

  it("truncates rather than rounding up — a cost is never overstated by the maths", () => {
    // 1 wei at $2,446 is far below a millionth of a USDG.
    assert.equal(gasCostUsdg(1n, usd8(2446)), 0n);
  });

  it("is zero for zero gas, and for a nonsense price", () => {
    assert.equal(gasCostUsdg(0n, usd8(2446)), 0n);
    assert.equal(gasCostUsdg(10n ** 15n, 0n), 0n);
    assert.equal(gasCostUsdg(10n ** 15n, -1n), 0n);
  });
});

describe("priceGas — unpriced is not free", () => {
  it("prices gas when a price is available", () => {
    const g = priceGas(10n ** 15n, usd8(2000));
    assert.equal(g.usdg, usdg(2));
    assert.equal(g.reason, undefined);
  });

  it("returns NULL, not zero, when the price was refused", () => {
    // Zero would silently improve reported P&L by the whole gas bill, which is
    // exactly the kind of quiet flattery this work exists to remove.
    const g = priceGas(10n ** 15n, null, "pool too thin to trust");
    assert.equal(g.usdg, null);
    assert.equal(g.gasWei, 10n ** 15n);
    assert.match(g.reason!, /pool too thin/);
  });

  it("carries a default reason rather than an empty one", () => {
    assert.match(priceGas(1n, null).reason!, /unpriced, not free/);
  });
});

describe("wethPriceToken", () => {
  it("has no feed and must route directly against USDG", () => {
    const t = wethPriceToken("0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73");
    assert.equal(t.chainlinkFeed, null);
    assert.equal(t.decimals, 18);
    // Quoting WETH via WETH would be circular.
    assert.equal(t.quote, "usdg");
  });
});
