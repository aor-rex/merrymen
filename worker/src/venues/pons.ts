/**
 * Pons launches — seeing the memecoins that never touch a Uniswap pool.
 *
 * WHY THIS EXISTS. Discovery finds tokens by watching Uniswap Initialize
 * events (via Bitquery, the only source that decodes hooked v4 pools). That
 * finds nothing here: a Pons V2 token launches onto its OWN bonding-curve
 * contract and has no pool at all until it graduates. So the launchpad where
 * essentially every new token on this chain appears was, to merrymen,
 * completely invisible — not "hard to price", not "filtered out", simply never
 * seen. This reads the launchpad directly instead.
 *
 * WHAT IS VERIFIED, AND HOW. Everything below was confirmed against mainnet
 * 4663 rather than taken from documentation, because Pons publishes none:
 *   - the factory has 24,177 bytes of code at the address below;
 *   - it emits this topic0 for launches — 4 in a 3,000-block sample;
 *   - the three indexed addresses are (token, creator, curve), established by
 *     probing each: the first answers symbol()/name() as an ERC-20 ("JASON",
 *     "if only you knew"), the third answers token() pointing back at the
 *     first, and the middle answers neither.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not price a curve token, and it
 * cannot yet: the curve is a beacon proxy whose implementation exposes 62
 * selectors and none of the buy/sell/reserve names one would guess — the
 * interface is genuinely undocumented and needs resolving before a price, let
 * alone a trade, can be honest. So this REPORTS, exactly as discovery.ts does,
 * and nothing here is on the dispose side. Seeing a launch is not deciding to
 * hold it.
 */
import type { PublicClient } from "viem";

/** PonsV2LaunchFactory on Robinhood Chain mainnet. Verified: 24,177 bytes. */
export const PONS_V2_FACTORY = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e" as const;

/**
 * topic0 of the V2 launch event, taken from the chain rather than a signature
 * guess — Pons publishes no ABI, so the hash IS the specification here.
 * Shape: (address indexed token, address indexed creator, address indexed curve),
 * no data words.
 */
export const PONS_V2_LAUNCH_TOPIC =
  "0x308c390ed1ab5873392818e036cabdf408bc8ad042fbaead3108954ff75ba980" as const;

/** A token that launched on a Pons bonding curve. */
export interface PonsLaunch {
  /** The ERC-20 itself, lowercased. */
  token: `0x${string}`;
  /** Its bonding curve — where it trades until graduation. Lowercased. */
  curve: `0x${string}`;
  /** Whoever launched it, lowercased. Not a trust signal; recorded, not trusted. */
  creator: `0x${string}`;
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
 * three addresses is not a vaguer version of the same launch — it is something
 * this code does not understand, and inventing a zero address for it would put
 * a token nobody launched in front of the owner.
 */
export function parseLaunchLogs(
  logs: readonly { topics: readonly string[]; blockNumber: bigint | null; transactionHash: string | null }[],
): PonsLaunch[] {
  const out: PonsLaunch[] = [];
  for (const log of logs) {
    if (log.topics.length < 4) continue;
    if (log.topics[0]?.toLowerCase() !== PONS_V2_LAUNCH_TOPIC) continue;
    if (log.blockNumber === null || log.transactionHash === null) continue;
    out.push({
      token: addressFromTopic(log.topics[1]!),
      creator: addressFromTopic(log.topics[2]!),
      curve: addressFromTopic(log.topics[3]!),
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
    // event to filter by, and Pons publishes no ABI — the topic hash IS the
    // specification here. Same approach as inflight-reconcile.ts.
    // Topic-filtered at the node: the factory also emits a much busier trade
    // event (60 to every 4 launches in the sample), and pulling those back just
    // to discard them would be the bulk of the response.
    const raw = (await client.request({
      method: "eth_getLogs",
      params: [
        {
          address: PONS_V2_FACTORY,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${head.toString(16)}`,
          topics: [PONS_V2_LAUNCH_TOPIC],
        },
      ],
    } as never)) as { topics: string[]; blockNumber: string; transactionHash: string }[];
    return parseLaunchLogs(
      raw.map((l) => ({
        topics: l.topics,
        blockNumber: BigInt(l.blockNumber),
        transactionHash: l.transactionHash,
      })),
    );
  } catch {
    return [];
  }
}
