/**
 * The per-coin facts a card needs: ticker, name, how far up its curve, how old.
 *
 * `pons-meta.ts` reads what the LAUNCHER SAID about a token. This reads what
 * the CHAIN says about it, which is the half a card cannot make up: its symbol,
 * its name, and its position on its own bonding curve.
 *
 * THE COST DISCIPLINE THAT SHAPES THIS FILE. Pons runs at roughly 940 launches
 * an hour and the activity gate keeps about an eighth of them, so a card page
 * is tens of tokens, not thousands — but the naive version is four eth_calls
 * per coin (symbol, name, reserves, threshold) and that is a hundred-plus
 * round trips on a keyless public RPC for one page load. Everything here is one
 * Multicall3 batch, and the block clock is two calls for the whole page however
 * many coins are on it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It never invents a value. A symbol that
 * cannot be read stays empty rather than becoming the address, progress that
 * cannot be computed stays null rather than becoming zero, and an age that
 * cannot be derived stays null rather than becoming "just now" — because on a
 * page whose whole subject is brand-new coins, a fabricated "0s old" is the one
 * lie a reader would never catch.
 */
import type { PublicClient } from "viem";
import { decodeAbiParameters } from "viem";
import { aggregate3, sanitizeMeta } from "./pons-meta";
import { realQuoteRaw } from "./pons-price";
import type { PonsLaunch } from "./pons";

/** ERC-20 `symbol()` and `name()`, and the curve's `getReserves()`. */
const SEL_SYMBOL = "0x95d89b41" as const;
const SEL_NAME = "0x06fdde03" as const;
const SEL_GET_RESERVES = "0x0902f1ac" as const;

/**
 * Coins per Multicall3 batch.
 *
 * Three sub-calls each, so this is 300 sub-calls per batch — a quarter of what
 * `META_BATCH` sends and well inside what the node returns, while still making
 * a whole card page one round trip.
 */
export const CARD_BATCH = 100;

/** What the chain says about one launched coin. Every field may be absent. */
export interface CardFacts {
  /** The ERC-20's own ticker, sanitised. Empty when unreadable. */
  symbol: string;
  /** The ERC-20's own name, sanitised. Empty when unreadable. */
  name: string;
  /**
   * How far up its curve, in basis points of its own graduation threshold.
   *
   * Of its OWN threshold, deliberately: only 53.6% of curves are quoted in ETH
   * and the rest in stock tokens, cbBTC or USDG, at thresholds that are not a
   * constant USD value. Progress against the curve's own number is comparable
   * across all of them and needs no price feed at all.
   *
   * Net of the virtual seed — Pons opens every curve holding 40% of its
   * threshold in quote it does not have — so 0 means nobody has bought yet,
   * which is true of 78% of curves.
   */
  progressBps: number | null;
  /** Real quote raised so far, raw units of the quote asset. */
  realQuoteRaw: bigint | null;
}

/**
 * Decode an ERC-20 string return.
 *
 * Tolerates the bytes32 form some tokens still use: a 32-byte return is not a
 * valid ABI string (the offset word would have to be 0x20) and would otherwise
 * decode to nothing at all, so a right-padded ticker reads as empty.
 */
export function decodeErc20String(data: `0x${string}` | undefined): string {
  if (!data || data.length < 66) return "";
  try {
    const [s] = decodeAbiParameters([{ type: "string" }], data) as [string];
    return sanitizeMeta(s, 40);
  } catch {
    try {
      // bytes32: strip the zero padding and read it as UTF-8.
      const hex = data.slice(2, 66).replace(/(00)+$/, "");
      if (!hex || hex.length % 2) return "";
      const bytes = new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
      return sanitizeMeta(new TextDecoder().decode(bytes), 40);
    } catch {
      return "";
    }
  }
}

