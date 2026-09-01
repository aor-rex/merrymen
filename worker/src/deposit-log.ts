/**
 * Deposits and withdrawals read from the chain, so a flow is evidence rather
 * than a guess.
 *
 * THE HOLE. `FlowSource` has always declared three sources — 'chain-log',
 * 'transfer-intent' and 'inferred' — and 'chain-log' had NO PRODUCER anywhere in
 * the worker. Only `transfer-intent` (an outbound transfer the agent itself
 * signed) and `inferred` were ever written, so every inbound deposit was an
 * inference with no transaction hash behind it.
 *
 * WHAT INFERENCE CANNOT DO. reconcileFlows books a flow in exactly two cases:
 * the first funded observation, and a cash change with no ledger row written in
 * between. Its own comment records the limit — a deposit landing in the same
 * tick as a fill is deliberately NOT inferred, because separating the two would
 * mean trusting fill economics taken from a pre-trade bound rather than a
 * receipt. So an owner who topped up while the agent was trading had that
 * deposit silently folded into performance, and the fix named in that comment is
 * this file: read the USDG Transfer logs.
 *
 * WHY IT MATTERS BEYOND TIDINESS. Contributions are what P&L is measured
 * against. A deposit that is never recorded is arithmetically indistinguishable
 * from a gain — the flows table exists because /pnl once reported +999.48 on a
 * book that was down 0.52 and charged a performance fee on the owner's own
 * principal. An inferred flow at least says so in its `source` and an audit can
 * drop it on sight; a missing one cannot be seen at all.
 *
 * PURE CORE. Like findOrphanOps, this takes the narrow ReconcileChain seam
 * rather than a live client, so decoding, direction and dedup are unit-tested
 * without a chain. It reuses that module's `getLogsAdaptive` and `addressTopic`
 * rather than growing a second halving loop — that one already knows a failure
 * at span 1 is a bad block to step over rather than a range error to halve
 * again, and two copies of that rule would drift.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not write. The caller books the
 * flows AND moves the high-water mark with them, because a deposit that lifts
 * equity without lifting the peak it is measured against is the original bug
 * wearing a tx hash.
 */
import { decodeEventLog, parseAbi, type Hex } from "viem";
import { addressTopic, getLogsAdaptive, type RawLog, type ReconcileChain } from "./inflight-reconcile";

/** The ERC-20 event. `value` is not indexed, so it is read from `data`. */
const TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Topic0 of Transfer(address,address,uint256) — precomputed, so no client is needed. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

/** One USDG movement across the account boundary, as the chain recorded it. */
export interface TransferFlow {
  direction: "in" | "out";
  /** Raw 6dp USDG, always positive — `direction` carries the sign. */
  amountUsdg6: bigint;
  txHash: string;
  blockNumber: number;
  /** Position within the block: two transfers can share a transaction. */
  logIndex: number;
}

/** The dedup key. A transaction alone is not unique — one tx can carry several. */
export function flowKey(txHash: string, logIndex: number): string {
  return `${txHash.toLowerCase()}#${logIndex}`;
}

