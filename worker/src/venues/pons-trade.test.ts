import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData } from "viem";
import { PONS_SELFTRADE_ABI } from "../../../packages/core/src/index";
import { buildCurveTradeCalls } from "./pons-trade";

/**
 * The two calls a curve trade is: approve the adapter, then trade.
 *
 * What matters here is the SHAPE the wall will see. The permission pins the
 * adapter as target and both asset legs ONE_OF the owner's list, at flat word
 * offsets — so calldata that puts an argument in the wrong place, or a value
 * that wraps on the way into a uint128, produces a UserOp the chain refuses or
 * a floor that silently stops protecting anything.
 */

const ADAPTER = "0x00000000000000000000000000000000000000d5" as const;
const CURVE = "0x00000000000000000000000000000000000000cc" as const;
const USDG = "0x00000000000000000000000000000000000000aa" as const;
const MEME = "0x00000000000000000000000000000000000000bb" as const;

const trade = (over: Partial<Parameters<typeof buildCurveTradeCalls>[0]> = {}) =>
  buildCurveTradeCalls({
    adapter: ADAPTER,
    curve: CURVE,
    assetIn: USDG,
    assetOut: MEME,
    amountInRaw: 5_000_000n,
    minAmountOutRaw: 1_000n,
    deadline: 1_800_000_000n,
    ...over,
  });

describe("buildCurveTradeCalls", () => {
  it("approves the ADAPTER, then calls it — in that order", () => {
    const calls = trade();
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.to, USDG, "the approve goes to the asset being spent");
    assert.equal(calls[1]!.to, ADAPTER, "the trade goes to the adapter, never the curve");
  });

  it("approves EXACTLY the trade size, not the maximum", () => {
    // An unlimited approval would be a standing licence bounded only by the
    // adapter's own correctness. A per-trade one is bounded by the trade.
    const [approve] = trade();
    const decoded = decodeFunctionData({
      abi: [
        {
          type: "function",
          name: "approve",
          stateMutability: "nonpayable",
          inputs: [
            { name: "spender", type: "address" },
            { name: "amount", type: "uint256" },
          ],
          outputs: [{ name: "", type: "bool" }],
        },
      ] as const,
      data: approve!.data,
    });
    // viem decodes addresses checksummed; the wall compares lowercased.
    assert.equal(String((decoded.args as readonly unknown[])[0]).toLowerCase(), ADAPTER);
    assert.equal((decoded.args as readonly unknown[])[1], 5_000_000n);
    assert.notEqual((decoded.args as readonly unknown[])[1], 2n ** 256n - 1n);
  });

  it("puts every argument in the word the wall pins", () => {
    // Decoded against the shared ABI rather than eyeballed. The policy maps
    // args[i] to word i with no arity check, so a reordering here would be
    // constrained by rules built for different values and nothing would say so.
    const decoded = decodeFunctionData({ abi: PONS_SELFTRADE_ABI, data: trade()[1]!.data });
    assert.equal(decoded.functionName, "tradeExactIn");
    const args = (decoded.args as readonly unknown[]).map((a) => (typeof a === "string" ? a.toLowerCase() : a));
    assert.deepEqual(args, [CURVE, USDG, MEME, 5_000_000n, 1_000n, 1_800_000_000n]);
  });

  it("sends NO native value, which is what keeps valueLimit at zero", () => {
    for (const c of trade()) assert.equal(c.value, 0n);
  });

  it("refuses a minAmountOut that would WRAP into a smaller floor", () => {
    // The dangerous direction. A wrapped uint128 becomes a smaller minimum, so
    // the trade still executes and simply has no slippage protection — a guard
    // that reads in the tape as having passed.
    assert.throws(() => trade({ minAmountOutRaw: 2n ** 128n }), /minAmountOut does not fit uint128/);
    assert.throws(() => trade({ amountInRaw: 2n ** 128n }), /amountIn does not fit uint128/);
  });

  it("refuses a zero size and a same-asset trade", () => {
    assert.throws(() => trade({ amountInRaw: 0n }), /must be positive/);
    assert.throws(() => trade({ assetOut: USDG }), /the same/);
  });

  it("builds a SELL the same way — direction is the curve's to derive", () => {
    // No side argument anywhere. The adapter reads token()/pairToken() and
    // works it out, so a caller cannot hand it a direction that disagrees with
    // the venue.
    const decoded = decodeFunctionData({
      abi: PONS_SELFTRADE_ABI,
      data: trade({ assetIn: MEME, assetOut: USDG })[1]!.data,
    });
    const legs = (decoded.args as readonly unknown[]).slice(1, 3).map((a) => String(a).toLowerCase());
    assert.deepEqual(legs, [MEME, USDG]);
  });
});