/** Curve progress in bps of threshold, or null when the read is unusable. */
export function progressBpsOf(
  reservesData: `0x${string}` | undefined,
  graduationThresholdRaw: bigint,
): { progressBps: number; realQuoteRaw: bigint } | null {
  if (!reservesData || reservesData.length < 2 + 128) return null;
  if (graduationThresholdRaw <= 0n) return null;
  const quoteRaw = BigInt(`0x${reservesData.slice(2, 66)}`);
  const real = realQuoteRaw({
    quoteRaw,
    // The rest of CurveReserves is not read by realQuoteRaw; only the quote
    // side and the threshold decide how much of the reserve is a seed.
    tokenRaw: BigInt(`0x${reservesData.slice(66, 130)}`),
    quoteDecimals: 18,
    tokenDecimals: 18,
    graduationThresholdRaw,
  });
  const bps = Number((real * 10_000n) / graduationThresholdRaw);
  // A curve past its threshold is mid-graduation, not 140% of the way there.
  return { progressBps: Math.min(10_000, Math.max(0, bps)), realQuoteRaw: real };
}

/**
 * Read symbol, name and curve progress for many launches in one batch.
 *
 * Keyed by lowercased TOKEN address. A coin absent from the map was not read,
 * which the caller must be able to tell from a coin that read as empty.
 */
export async function readCardFacts(
  client: PublicClient,
  launches: readonly PonsLaunch[],
): Promise<Map<string, CardFacts>> {
  const out = new Map<string, CardFacts>();
  for (let i = 0; i < launches.length; i += CARD_BATCH) {
    const batch = launches.slice(i, i + CARD_BATCH);
    const calls = batch.flatMap((l) => [
      { target: l.token, callData: SEL_SYMBOL as `0x${string}` },
      { target: l.token, callData: SEL_NAME as `0x${string}` },
      { target: l.curve, callData: SEL_GET_RESERVES as `0x${string}` },
    ]);
    const res = await aggregate3(client, calls);
    if (res.length !== calls.length) continue; // a failed batch says nothing about its coins
    for (let j = 0; j < batch.length; j++) {
      const l = batch[j]!;
      const sym = res[j * 3];
      const nm = res[j * 3 + 1];
      const rv = res[j * 3 + 2];
      const prog = rv?.success ? progressBpsOf(rv.returnData, l.graduationThresholdRaw) : null;
      out.set(l.token.toLowerCase(), {
        symbol: sym?.success ? decodeErc20String(sym.returnData) : "",
        name: nm?.success ? decodeErc20String(nm.returnData) : "",
        progressBps: prog?.progressBps ?? null,
        realQuoteRaw: prog?.realQuoteRaw ?? null,
      });
    }
  }
  return out;
}

/**
 * Wall-clock seconds per block, measured rather than assumed.
 *
 * Age is the single most load-bearing number on a launchpad card — "40 seconds
 * old" is the whole reason to look — and the only thing a launch carries is a
 * block number. Deriving age needs a seconds-per-block, and hardcoding one is
 * exactly the kind of plausible constant that reads correct forever and is
 * quietly wrong after any change to block time.
 *
 * So it is measured from two real blocks, far enough apart that jitter in any
 * single block cannot distort the slope.
 */
export interface BlockClock {
  latest: bigint;
  latestTimeSec: number;
  secPerBlock: number;
}

export async function readBlockClock(client: PublicClient, span = 20_000n): Promise<BlockClock | null> {
  try {
    const head = await client.getBlock({ blockTag: "latest" });
    const from = head.number > span ? head.number - span : 0n;
    if (from >= head.number) return null;
    const older = await client.getBlock({ blockNumber: from });
    const dBlocks = Number(head.number - older.number);
    const dSec = Number(head.timestamp - older.timestamp);
    if (dBlocks <= 0 || dSec <= 0) return null;
    return { latest: head.number, latestTimeSec: Number(head.timestamp), secPerBlock: dSec / dBlocks };
  } catch {
    return null;
  }
}

/** Age of a launch in seconds, or null when there is no clock to measure with. */
export function ageSecOf(clock: BlockClock | null, blockNumber: bigint): number | null {
  if (!clock) return null;
  const behind = Number(clock.latest - blockNumber);
  if (!Number.isFinite(behind) || behind < 0) return null;
  return Math.round(behind * clock.secPerBlock);
}
