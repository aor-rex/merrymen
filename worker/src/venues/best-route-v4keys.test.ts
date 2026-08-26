/**
 * Discovered PoolKeys reach the quoter — driven through the real bestRoute with
 * a stubbed client, because this is the seam where hooked pools either become
 * routable or silently stay invisible.
 *
 * quoteV4 was always hooks-agnostic; nothing ever FED it a hooked key. These
 * tests pin the feeding, the reverse-probe gate on hooked entries, and that a
 * closed v4 gate keeps discovered keys inert.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PublicClient } from "viem";
import { bestRoute } from "./uniswap";
import { NO_HOOKS, type PoolKey } from "./uniswap-v4";

const USDG = "0x00000000000000000000000000000000000000aa" as const;
const MEME = "0x00000000000000000000000000000000000000bb" as const;
const HOOK = "0x00000000000000000000000000000000000000f1" as const;
const HOOKED: PoolKey = { currency0: USDG, currency1: MEME, fee: 8388608, tickSpacing: 200, hooks: HOOK };
const VANILLA: PoolKey = { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: NO_HOOKS };

/**
 * A client whose simulateContract answers only the v4 quoter, per pool key —
 * everything else (the v3 quoter, slot0 scans) "has no pool" (throws), which
 * is exactly how a memecoin with no v3 pool presents.
 */
function stubClient(quotes: (args: { hooks: string; tokenIn: string; amountIn: bigint }) => bigint | null): PublicClient {
  return {
    simulateContract: async (call: {
      functionName: string;
      args: readonly unknown[];
    }): Promise<{ result: unknown }> => {
      if (call.functionName === "quoteExactInputSingle" && Array.isArray(call.args) && (call.args[0] as { poolKey?: unknown })?.poolKey) {
        const p = call.args[0] as {
          poolKey: PoolKey;
          zeroForOne: boolean;
          exactAmount: bigint;
        };
        const tokenIn = p.zeroForOne ? p.poolKey.currency0 : p.poolKey.currency1;
        const out = quotes({ hooks: p.poolKey.hooks.toLowerCase(), tokenIn: tokenIn.toLowerCase(), amountIn: p.exactAmount });
        if (out === null) throw new Error("no pool");
        return { result: [out, 21_000n] };
      }
      throw new Error("no pool"); // v3 quoter, slot0 scans: nothing exists
    },
    readContract: async () => {
      throw new Error("no pool"); // findV4Pool's slot0 reads: no vanilla pool
    },
    multicall: async () => {
      throw new Error("no pool");
    },
  } as unknown as PublicClient;
}

let calls = 0;

describe("bestRoute with discovered v4 keys", () => {
  it("a discovered HOOKED key becomes a route — the thing that was structurally impossible", async () => {
    const q = await bestRoute(stubClient(({ hooks }) => (hooks === HOOK ? 990n : null)), {
      tokenIn: USDG,
      tokenOut: MEME,
      amountIn: 1000n,
      v4: true,
      v4Keys: [HOOKED],
    });
    assert.ok(q, "the hooked pool quoted");
    assert.equal(q!.amountOut, 990n);
    assert.equal(q!.v4?.key.hooks, HOOK, "and the route carries the hook, so execution targets the right pool");
  });

  it("a hooked pool that will not quote the way OUT is not entered", async () => {
    // The no-exit trap one level below the wall: the sell PERMISSION exists,
    // the pool just refuses to fill it. Forward quotes fine; reverse is null.
    const q = await bestRoute(
      stubClient(({ hooks, tokenIn }) => (hooks === HOOK && tokenIn === USDG.toLowerCase() ? 990n : null)),
      { tokenIn: USDG, tokenOut: MEME, amountIn: 1000n, v4: true, v4Keys: [HOOKED] },
    );
    assert.equal(q, null, "no exit quote, no entry");
  });

  it("a VANILLA discovered key needs no reverse probe — the trap is hook behaviour", async () => {
    let reverseAsked = false;
    const q = await bestRoute(
      stubClient(({ hooks, tokenIn }) => {
        if (tokenIn === MEME.toLowerCase()) reverseAsked = true;
        return hooks === NO_HOOKS ? 990n : null;
      }),
      { tokenIn: USDG, tokenOut: MEME, amountIn: 1000n, v4: true, v4Keys: [VANILLA] },
    );
    assert.ok(q);
    assert.equal(reverseAsked, false, "hookless pools cannot pick a direction — probing them is waste");
  });

  it("with the v4 gate CLOSED, discovered keys are inert", async () => {
    let quoterTouched = false;
    const q = await bestRoute(
      stubClient(() => {
        quoterTouched = true;
        return 990n;
      }),
      { tokenIn: USDG, tokenOut: MEME, amountIn: 1000n, v4: false, v4Keys: [HOOKED] },
    );
    assert.equal(q, null);
    assert.equal(quoterTouched, false, "a key the grant cannot execute is never even quoted");
  });

  it("the best amountOut wins across discovered keys, exactly like every other candidate", async () => {
    const BETTER: PoolKey = { ...HOOKED, fee: 500, tickSpacing: 10 };
    const q = await bestRoute(
      stubClient(({ hooks, tokenIn, amountIn }) => {
        if (hooks !== HOOK) return null;
        // fee is not visible to the stub, so discriminate by direction/size:
        // the reverse probes get a flat pass, the forward quotes differ by key
        // via closure state below.
        return tokenIn === USDG.toLowerCase() ? (calls++ === 0 ? 990n : 1010n) : amountIn;
      }),
      { tokenIn: USDG, tokenOut: MEME, amountIn: 1000n, v4: true, v4Keys: [HOOKED, BETTER] },
    );
    assert.ok(q);
    assert.equal(q!.amountOut, 1010n, "the better fill won");
  });
});

