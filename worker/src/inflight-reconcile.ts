/**
 * In-flight UserOp reconciliation — recover a landed op the ledger never
 * recorded, so an unclean restart can't loosen the daily cap.
 *
 * THE HOLE. processIntent submits a UserOp and waits for its receipt inside
 * `executor.execute`, THEN writes the trade row (index.ts). The spend/ops
 * reservation that guards the cap between those two steps lives in process
 * MEMORY (inFlightSpentUsdg). So if the process dies after the op lands on-chain
 * but before addTrade commits — a Railway redeploy's SIGTERM, an OOM SIGKILL,
 * the watchdog — that op is gone from the counters. On restart the worker seeds
 * its budget from the ledger alone (getSpentTodayUsdg), which never saw the row,
 * and UNDER-counts the day's spend: the daily cap is now looser by that op's
 * notional, the one unsafe direction. index.ts's fail-closed write already
 * covers a ledger write that fails while the process lives; this covers the
 * process not living to attempt it.
 *
 * THE FIX. At arm, before the budget is seeded, ask the chain what this account
 * actually executed: the EntryPoint emits UserOperationEvent(userOpHash, sender,
 * …, success, …) for every op. Any SUCCESSFUL op whose hash the ledger has no
 * row for is an orphan — write the missing 'landed' row (its notional read from
 * the receipt's USDG leg) so the seed that follows counts it. The chain is the
 * authority; the ledger is reconciled up to it.
 *
 * WHY ONLY SUCCESSFUL, WHY THIS NOTIONAL. A reverted op (success=false) moved no
 * funds and — like every 'reverted' row — counts toward neither cap (the live
 * rail is landed+submitted), so an unrecorded revert changes nothing and is
 * skipped. The notional is |USDG leg| from the receipt, matching how the live
 * path books amount_usdg for both buys and sells (the daily cap is a turnover
 * cap, vault-withdraw excepted). An orphan with no readable USDG leg
 * (stock↔stock, or unparseable) is still recorded, at notional 0, so its hash is
 * known and its op counts — it just can't be attributed a spend figure.
 *
 * PURE CORE. findOrphanOps takes a narrow ReconcileChain seam, not a live
 * client, so the decoding and dedup are unit-tested without a chain — the same
 * discipline fills.ts uses. The live wiring (real getLogs/receipts against the
 * Robinhood RPC) is gated on an end-to-end run before any funded deploy, exactly
 * like the Postgres store: this file is correct by test, proven by that run.
 */
import { decodeEventLog, parseAbi, type Hex } from "viem";
import { netTokenDeltas, type ReceiptLog } from "./fills";
import { ENTRYPOINT } from "../../packages/core/src/index";

/** EntryPoint 0.7's per-op event — the account uses entryPoint 0.7 (executor.ts). */
const ENTRYPOINT_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);

/** Topic0 of UserOperationEvent — precomputed so the filter needs no client. */
const USEROP_EVENT_TOPIC = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

/** A raw log as returned by an eth_getLogs, narrowed to what the reconciler reads. */
export interface RawLog {
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex;
}

/**
 * The slice of a chain client the reconciler needs — kept narrow so a fake can
 * stand in for a viem PublicClient in tests.
 */
export interface ReconcileChain {
  getBlockNumber(): Promise<bigint>;
  /** EntryPoint UserOperationEvent logs for one sender over a block span. */
  getLogs(args: {
    address: `0x${string}`;
    fromBlock: bigint;
    toBlock: bigint;
    topics: (Hex | Hex[] | null)[];
  }): Promise<RawLog[]>;
  /** The receipt's logs, for reading the op's USDG leg. Null if not found. */
  getReceiptLogs(txHash: Hex): Promise<readonly ReceiptLog[] | null>;
}

export interface OrphanOp {
  userOpHash: string;
  txHash: string;
  /** |USDG leg|, 6dp — the notional for the cap. 0 when it couldn't be attributed. */
  notionalUsdg6: bigint;
  /** Whether a USDG leg was found (false → notional is a floor of 0, logged). */
  attributed: boolean;
}

