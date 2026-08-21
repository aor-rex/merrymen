import assert from "node:assert/strict";
import test from "node:test";
import type { Snapshot } from "../strategies/types";
import type { TokenDepth } from "../venues/depth-cache";
import type { ProposalDriver, Signals } from "./driver";
import { makeLlmStrategist } from "./strategy";
import type { StrategistUniverse } from "./proposals";

const USDG = "0x0000000000000000000000000000000000000009" as const;

function universe(symbols: string[]): StrategistUniverse {
  return {
    legs: new Map(
      symbols.map((s) => [
        s,
        { symbol: s, address: `0x${s.toLowerCase().padEnd(40, "0")}` as `0x${string}`, decimals: 18 },
      ]),
    ),
    usdg: USDG,
    maxPerActionUsdg: 50_000_000n,
    maxActionsPerTick: 4,
  } as unknown as StrategistUniverse;
}

function depthOf(symbol: string, over: Partial<TokenDepth> = {}): TokenDepth {
  return {
    symbol,
    buyUsdg: 1234.5678,
    sellUsdg: 987.6543,
    supportUsd: 19.36719,
    resistanceUsd: 22.65911,
    partial: false,
    readAtSec: 1_000_000,
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    cashUsdg: 100_000_000n,
    vaultUsdg: 0n,
    holdings: new Map(),
    prices: new Map(),
    pausedTokens: new Set(),
    staleFeeds: new Set(),
    sequencerUp: true,
    spendHeadroomUsdg: 1_000_000_000_000n,
    perTradeCapUsdg: 1_000_000_000_000n,
    ...over,
  };
}

/** Capture what the model would actually be handed. */
async function signalsFor(s: Snapshot, symbols: string[]): Promise<Signals> {
  let seen: Signals | null = null;
  const driver: ProposalDriver = {
    name: "capture",
    propose: async (signals) => {
      seen = signals;
      return { actions: [] };
    },
  };
  const strategist = makeLlmStrategist({
    driver,
    universe: universe(symbols),
    decisionIntervalMs: 0,
  });
  await strategist.tick(s);
  assert.ok(seen, "the driver must have been called");
  return seen;
}

test("depth reaches the model, rounded, for tradable symbols", async () => {
  const signals = await signalsFor(
    snap({ depth: new Map([["NVDA", depthOf("NVDA")]]) }),
    ["NVDA"],
  );
  assert.deepEqual(signals.depth, [
    { symbol: "NVDA", buyUsdg: 1234.57, sellUsdg: 987.65, supportUsd: 19.37, resistanceUsd: 22.66 },
  ]);
});

test("depth is OMITTED, not empty, when nothing has been read", async () => {
  // An empty array reads to a model as "there is no liquidity anywhere", which is
  // a far stronger claim than "not read yet" — and on a cold cache the second is
  // what is true. The prompt tells it a missing symbol is not a warning; sending
  // [] would contradict that.
  const noDepth = await signalsFor(snap(), ["NVDA"]);
  assert.equal("depth" in noDepth, false, "absent entirely on a cold cache");

  const emptyMap = await signalsFor(snap({ depth: new Map() }), ["NVDA"]);
  assert.equal("depth" in emptyMap, false, "and when the map is present but empty");
});

test("depth outside the tradable universe is dropped", async () => {
  const signals = await signalsFor(
    snap({
      depth: new Map([
        ["NVDA", depthOf("NVDA")],
        ["GME", depthOf("GME")],
      ]),
    }),
    ["NVDA"],
  );
  assert.deepEqual(signals.depth?.map((d) => d.symbol), ["NVDA"], "GME is not tradable, so it is noise");
});

test("a null support or resistance survives as null, never as zero", async () => {
  const signals = await signalsFor(
    snap({ depth: new Map([["NVDA", depthOf("NVDA", { supportUsd: null, resistanceUsd: null })]]) }),
    ["NVDA"],
  );
  // Zero is a price. Null is "no cluster found". Collapsing them would put a
  // support level at $0.00 in front of the model.
  assert.equal(signals.depth?.[0]?.supportUsd, null);
  assert.equal(signals.depth?.[0]?.resistanceUsd, null);
});

test("the depth payload stays small enough to sit in a 2048-token reply budget", async () => {
  const many = new Map(
    ["AAPL", "AMZN", "GOOGL", "MSFT", "MU", "NVDA", "SPCX", "TSLA", "QQQ", "SGOV", "SLV", "SPY", "USO", "USAR"].map(
      (s) => [s, depthOf(s)],
    ),
  );
  const symbols = [...many.keys()];
  const signals = await signalsFor(snap({ depth: many }), symbols);
  assert.equal(signals.depth?.length, 14);
  const bytes = JSON.stringify(signals.depth).length;
  // Four numbers a token, the full watch set. If this ever balloons — someone
  // attaching the tick ladder, say — the model's answer budget pays for it.
  assert.ok(bytes < 1600, `depth payload is ${bytes} bytes, which is crowding the prompt`);
});
