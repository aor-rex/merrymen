/**
 * Building the calls for a bonding-curve trade.
 *
 * A SIBLING OF buildTradeCalls, NOT A BRANCH INSIDE IT, and the reason is worth
 * stating because "just add a case" was the obvious alternative.
 *
 * `buildTradeCalls` dispatches on a `Quote` — fee tier, v3 path, v4 PoolKey —
 * so that the priced route is the executed route, and `requoteRoute` mirrors
 * that dispatch to keep the impact probe on the same route. A bonding curve has
 * none of those fields. Bolting a `curve?` branch onto `Quote` would force
 * `requoteRoute`, `pickBestQuote`, `bestRoute`'s fan-out and the `sim_fee_tier`
 * ledger column to each carry a meaningless fee, and would put a venue with a
 * completely different price function inside a comparator built for AMM pools.
 *
 * It also returns executor's `Call`, whose `value` is a plain `bigint`, rather
 * than the Uniswap layer's identically-named `Call` whose `value` is the
 * literal `0n`. That literal is load-bearing documentation — it is what lets
 * V4SelfSwap's permission carry `valueLimit: 0` — and widening it to serve this
 * venue would delete a compile-time guarantee from an unrelated path. (Two
 * same-named types one import apart is already a trap; this file imports the
 * executor one deliberately, and today always emits `value: 0n` anyway, because
 * the adapter is non-payable.)
 */
import { encodeFunctionData } from "viem";
import { PONS_SELFTRADE_ABI } from "../../../packages/core/src/index";
import type { Call } from "../executor";

export interface CurveTrade {
  /** The PonsSelfTrade adapter — what the wall pinned and what gets called. */
  adapter: `0x${string}`;
  /** The bonding curve. An argument; the wall cannot pin it. */
  curve: `0x${string}`;
  assetIn: `0x${string}`;
  assetOut: `0x${string}`;
  amountInRaw: bigint;
  /** Slippage floor in assetOut's units, enforced on-chain by the adapter. */
  minAmountOutRaw: bigint;
  /** Unix seconds. */
  deadline: bigint;
}

/**
 * TWO CALLS: approve the adapter, then trade.
 *
 * The approve is not optional and not a convenience. The adapter pulls
 * `assetIn` with a plain `transferFrom`, so without a standing allowance the
 * trade reverts — and the wall grants the approve permission over exactly the
 * asset set the trade permission pins, so the two either both apply or neither
 * does.
 *
 * APPROVED FOR EXACTLY `amountInRaw`, not for the maximum. An unlimited
 * approval to the adapter would be a standing licence bounded only by the
 * adapter's own correctness; a per-trade one is bounded by the trade. The
 * adapter zeroes its own allowance to the curve for the same reason, one layer
 * down.
 */
export function buildCurveTradeCalls(t: CurveTrade): Call[] {
  if (t.amountInRaw <= 0n) throw new Error("curve trade: amountInRaw must be positive");
  if (t.assetIn.toLowerCase() === t.assetOut.toLowerCase()) {
    throw new Error("curve trade: assetIn and assetOut are the same");
  }
  return [
    {
      to: t.assetIn,
      value: 0n,
      data: encodeFunctionData({
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
        functionName: "approve",
        args: [t.adapter, t.amountInRaw],
      }),
    },
    {
      to: t.adapter,
      // Zero, and that is the whole reason native-quoted curves are out of
      // reach: the adapter is non-payable so the wall's permission keeps
      // `valueLimit: 0n`, and the account never sends native value.
      value: 0n,
      data: encodeFunctionData({
        abi: PONS_SELFTRADE_ABI,
        functionName: "tradeExactIn",
        args: [
          t.curve,
          t.assetIn,
          t.assetOut,
          // uint128 in the ABI. A size that does not fit is a size no curve on
          // this launchpad could absorb anyway, but it must fail HERE rather
          // than by silently wrapping inside the encoder.
          checked128(t.amountInRaw, "amountIn"),
          checked128(t.minAmountOutRaw, "minAmountOut"),
          t.deadline,
        ],
      }),
    },
  ];
}

/**
 * Refuse a value that does not fit the ABI's uint128, rather than letting it
 * wrap into a different number that encodes cleanly.
 *
 * The dangerous direction is `minAmountOut`: a wrapped one becomes a SMALLER
 * floor, so the trade would still execute and would simply have no slippage
 * protection — the failure mode this repo has already been burned by, where a
 * guard reads in the tape as having passed.
 */
function checked128(v: bigint, what: string): bigint {
  if (v < 0n || v > 2n ** 128n - 1n) throw new Error(`curve trade: ${what} does not fit uint128`);
  return v;
}
