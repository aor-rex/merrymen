import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toEventSelector, type Hex } from "viem";
import { addressTopic, type RawLog, type ReconcileChain } from "./inflight-reconcile";
import { TRANSFER_TOPIC, findTransferFlows, flowKey, resumeFrom } from "./deposit-log";

/**
 * WHY THIS FILE EXISTS. `FlowSource` declared 'chain-log' from the beginning and
 * nothing ever produced one, so every deposit was an inference with no
 * transaction behind it. Contributions are what P&L is measured against, and a
 * deposit that is never recorded is arithmetically indistinguishable from a
 * gain — which is the bug the flows table was created to stop.
 *
 * The two rules worth guarding hardest are the ones that are wrong in opposite
 * directions: a SWAP's USDG leg must never be booked as capital (it would
 * inflate contributions by the account's whole turnover and drive P&L steadily
 * negative), and a real deposit must never be missed or double-counted.
 */

const ACCT = "0x1111111111111111111111111111111111111111" as const;
const OTHER = "0x2222222222222222222222222222222222222222" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

/** A Transfer log shaped exactly as eth_getLogs returns one. */
function transferLog(a: {
  from: string;
  to: string;
  value: bigint;
  txHash: string;
  blockNumber?: number;
  logIndex?: number;
}): RawLog {
  return {
    topics: [TRANSFER_TOPIC, addressTopic(a.from), addressTopic(a.to)],
    data: `0x${a.value.toString(16).padStart(64, "0")}` as Hex,
    transactionHash: a.txHash as Hex,
    ...(a.blockNumber === undefined ? {} : { blockNumber: `0x${a.blockNumber.toString(16)}` as Hex }),
    ...(a.logIndex === undefined ? {} : { logIndex: `0x${a.logIndex.toString(16)}` as Hex }),
  };
}

/** A chain that serves a fixed log set, honouring the address and topic filter. */
function fakeChain(logs: RawLog[], head = 1000n): ReconcileChain {
  return {
    getBlockNumber: async () => head,
    async getLogs(args) {
      return logs.filter((l) => {
        if (args.address.toLowerCase() !== USDG.toLowerCase()) return false;
        return args.topics.every((want, i) => {
          if (want === null || want === undefined) return true;
          const got = l.topics[i];
          const list = Array.isArray(want) ? want : [want];
          return list.some((w) => String(w).toLowerCase() === String(got).toLowerCase());
        });
      });
    },
    getReceiptLogs: async () => null,
  };
}

const scan = (logs: RawLog[], over: Partial<Parameters<typeof findTransferFlows>[0]> = {}) =>
  findTransferFlows({
    chain: fakeChain(logs),
    smartAccount: ACCT,
    usdgToken: USDG,
    fromBlock: 0n,
    toBlock: 1000n,
    knownKeys: new Set<string>(),
    tradeTxHashes: new Set<string>(),
    ...over,
  });

