/**
 * Pons launches — seeing the memecoins that never touch a Uniswap pool.
 *
 * WHY THIS EXISTS. Discovery finds tokens by watching Uniswap Initialize
 * events (via Bitquery, the only source that decodes hooked v4 pools). That
 * finds nothing here: a Pons token launches onto its OWN bonding-curve contract
 * and has no pool at all until it graduates at 4.2 ETH raised. So the launchpad
 * where essentially every new token on this chain appears was, to merrymen,
 * completely invisible — not "hard to price", not "filtered out", simply never
 * seen. This reads the launchpad directly instead.
 *
 * WHAT IS VERIFIED, AND HOW. Pons publishes no ABI, so every constant here was
 * established against mainnet 4663 rather than read from documentation:
 *   - the factory has 24,177 bytes of code at the address below;
 *   - it emits this topic0 on launch — ~50 per 3,000 blocks, and 523 distinct
 *     tokens over 40,000 blocks, so the launchpad is genuinely busy;
 *   - the field order was fixed by probing a real launch (PIZZA): topic1
 *     answers symbol() as an ERC-20, topic2 answers token() pointing back at
 *     topic1 AND getReserves() — so it is the curve — and topic3 answers
 *     neither, so it is the creator.
 *
 * A CORRECTION WORTH KEEPING. This module first shipped watching topic0
 * 0x308c390e…, which looked right because its three indexed addresses probed as
 * (token, creator, curve). It is a DIFFERENT, secondary event: it fires ~12x
 * less often and about 205 blocks (~20s) AFTER the launch. Watching it silently
 * under-reported the launchpad by an order of magnitude. Two events on one
 * contract can both look like "the launch" when probed in isolation; the thing
 * that separated them was comparing when each fired for the same token.
 */
import type { PublicClient } from "viem";

/** PonsV2LaunchFactory on Robinhood Chain mainnet. Verified: 24,177 bytes. */
export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;

/**
 * topic0 of the launch event, taken from the chain rather than a signature
 * guess — with no published ABI the hash IS the specification.
 *
 * Shape, established by probing: (token indexed, curve indexed, creator
 * indexed) with the quote token in the first data word.
 */
export const PONS_LAUNCH_TOPIC =
  "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607" as const;

/** A token that launched on a Pons bonding curve. */
export interface PonsLaunch {
  /** The ERC-20 itself, lowercased. */
  token: `0x${string}`;
  /** Its bonding curve — where it trades until graduation. Lowercased. */
  curve: `0x${string}`;
  /** Whoever launched it, lowercased. Recorded, never treated as a trust signal. */
  creator: `0x${string}`;
  /**
   * What the curve is priced in, lowercased. `0x0` means NATIVE ETH.
   *
   * Load-bearing rather than trivia: quote assets vary per launch — native ETH,
   * USDG and cbBTC have all been observed — and the quote asset decides both how
   * the token is priced and whether the agent can reach it at all. A curve
   * quoted in something the wall does not cover is not tradeable, however good
   * the token looks.
   */
  quoteToken: `0x${string}`;
  blockNumber: bigint;
  txHash: `0x${string}`;
}

/** An indexed address topic carries the address in its low 20 bytes. */
function addressFromTopic(topic: string): `0x${string}` {
  return `0x${topic.slice(-40)}`.toLowerCase() as `0x${string}`;
}

/**
 * Launches in a block range, oldest first.
 *
 * Malformed logs are SKIPPED rather than defaulted. A launch missing one of its
 * addresses is not a vaguer version of the same launch — it is something this
 * code does not understand, and inventing a zero address for it would put a
 * token nobody launched, on a curve nobody can trade, in front of the owner.
 * Note that a zero QUOTE token is the one legitimate zero here (native ETH), so
 * that field is read from data rather than being subject to the same check.
 */
export function parseLaunchLogs(
  logs: readonly {
    topics: readonly string[];
    data: string;
    blockNumber: bigint | null;
    transactionHash: string | null;
  }[],
): PonsLaunch[] {
  const out: PonsLaunch[] = [];
  for (const log of logs) {
    if (log.topics.length < 4) continue;
    if (log.topics[0]?.toLowerCase() !== PONS_LAUNCH_TOPIC) continue;
    if (log.blockNumber === null || log.transactionHash === null) continue;
    // The quote token is the first data word. Absent data is a shape this code
    // does not recognise, not "quoted in ETH" — do not guess it.
    if (typeof log.data !== "string" || log.data.length < 2 + 64) continue;
    out.push({
      token: addressFromTopic(log.topics[1]!),
      curve: addressFromTopic(log.topics[2]!),
      creator: addressFromTopic(log.topics[3]!),
      quoteToken: `0x${log.data.slice(2 + 24, 2 + 64)}`.toLowerCase() as `0x${string}`,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash as `0x${string}`,
    });
  }
  return out;
}

/**
 * Read recent launches straight from the factory.
 *
 * `lookbackBlocks` is bounded by the caller because this chain produces a block
 * roughly every 0.1s — a naive "last 24 hours" is nearly a million blocks and
 * every public RPC will refuse it. Returns [] rather than throwing: discovery
 * is a reporting path, and a launchpad that cannot be read must not be able to
 * take the trading loop down with it.
 */
export async function recentPonsLaunches(
  client: PublicClient,
  lookbackBlocks: bigint,
): Promise<PonsLaunch[]> {
  try {
    const head = await client.getBlockNumber();
    const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
    // Raw eth_getLogs rather than viem's typed getLogs: that one wants an ABI
    // event to filter by, and Pons publishes no ABI — the topic hash is the
    // only specification that exists. Same approach as inflight-reconcile.ts.
    // Topic-filtered at the node so the factory's other events never travel.
    const raw = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: PONS_V2_FACTORY,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
          topics: [PONS_LAUNCH_TOPIC],
        },
      ],
    } as never)) as { topics: string[]; data: string; blockNumber: string; transactionHash: string }[];
    return parseLaunchLogs(
      raw.map((l) => ({
        topics: l.topics,
        data: l.data,
        blockNumber: BigInt(l.blockNumber),
        transactionHash: l.transactionHash,
      })),
    );
  } catch {
    return [];
  }
}