/** Left-pad a 20-byte address into a 32-byte topic for an indexed-address filter. */
export function addressTopic(addr: string): Hex {
  return `0x${"0".repeat(24)}${addr.toLowerCase().replace(/^0x/, "")}` as Hex;
}

/**
 * Fetch EntryPoint logs for `sender` over [fromBlock, head], halving the span on
 * a provider range error rather than guessing its limit. Filtered by the indexed
 * sender topic, so only THIS account's ops come back (≤ the daily op cap per
 * day) however wide the window — the span cap is about provider limits, not
 * result volume.
 */
async function getLogsAdaptive(
  chain: ReconcileChain,
  sender: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
  maxSpan: bigint,
  log?: (m: string) => void,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  let cursor = fromBlock;
  let span = maxSpan;
  while (cursor <= toBlock) {
    const end = cursor + span - 1n < toBlock ? cursor + span - 1n : toBlock;
    try {
      const logs = await chain.getLogs({
        address: ENTRYPOINT.v07 as `0x${string}`,
        fromBlock: cursor,
        toBlock: end,
        topics: [USEROP_EVENT_TOPIC, null, addressTopic(sender)],
      });
      out.push(...logs);
      cursor = end + 1n;
    } catch (e) {
      // Almost always "block range too large" — halve and retry the same start.
      if (span <= 1n) {
        log?.(`reconcile: getLogs failed on a single block ${cursor}, skipping it: ${e instanceof Error ? e.message : String(e)}`);
        cursor += 1n;
        span = maxSpan;
        continue;
      }
      span = span / 2n;
    }
  }
  return out;
}

/**
 * The orphans among this account's on-chain ops: successful, and with no ledger
 * row for their hash. Pure but for the injected chain seam.
 */
export async function findOrphanOps(opts: {
  chain: ReconcileChain;
  smartAccount: `0x${string}`;
  usdgToken: string;
  knownOpHashes: Set<string>;
  /** Blocks back from head to scan. The caller derives it from the 24h cap window. */
  lookbackBlocks: bigint;
  /** Max blocks per getLogs call (adaptive-halved down from here on a range error). */
  maxSpan?: bigint;
  log?: (m: string) => void;
}): Promise<OrphanOp[]> {
  const { chain, smartAccount, usdgToken, knownOpHashes, lookbackBlocks } = opts;
  const head = await chain.getBlockNumber();
  const from = head > lookbackBlocks ? head - lookbackBlocks : 0n;
  const logs = await getLogsAdaptive(chain, smartAccount, from, head, opts.maxSpan ?? 10_000n, opts.log);

  const orphans: OrphanOp[] = [];
  const seen = new Set<string>(); // guard against the same op appearing twice in a window
  for (const raw of logs) {
    let userOpHash: string;
    let success: boolean;
    try {
      const decoded = decodeEventLog({ abi: ENTRYPOINT_ABI, topics: raw.topics as [Hex, ...Hex[]], data: raw.data });
      userOpHash = String(decoded.args.userOpHash).toLowerCase();
      success = Boolean(decoded.args.success);
    } catch {
      continue; // not a UserOperationEvent we can read — skip
    }
    // A reverted op moved nothing and counts toward no cap; only a successful op
    // the ledger missed can under-count the day.
    if (!success) continue;
    if (knownOpHashes.has(userOpHash) || seen.has(userOpHash)) continue;
    seen.add(userOpHash);

    const txHash = raw.transactionHash;
    let notionalUsdg6 = 0n;
    let attributed = false;
    const receiptLogs = await chain.getReceiptLogs(txHash).catch(() => null);
    if (receiptLogs) {
      const deltas = netTokenDeltas(receiptLogs, smartAccount);
      const usdgDelta = deltas.get(usdgToken.toLowerCase()) ?? 0n;
      if (usdgDelta !== 0n) {
        notionalUsdg6 = usdgDelta < 0n ? -usdgDelta : usdgDelta;
        attributed = true;
      }
    }
    orphans.push({ userOpHash, txHash: String(txHash).toLowerCase(), notionalUsdg6, attributed });
  }
  return orphans;
}