describe("reading flows off the chain", () => {
  it("uses the real Transfer topic", () => {
    // Typed from memory, so pin it against the derivation rather than trusting
    // it. A wrong topic0 matches nothing and the scan reports "no deposits" —
    // silence that looks exactly like an account nobody has funded.
    assert.equal(TRANSFER_TOPIC, toEventSelector("Transfer(address,address,uint256)"));
  });

  it("books an inbound transfer as evidence, with its transaction", async () => {
    const flows = await scan([
      transferLog({ from: OTHER, to: ACCT, value: 250_000_000n, txHash: "0xaa", blockNumber: 500, logIndex: 3 }),
    ]);
    assert.equal(flows.length, 1);
    assert.deepEqual(flows[0], {
      direction: "in",
      amountUsdg6: 250_000_000n,
      txHash: "0xaa",
      blockNumber: 500,
      logIndex: 3,
    });
  });

  it("books an outbound transfer as a withdrawal", async () => {
    const flows = await scan([
      transferLog({ from: ACCT, to: OTHER, value: 5_000_000n, txHash: "0xbb", blockNumber: 501, logIndex: 0 }),
    ]);
    assert.equal(flows.length, 1);
    assert.equal(flows[0]!.direction, "out");
    // This is the leg `transfer-intent` already covers when the AGENT signs it.
    // Read from the chain it also catches a withdrawal made with the owner key,
    // which nothing in the worker ever saw.
    assert.equal(flows[0]!.amountUsdg6, 5_000_000n);
  });

  it("NEVER books a swap's USDG leg as capital", async () => {
    // The single most damaging mistake available here. Every trade moves USDG,
    // so counting fills as contributions would inflate them by the account's
    // whole turnover and drive reported P&L steadily and confidently negative.
    const flows = await scan(
      [
        transferLog({ from: ACCT, to: OTHER, value: 50_000_000n, txHash: "0xfill", blockNumber: 502, logIndex: 1 }),
        transferLog({ from: OTHER, to: ACCT, value: 80_000_000n, txHash: "0xreal", blockNumber: 503, logIndex: 0 }),
      ],
      { tradeTxHashes: new Set(["0xfill"]) },
    );
    assert.equal(flows.length, 1, "the fill must be filtered out, the deposit kept");
    assert.equal(flows[0]!.txHash, "0xreal");
  });

  it("is idempotent — the last block is re-read every pass on purpose", async () => {
    // resumeFrom is INCLUSIVE, so a block already partly recorded is read again.
    // knownKeys is what makes that free of consequence.
    const log = transferLog({
      from: OTHER, to: ACCT, value: 10_000_000n, txHash: "0xcc", blockNumber: 600, logIndex: 2,
    });
    const already = new Set([flowKey("0xcc", 2)]);
    assert.deepEqual(await scan([log], { knownKeys: already }), []);
    // …and without the record, the same log IS booked.
    assert.equal((await scan([log])).length, 1);
  });

  it("tells two transfers in one transaction apart", async () => {
    // The transaction hash alone is not a key.
    const flows = await scan([
      transferLog({ from: OTHER, to: ACCT, value: 1_000_000n, txHash: "0xdd", blockNumber: 700, logIndex: 0 }),
      transferLog({ from: OTHER, to: ACCT, value: 2_000_000n, txHash: "0xdd", blockNumber: 700, logIndex: 1 }),
    ]);
    assert.equal(flows.length, 2);
    assert.deepEqual(flows.map((f) => f.amountUsdg6), [1_000_000n, 2_000_000n]);
  });

  it("ignores a self-transfer, which crosses no boundary", async () => {
    // It also matches BOTH scans, so without this it would be booked as a
    // deposit of its own size.
    assert.deepEqual(
      await scan([
        transferLog({ from: ACCT, to: ACCT, value: 9_000_000n, txHash: "0xee", blockNumber: 800, logIndex: 0 }),
      ]),
      [],
    );
  });

  it("ignores a zero-value transfer", async () => {
    assert.deepEqual(
      await scan([
        transferLog({ from: OTHER, to: ACCT, value: 0n, txHash: "0xff", blockNumber: 801, logIndex: 0 }),
      ]),
      [],
    );
  });

  it("skips a log with no block number rather than booking it", async () => {
    // Without a block it cannot be resumed from, and without an index it cannot
    // be deduplicated. A flow that might be booked twice is worse than one
    // booked late, so this drops it and says so.
    const said: string[] = [];
    const flows = await scan(
      [transferLog({ from: OTHER, to: ACCT, value: 7_000_000n, txHash: "0x01" })],
      { log: (m) => said.push(m) },
    );
    assert.deepEqual(flows, []);
    assert.match(said.join(" "), /no block number or index/);
  });

  it("returns flows in the order the account experienced them", async () => {
    // The high-water mark moves with each flow, so out-of-order booking walks it
    // through a sequence the account never had.
    const flows = await scan([
      transferLog({ from: OTHER, to: ACCT, value: 3n, txHash: "0x3", blockNumber: 902, logIndex: 0 }),
      transferLog({ from: OTHER, to: ACCT, value: 1n, txHash: "0x1", blockNumber: 900, logIndex: 5 }),
      transferLog({ from: OTHER, to: ACCT, value: 2n, txHash: "0x2", blockNumber: 900, logIndex: 9 }),
    ]);
    assert.deepEqual(flows.map((f) => f.amountUsdg6), [1n, 2n, 3n]);
  });

  it("reads nothing from an empty or inverted range", async () => {
    assert.deepEqual(
      await scan([transferLog({ from: OTHER, to: ACCT, value: 5n, txHash: "0x9", blockNumber: 10, logIndex: 0 })], {
        fromBlock: 100n,
        toBlock: 50n,
      }),
      [],
    );
  });
});

describe("where the next scan starts", () => {
  it("opens at the head when nothing has been scanned", () => {
    // At arm, history belongs to the single `inferred` opening-balance row
    // rather than being re-litigated transfer by transfer.
    assert.equal(resumeFrom(null, 5_000n, 1_000n), 5_000n);
  });

  it("re-reads the last recorded block, rather than starting after it", () => {
    // A block can carry several transfers; a crash between two of them would
    // otherwise strand the rest permanently.
    assert.equal(resumeFrom(4_990, 5_000n, 1_000n), 4_990n);
  });

  it("never scans further back than the lookback allows", () => {
    // A long outage must not turn one tick into an unbounded historical scan.
    assert.equal(resumeFrom(10, 5_000n, 1_000n), 4_000n);
  });
});
