/**
 * Learning a v4 pool's real PoolKey from the chain, because it cannot be guessed.
 *
 * WHY GUESSING FAILS, measured 2026-08-30 against 199 live Initialize events on
 * mainnet. `findV4Pool` builds candidate keys from `V4_TIERS` — the four
 * (fee, tickSpacing) pairs Uniswap ships — and hashes them into poolIds. Not one
 * graduated Pons coin was found that way, and the reason is broader than the
 * hooks caveat already written down in uniswap-v4.ts:
 *
 *   - Fees are almost never a standard tier. Observed lpFees include 0, 200,
 *     863300, 890000, 933267, 945000 — arbitrary values, because these pools are
 *     opened with a DYNAMIC FEE (key.fee = 0x800000, the LPFeeLibrary flag) and
 *     the live rate lives in slot0's `lpFee`, not in the key.
 *   - tickSpacing is routinely 200 against a fee that has no matching tier.
 *   - 12 of 163 live pools carry a hook, most of them Pons's own
 *     0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544, and a hook address is
 *     unguessable by construction.
 *
 * So the key has to be READ. The PoolManager emits every field of it in
 * `Initialize`, and a key rebuilt from that event hashes back to the poolId the
 * event was indexed by — verified for every event in the sample, which is the
 * check that makes this trustworthy rather than merely plausible.
 *
 * WHY NOT BITQUERY. `venues/bitquery.ts` already learns keys from the same event
 * and `store.poolKeysFor` persists them, and that path stays. This one needs no
 * API key, no third party and no gateway, and it answers for any window the node
 * will serve — which matters because the agent has to be able to price a coin it
 * has only just heard about.
 */

import type { PublicClient } from "viem";
import { decodeAbiParameters, toEventSelector } from "viem";
import { UNISWAP } from "../../../packages/core/src/index";
import { poolId, type PoolKey } from "./uniswap-v4";

/** `Initialize(PoolId indexed, Currency indexed, Currency indexed, uint24, int24, address, uint160, int24)` */
export const V4_INITIALIZE_SIG =
  "Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)" as const;

export const V4_INITIALIZE_TOPIC = toEventSelector(V4_INITIALIZE_SIG);

/**
 * Uniswap's dynamic-fee flag. A key carrying it says "ask slot0", not "0x800000
 * hundredths of a bip" — and reading it as a literal fee yields 167,772 bps,
 * which is the sort of number that sails through a sanity check written for
 * basis points.
 */
export const DYNAMIC_FEE_FLAG = 0x800000;

/**
 * Blocks per `eth_getLogs`. The node caps a response at 10,000 entries and this
 * query is chain-wide with no address filter beyond the PoolManager; 199 events
 * per 9,000 blocks measured, so 9,000 is comfortable — but the activity sweep
 * next door learned this lesson the expensive way, so it is chunked anyway and
 * a chunk at the cap is treated as a failed read rather than a short one.
 */
export const KEY_CHUNK_BLOCKS = 9_000n;

export interface LearnedKey {
  key: PoolKey;
  id: `0x${string}`;
  blockNumber: bigint;
}

/**
 * Rebuild a PoolKey from one Initialize log, or null if it does not verify.
 *
 * THE VERIFICATION IS THE POINT. A key assembled from the wrong topic order, or
 * from a log that is not actually this event, still hashes to *something* — it
 * would simply address a pool that does not exist, and every read against it
 * would come back empty and look like "no liquidity here". Hashing the rebuilt
 * key and requiring it to equal the id the event was indexed by turns that
 * silent class of error into a null.
 */
export function parseInitializeLog(log: {
  topics: readonly string[];
  data: string;
  blockNumber?: bigint | null;
}): LearnedKey | null {
  if (log.topics.length < 4) return null;
  if (log.topics[0]?.toLowerCase() !== V4_INITIALIZE_TOPIC.toLowerCase()) return null;
  try {
    const [fee, tickSpacing, hooks] = decodeAbiParameters(
      [{ type: "uint24" }, { type: "int24" }, { type: "address" }, { type: "uint160" }, { type: "int24" }],
      log.data as `0x${string}`,
    ) as [number, number, `0x${string}`, bigint, number];
    const key: PoolKey = {
      currency0: `0x${log.topics[1 + 1]!.slice(-40)}`.toLowerCase() as `0x${string}`,
      currency1: `0x${log.topics[1 + 2]!.slice(-40)}`.toLowerCase() as `0x${string}`,
      fee,
      tickSpacing,
      hooks: hooks.toLowerCase() as `0x${string}`,
    };
    const id = poolId(key);
    if (id.toLowerCase() !== log.topics[1]!.toLowerCase()) return null;
    return { key, id, blockNumber: log.blockNumber ?? 0n };
  } catch {
    return null;
  }
}

/**
 * Every pool opened in the last `lookbackBlocks`, keyed by poolId.
 *
 * Returns null rather than an empty map when the node refuses, because "no pools
 * were opened" and "I could not look" are different facts and only one of them
 * means the agent has nothing to consider.
 */