/** Hex or decimal string/number to a JS number, or null when unusable. */
function num(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  try {
    const n = typeof v === "number" ? v : Number(BigInt(v as string));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * USDG movements in or out of `smartAccount` over [fromBlock, toBlock] that the
 * ledger does not already explain.
 *
 * Two scans rather than one: `from` and `to` are separate indexed topics, and
 * there is no single filter that means "either side is this account".
 */
export async function findTransferFlows(opts: {
  chain: ReconcileChain;
  smartAccount: `0x${string}`;
  usdgToken: `0x${string}`;
  fromBlock: bigint;
  toBlock: bigint;
  /**
   * Flow keys already recorded, from `flows`. The scan resumes from the LAST
   * block it recorded rather than the one after, so that a crash part-way
   * through a block cannot lose the rest of it — which means the final block is
   * always re-read and this set is what stops it being booked twice.
   */
  knownKeys: Set<string>;
  /**
   * Transaction hashes the ledger already explains as trades. A swap moves USDG
   * too, and its Transfer log is a FILL, not a deposit — booking it as capital
   * would inflate contributions by the whole turnover of the account and drive
   * P&L steadily negative. Vault moves are covered by the same rule: they are
   * trade rows with transaction hashes.
   */
  tradeTxHashes: Set<string>;
  maxSpan?: bigint;
  log?: (m: string) => void;
}): Promise<TransferFlow[]> {
  const { chain, smartAccount, usdgToken, fromBlock, toBlock, knownKeys, tradeTxHashes } = opts;
  if (toBlock < fromBlock) return [];
  const span = opts.maxSpan ?? 10_000n;
  const me = addressTopic(smartAccount);

  const raw: RawLog[] = [];
  for (const topics of [
    [TRANSFER_TOPIC, null, me], // inbound: to = us
    [TRANSFER_TOPIC, me, null], // outbound: from = us
  ] as (Hex | Hex[] | null)[][]) {
    raw.push(
      ...(await getLogsAdaptive(chain, { address: usdgToken, topics }, fromBlock, toBlock, span, opts.log)),
    );
  }

  const out: TransferFlow[] = [];
  const seen = new Set<string>();
  for (const l of raw) {
    const blockNumber = num(l.blockNumber);
    const logIndex = num(l.logIndex);
    // Without both, this flow can neither be resumed from nor deduplicated, and
    // a flow that could be booked twice is worse than one booked late.
    if (blockNumber === null || logIndex === null) {
      opts.log?.(`deposit scan: skipping a log with no block number or index (${l.transactionHash})`);
      continue;
    }

    let from: string;
    let to: string;
    let value: bigint;
    try {
      const d = decodeEventLog({ abi: TRANSFER_ABI, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      from = String(d.args.from).toLowerCase();
      to = String(d.args.to).toLowerCase();
      value = d.args.value as bigint;
    } catch {
      continue; // not a Transfer we can read
    }

    const key = flowKey(l.transactionHash, logIndex);
    // The two scans overlap on a self-transfer, and a window can be re-read.
    if (seen.has(key) || knownKeys.has(key)) continue;
    seen.add(key);

    // A transfer to itself moves nothing across the boundary. It appears in both
    // scans and would otherwise be booked as a deposit of its own size.
    if (from === to) continue;
    if (value === 0n) continue;
    if (tradeTxHashes.has(l.transactionHash.toLowerCase())) continue;

    const mine = smartAccount.toLowerCase();
    if (to !== mine && from !== mine) continue; // neither leg is ours
    out.push({
      direction: to === mine ? "in" : "out",
      amountUsdg6: value,
      txHash: l.transactionHash,
      blockNumber,
      logIndex,
    });
  }

  // Chronological, so the flows are booked in the order they happened and the
  // high-water mark moves through the same sequence the account did.
  out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  return out;
}

/**
 * Where the next scan starts.
 *
 * INCLUSIVE of the last recorded block, not the one after it. A block can carry
 * several transfers, and a crash between two of them would otherwise strand the
 * rest permanently — the watermark would have moved past a block that was only
 * partly read. Re-reading one block each pass is cheap; `knownKeys` makes it
 * free of consequence.
 *
 * `null` means nothing has been scanned yet, and the caller decides where to
 * open: at arm that is the head, so history stays with the single `inferred`
 * opening-balance row rather than being re-litigated transfer by transfer.
 */
export function resumeFrom(lastRecordedBlock: number | null, head: bigint, maxLookback: bigint): bigint {
  if (lastRecordedBlock === null) return head;
  const floor = head > maxLookback ? head - maxLookback : 0n;
  const at = BigInt(lastRecordedBlock);
  return at < floor ? floor : at;
}
