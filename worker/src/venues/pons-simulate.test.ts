import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import { encodeFunctionResult } from "viem";
import { PONS_SELFTRADE_ABI } from "../../../packages/core/src/index";
import { SIM_ADAPTER_ADDRESS, simulateCurveTrade, simulatedCostBps } from "./pons-simulate";

/**
 * Replaying a curve trade against the real chain for nothing.
 *
 * The technique is PROVEN against mainnet, not assumed: the exact two calls
 * buildCurveTradeCalls emits, with the adapter's compiled runtime bytecode
 * injected at an undeployed address, ran successfully against a live Pons curve
 * on chain 4663 — both calls status 0x1, amountOut 4277987318627066627635, gas
 * 210,723. What is tested here is the half that is ours: that a refusal is
 * reported as a refusal rather than thrown, and that a revert keeps its selector
 * so a caller can tell WHICH refusal it was.
 */

const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const calls = [
  { to: "0x00000000000000000000000000000000000000aa" as const, value: 0n, data: "0xabcd" as const },
  { to: SIM_ADAPTER_ADDRESS, value: 0n, data: "0x1234" as const },
];

const clientReturning = (blocks: unknown): PublicClient =>
  ({ async request() { return blocks; } }) as unknown as PublicClient;

const okOut = (n: bigint) =>
  encodeFunctionResult({ abi: PONS_SELFTRADE_ABI, functionName: "tradeExactIn", result: n });

describe("simulateCurveTrade", () => {
  it("returns the amount the curve would really pay", async () => {
    const res = await simulateCurveTrade({
      client: clientReturning([
        { calls: [{ status: "0x1", returnData: "0x", gasUsed: "0x1" }, { status: "0x1", returnData: okOut(4_277n), gasUsed: "0x3374b" }] },
      ]),
      account: ACCOUNT,
      calls,
    });
    assert.equal(res.ok, true);
    assert.equal((res as { amountOut: bigint }).amountOut, 4_277n);
    assert.equal((res as { gasUsed: bigint }).gasUsed, 210_763n);
  });

  it("reports a reverted trade WITH its selector, not just 'it failed'", async () => {
    // The adapter's errors are named — CurveGraduated, NativeQuoteNotSupported,
    // InsufficientOutput — so the selector is the difference between "this
    // curve has moved to Uniswap" and "not enough came back". Losing it would
    // make every refusal look the same.
    const res = await simulateCurveTrade({
      client: clientReturning([
        { calls: [{ status: "0x1", returnData: "0x", gasUsed: "0x1" }, { status: "0x0", returnData: "0x025ac17e", gasUsed: "0x1" }] },
      ]),
      account: ACCOUNT,
      calls,
    });
    assert.equal(res.ok, false);
    assert.match((res as { reason: string }).reason, /0x025ac17e/);
  });

  it("names the APPROVE when that is what failed", async () => {
    const res = await simulateCurveTrade({
      client: clientReturning([{ calls: [{ status: "0x0", returnData: "0x", gasUsed: "0x1" }, { status: "0x0", returnData: "0x", gasUsed: "0x1" }] }]),
      account: ACCOUNT,
      calls,
    });
    assert.match((res as { reason: string }).reason, /approve/);
  });

  it("REFUSES rather than throwing when the node cannot simulate", async () => {
    // A node without eth_simulateV1 lands here. The probe is an improvement on
    // a fabricated fill, never a dependency of the tick — it must degrade to a
    // refusal, not take a trading loop down.
    const dead = { async request() { throw new Error("method not found"); } } as unknown as PublicClient;
    const res = await simulateCurveTrade({ client: dead, account: ACCOUNT, calls });
    assert.equal(res.ok, false);
    assert.match((res as { reason: string }).reason, /method not found/);
  });

  it("refuses a call list that is not an approve plus a trade", async () => {
    const res = await simulateCurveTrade({ client: clientReturning([]), account: ACCOUNT, calls: [calls[0]!] });
    assert.match((res as { reason: string }).reason, /got 1 calls/);
  });

  it("refuses a response shape it does not understand", async () => {
    for (const junk of [null, [], [{ calls: [] }], [{}]]) {
      const res = await simulateCurveTrade({ client: clientReturning(junk), account: ACCOUNT, calls });
      assert.equal(res.ok, false, `${JSON.stringify(junk)} should not read as success`);
    }
  });
});

describe("simulatedCostBps", () => {
  it("measures what a trade really cost against a frictionless one", () => {
    assert.equal(simulatedCostBps({ amountOut: 9_900n, frictionlessOut: 10_000n }), 100);
  });

  it("refuses to divide by a baseline it does not have", () => {
    // A stale or absent baseline produces a number that looks like a fee and is
    // not one. Measured this the wrong way once already: comparing a simulated
    // fill against reserves read at an EARLIER block gave -33 bps, i.e. better
    // than frictionless, which is impossible and was purely block skew.
    assert.equal(simulatedCostBps({ amountOut: 100n, frictionlessOut: 0n }), null);
    assert.equal(simulatedCostBps({ amountOut: -1n, frictionlessOut: 10n }), null);
  });
});
