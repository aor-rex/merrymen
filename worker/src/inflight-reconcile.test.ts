/**
 * In-flight reconciliation core — proven without a chain via the ReconcileChain
 * seam. The invariants that keep the daily cap honest across an unclean restart:
 *   • a SUCCESSFUL op the ledger never recorded is surfaced as an orphan;
 *   • an op already in the ledger (any status) is NOT re-surfaced;
 *   • a REVERTED op is ignored — it moved nothing and counts toward no cap;
 *   • the notional is the |USDG leg| from the receipt, so a reconciled row
 *     counts exactly as the live path would have counted it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeEventTopics, parseAbi, toHex, type Hex } from "viem";
import { addressTopic, findOrphanOps, type RawLog, type ReconcileChain } from "./inflight-reconcile";
import type { ReceiptLog } from "./fills";

const EP_ABI = parseAbi([
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

const ACCOUNT = "0x00000000000000000000000000000000000acc01" as const;
const ROUTER = "0x00000000000000000000000000000000000f0011" as const;
const USDG = "0x00000000000000000000000000000000000d6000" as const;
const STOCK = "0x00000000000000000000000000000000005704c0" as const;

function opLog(userOpHash: Hex, success: boolean, txHash: Hex): RawLog {
  const topics = encodeEventTopics({
    abi: EP_ABI,
    eventName: "UserOperationEvent",
    args: { userOpHash, sender: ACCOUNT, paymaster: "0x0000000000000000000000000000000000000000" },
  });
  // Non-indexed fields, in order: nonce, success, actualGasCost, actualGasUsed.
  const data = encodeAbiParameters(
    [{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
    [1n, success, 0n, 0n],
  );
  return { topics: topics as readonly Hex[], data, transactionHash: txHash };
}

function transfer(token: string, from: string, to: string, value: bigint): ReceiptLog {
  return { address: token, topics: [TRANSFER_TOPIC, addressTopic(from), addressTopic(to)], data: toHex(value, { size: 32 }) };
}

const h = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

function fakeChain(logs: RawLog[], receipts: Record<string, ReceiptLog[]>): ReconcileChain {
  return {
    async getBlockNumber() {
      return 1000n;
    },
    async getLogs() {
      return logs;
    },
    async getReceiptLogs(txHash) {
      return receipts[txHash.toLowerCase()] ?? null;
    },
  };
}

describe("findOrphanOps", () => {
  it("surfaces a successful op with no ledger row, at its USDG-leg notional", async () => {
    const orphanHash = h(0xaa);
    const tx = h(0xbb);
    const chain = fakeChain(
      [opLog(orphanHash, true, tx)],
      // A buy: 5 USDG leaves the account, stock arrives.
      { [tx.toLowerCase()]: [transfer(USDG, ACCOUNT, ROUTER, 5_000000n), transfer(STOCK, ROUTER, ACCOUNT, 42n)] },
    );
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.userOpHash, orphanHash.toLowerCase());
    assert.equal(orphans[0]!.notionalUsdg6, 5_000000n);
    assert.equal(orphans[0]!.attributed, true);
  });

  it("does NOT re-surface an op already in the ledger", async () => {
    const known = h(0xaa);
    const tx = h(0xbb);
    const chain = fakeChain([opLog(known, true, tx)], { [tx.toLowerCase()]: [transfer(USDG, ACCOUNT, ROUTER, 5_000000n)] });
    const orphans = await findOrphanOps({
      chain,
      smartAccount: ACCOUNT,
      usdgToken: USDG,
      knownOpHashes: new Set([known.toLowerCase()]),
      lookbackBlocks: 1000n,
    });
    assert.equal(orphans.length, 0);
  });

  it("ignores a reverted op — it moved nothing and counts toward no cap", async () => {
    const reverted = h(0xcc);
    const tx = h(0xdd);
    const chain = fakeChain([opLog(reverted, false, tx)], {});
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 0);
  });

  it("records an orphan with no readable USDG leg at notional 0, unattributed", async () => {
    const orphanHash = h(0xee);
    const tx = h(0xff);
    // stock↔stock: no USDG leg on either side.
    const chain = fakeChain([opLog(orphanHash, true, tx)], { [tx.toLowerCase()]: [transfer(STOCK, ACCOUNT, ROUTER, 10n)] });
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.notionalUsdg6, 0n);
    assert.equal(orphans[0]!.attributed, false);
  });

  it("counts a sell (USDG inbound) at its magnitude — the cap is turnover, not net outflow", async () => {
    const orphanHash = h(0x11);
    const tx = h(0x22);
    // A sell: stock leaves, 7 USDG arrives.
    const chain = fakeChain(
      [opLog(orphanHash, true, tx)],
      { [tx.toLowerCase()]: [transfer(STOCK, ACCOUNT, ROUTER, 9n), transfer(USDG, ROUTER, ACCOUNT, 7_000000n)] },
    );
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0]!.notionalUsdg6, 7_000000n);
    assert.equal(orphans[0]!.attributed, true);
  });

  it("de-duplicates the same op appearing twice in the window", async () => {
    const dup = h(0x33);
    const tx = h(0x44);
    const chain = fakeChain([opLog(dup, true, tx), opLog(dup, true, tx)], { [tx.toLowerCase()]: [transfer(USDG, ACCOUNT, ROUTER, 1_000000n)] });
    const orphans = await findOrphanOps({ chain, smartAccount: ACCOUNT, usdgToken: USDG, knownOpHashes: new Set(), lookbackBlocks: 1000n });
    assert.equal(orphans.length, 1);
  });
});