export async function learnV4Keys(
  client: PublicClient,
  lookbackBlocks: bigint,
): Promise<Map<string, LearnedKey> | null> {
  try {
    const head = await client.getBlockNumber();
    const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
    const out = new Map<string, LearnedKey>();
    for (let lo = from; lo <= head; lo += KEY_CHUNK_BLOCKS) {
      const hi = lo + KEY_CHUNK_BLOCKS - 1n > head ? head : lo + KEY_CHUNK_BLOCKS - 1n;
      const logs = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            address: UNISWAP.v4PoolManager as `0x${string}`,
            fromBlock: `0x${lo.toString(16)}`,
            toBlock: `0x${hi.toString(16)}`,
            topics: [V4_INITIALIZE_TOPIC],
          },
        ],
      } as never)) as { topics: string[]; data: string; blockNumber: bigint | null }[];
      // At the cap the window was too wide and the answer is short by an unknown
      // amount — a pool missing from this map reads as "does not exist".
      if (logs.length >= 10_000) return null;
      for (const l of logs) {
        const parsed = parseInitializeLog(l);
        if (parsed) out.set(parsed.id.toLowerCase(), parsed);
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** The learned keys that pair `token` with anything, newest first. */
export function keysForToken(
  learned: Iterable<LearnedKey>,
  token: `0x${string}`,
): LearnedKey[] {
  const t = token.toLowerCase();
  return [...learned]
    .filter((k) => k.key.currency0 === t || k.key.currency1 === t)
    .sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : b.blockNumber < a.blockNumber ? -1 : 0));
}

/** The other side of a pair — what the token is priced in. */
export function quoteSideOf(key: PoolKey, token: `0x${string}`): `0x${string}` {
  return key.currency0.toLowerCase() === token.toLowerCase() ? key.currency1 : key.currency0;
}

/**
 * A key book that learns once and then only catches up.
 *
 * Relearning a wide window every tick would be absurd — the backfill is ten
 * chunked `eth_getLogs` and the tick runs every 60 seconds. But a short window
 * is worse than expensive, it is WRONG: a coin that graduated three hours ago
 * would simply not be in the map, and "not in the map" is indistinguishable from
 * "has no pool", which is how a tradeable coin quietly becomes an unpriceable
 * one.
 *
 * So the book backfills once and thereafter reads only from the last block it
 * saw. It never forgets a key, because a pool does not stop existing.
 */
export interface V4KeyBook {
  /** Catch up to head and return every key known so far. Never throws. */
  refresh(client: PublicClient): Promise<Map<string, LearnedKey>>;
  /** What is known right now, without touching the network. */
  known(): Map<string, LearnedKey>;
  /** How far the book has read to. 0 = nothing yet. */
  head(): bigint;
}

export function createV4KeyBook(opts?: { backfillBlocks?: bigint; minGapBlocks?: bigint }): V4KeyBook {
  // ~2.5 hours at this chain's ~0.1s blocks. Graduations are frequent enough
  // that this covers the live launchpad; anything older is picked up by the
  // discovery layer's own persisted keys (store.poolKeysFor).
  const backfill = opts?.backfillBlocks ?? 90_000n;
  // Don't re-read for a handful of blocks. The tick is 60s; the chain makes
  // ~600 blocks in that time, so this only suppresses genuinely idle passes.
  const minGap = opts?.minGapBlocks ?? 60n;
  const book = new Map<string, LearnedKey>();
  let readTo = 0n;

  return {
    known: () => book,
    head: () => readTo,
    async refresh(client) {
      try {
        const head = await client.getBlockNumber();
        const from = readTo === 0n ? (head > backfill ? head - backfill : 0n) : readTo + 1n;
        if (readTo !== 0n && head < readTo + minGap) return book;
        if (from > head) return book;
        for (let lo = from; lo <= head; lo += KEY_CHUNK_BLOCKS) {
          const hi = lo + KEY_CHUNK_BLOCKS - 1n > head ? head : lo + KEY_CHUNK_BLOCKS - 1n;
          const logs = (await client.request({
            method: "eth_getLogs",
            params: [
              {
                address: UNISWAP.v4PoolManager as `0x${string}`,
                fromBlock: `0x${lo.toString(16)}`,
                toBlock: `0x${hi.toString(16)}`,
                topics: [V4_INITIALIZE_TOPIC],
              },
            ],
          } as never)) as { topics: string[]; data: string; blockNumber: bigint | null }[];
          // At the cap the answer is short by an unknown amount. Stop and keep
          // `readTo` where it was, so the next pass retries the same range
          // rather than skipping past pools it never saw.
          if (logs.length >= 10_000) return book;
          for (const l of logs) {
            const parsed = parseInitializeLog(l);
            if (parsed) book.set(parsed.id.toLowerCase(), parsed);
          }
          readTo = hi;
        }
        return book;
      } catch {
        // A failed catch-up leaves the book intact and `readTo` where it was.
        // Stale knowledge is better than none and the next pass resumes.
        return book;
      }
    },
  };
}
