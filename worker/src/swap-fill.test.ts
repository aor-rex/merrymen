/**
 * A LANDED RIALTO SWAP BOOKED NOTHING AT ALL.
 *
 * The Rialto arm is a full live swap path — real calldata, a real router,
 * a real receipt — and it set neither `fillPair` nor `liveFill`. So a buy
 * through it wrote no cost basis, leaving a later sell with nothing to be
 * measured against, and a sell through it recorded no realised P&L. Silently,
 * on a venue that otherwise worked.
 *
 * The leg logic is now one function both arms call. A second implementation of
 * "which side is the money" is how two venues drift, and the failure mode is
 * not a crash: it is a 10^12 error from feeding an 18-decimal token amount into
 * a 6-decimal cash field, which reads as a perfectly plausible number.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { swapFillLegs } from "./swap-fill";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const TSLA = "0x1111111111111111111111111111111111111111" as const;
const NVDA = "0x2222222222222222222222222222222222222222" as const;
const symbolOf = (t: `0x${string}`) =>
  t.toLowerCase() === TSLA ? "TSLA" : t.toLowerCase() === NVDA ? "NVDA" : undefined;

const call = (over: Partial<Parameters<typeof swapFillLegs>[0]> = {}) =>
  swapFillLegs({
    sellToken: USDG as `0x${string}`,
    buyToken: TSLA,
    sellAmountRaw: 100_000_000n, // 100 USDG, 6dp
    receivedRaw: 4n * 10n ** 18n, // 4 TSLA, 18dp
    quotedOutRaw: 4n * 10n ** 18n,
    usdg: USDG,
    symbolOf,
    ...over,
  });

describe("the cash leg and the asset leg are never crossed", () => {
  it("a BUY: USDG in is the cash, the token out is the quantity", () => {
    const legs = call();
    assert.ok(legs);
    assert.equal(legs!.liveFill.side, "buy");
    assert.equal(legs!.liveFill.symbol, "TSLA");
    assert.equal(legs!.liveFill.cashUsdg, 100_000_000n, "cash is the 6dp USDG side");
    assert.equal(legs!.liveFill.qtyRaw, 4n * 10n ** 18n, "quantity is the 18dp asset side");
    assert.equal(legs!.fillPair.symbol, "TSLA");
  });

  it("a SELL: the token in is the quantity, USDG out is the cash", () => {
    const legs = call({
      sellToken: TSLA,
      buyToken: USDG as `0x${string}`,
      sellAmountRaw: 4n * 10n ** 18n,
      receivedRaw: 88_000_000n,
      quotedOutRaw: 88_000_000n,
    });
    assert.ok(legs);
    assert.equal(legs!.liveFill.side, "sell");
    assert.equal(legs!.liveFill.qtyRaw, 4n * 10n ** 18n);
    assert.equal(legs!.liveFill.cashUsdg, 88_000_000n);
  });

  it("and the price is cash per unit, not the raw ratio", () => {
    // 100 USDG for 4 tokens = 25.00. Getting this backwards is the 10^12 error.
    assert.equal(call()!.liveFill.priceUsd, 25);
  });
});

describe("it books nothing rather than booking nonsense", () => {
  it("a stock→stock swap has no cash leg", () => {
    assert.equal(call({ sellToken: TSLA, buyToken: NVDA }), null);
  });

  it("USDG→USDG is not a trade either", () => {
    assert.equal(call({ sellToken: USDG as `0x${string}`, buyToken: USDG as `0x${string}` }), null);
  });

  it("an untracked token has no symbol to key a basis under", () => {
    // The basis is keyed by symbol; inventing one would attribute this fill to
    // another position.
    assert.equal(call({ buyToken: "0x9999999999999999999999999999999999999999" }), null);
  });

  it("a zero quantity books nothing", () => {
    assert.equal(call({ receivedRaw: 0n }), null);
  });

  it("and the cash token is matched case-insensitively", () => {
    assert.ok(call({ usdg: USDG.toLowerCase() }));
  });
});

describe("BOTH live swap arms use it — that is the point of extracting it", () => {
  const SRC = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("the Rialto arm now books its fill legs", () => {
    // The arm is identified by its own guard so this cannot drift onto another
    // branch that happens to mention the helper.
    const arm = SRC.slice(
      SRC.indexOf('} else if (intent.kind === "swap" && cfg.rialtoApiKey'),
      SRC.indexOf('} else if (intent.kind === "swap") {'),
    );
    assert.ok(arm.length > 0, "the Rialto arm must exist to be checked");
    assert.match(arm, /swapFillLegs\(\{/, "it must build the legs");
    assert.match(arm, /fillPair = legs\.fillPair;/);
    assert.match(arm, /liveFill = legs\.liveFill;/);
  });

  it("and there is exactly one implementation of the rule", () => {
    // Two copies of "which side is the money" is how the venues drift apart.
    const inline = SRC.match(/const sellIsUsdg = intent\.sellToken\.toLowerCase\(\) === usdgAddr;/g) ?? [];
    assert.ok(inline.length <= 1, `found ${inline.length} inline copies of the leg rule`);
  });
});
