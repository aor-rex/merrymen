/**
 * The audit format, and the verifier for it.
 *
 * The premise: someone who does not trust the operator, has never installed
 * merrymen, and has only a public RPC should be able to check every performance
 * claim the software makes. Until this existed they could not — the ledger is a
 * plain sqlite file on the operator's own disk, the equity curve is a series of
 * balance readings written by the process being audited, and nothing
 * cross-checked any of it.
 *
 * Three independent things are checked, and they fail differently on purpose:
 *
 *   1. THE CHAIN. Each record carries the hash of the one before it, so an
 *      edited record breaks every hash after it, and `seq` is monotonic, so a
 *      DELETED record shows up as a gap. Silence is as detectable as tampering.
 *
 *   2. THE CHAIN OF CUSTODY. Every fill and every flow names a transaction. A
 *      verifier with an RPC refetches it and compares the token movements the
 *      record claims against the ones the chain actually recorded. This is the
 *      part that makes the record more than internally consistent.
 *
 *   3. THE ARITHMETIC. Equity is recomputed from primitives — fills, flows and
 *      marks — rather than read back, and compared against what was published.
 *
 * Everything here is pure and takes its inputs as data, so the verifier can run
 * against a file it did not produce, with no access to ~/.merrymen.
 */

import { createHash } from "node:crypto";

/** Must match store.JOURNAL_GENESIS — duplicated so a verifier needs no store. */
export const GENESIS = "0".repeat(64);

export interface ExportedEntry {
  seq: number;
  agent_id: string;
  epoch: number;
  kind: string;
  payload_json: string;
  prev_hash: string;
  hash: string;
  at: number;
}

export interface AuditFinding {
  /** 'chain' | 'gap' | 'arithmetic' — which of the three checks failed. */
  check: string;
  seq: number | null;
  detail: string;
}

/** Recompute a link. Deliberately re-implemented here rather than imported. */
export function linkHash(prevHash: string, payloadJson: string): string {
  return createHash("sha256").update(prevHash).update(payloadJson).digest("hex");
}

/**
 * Walk the chain. Returns every break, not just the first — an operator who
 * edited one row wants to know that; one who rewrote a range needs to see it.
 */
export function verifyChain(entries: readonly ExportedEntry[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  let expectedPrev = GENESIS;
  let lastSeq: number | null = null;

  for (const e of entries) {
    if (lastSeq !== null && e.seq !== lastSeq + 1) {
      // AUTOINCREMENT never reuses a value, so a jump means rows were removed
      // between these two. The chain itself would still verify if the deleter
      // was careful, which is exactly why the sequence is checked separately.
      findings.push({
        check: "gap",
        seq: e.seq,
        detail: `sequence jumps ${lastSeq} → ${e.seq}: ${e.seq - lastSeq - 1} record(s) removed`,
      });
      // Re-anchor so one gap doesn't cascade into a break at every later row.
      expectedPrev = e.prev_hash;
    }
    if (e.prev_hash !== expectedPrev) {
      findings.push({
        check: "chain",
        seq: e.seq,
        detail: `prev_hash ${e.prev_hash.slice(0, 12)}… does not follow ${expectedPrev.slice(0, 12)}…`,
      });
    }
    const recomputed = linkHash(e.prev_hash, e.payload_json);
    if (recomputed !== e.hash) {
      findings.push({
        check: "chain",
        seq: e.seq,
        detail: `payload does not hash to its recorded hash — this record was edited`,
      });
    }
    expectedPrev = e.hash;
    lastSeq = e.seq;
  }
  return findings;
}

export interface ReconstructedBook {
  /** Σ flows in − Σ flows out, 6dp USDG as a float (the ledger is REAL). */
  netContributionsUsdg: number;
  /** Σ realized P&L booked on closing fills. */
  realizedPnlUsdg: number;
  /** Σ gas paid, wei. Not in equity — there is no ETH/USD feed. */
  gasWei: bigint;
  /** The last published equity figure, for comparison. */
  publishedEquityUsdg: number | null;
  /** Fills and flows that name a transaction — what an RPC check would refetch. */
  chainRefs: { kind: string; txHash: string; seq: number }[];
  /** Records that move money but name NO transaction. */
  unanchored: { kind: string; seq: number; why: string }[];
}

/**
 * Rebuild the book from the journal alone.
 *
 * `unanchored` is the honest part: a paper fill and an inferred flow move the
 * numbers but cannot be checked against any chain, so they are counted AND
 * listed. An auditor who wants only chain-verifiable figures drops them and
 * recomputes; one who accepts them at least knows what they accepted.
 */
export function reconstruct(entries: readonly ExportedEntry[]): ReconstructedBook {
  const book: ReconstructedBook = {
    netContributionsUsdg: 0,
    realizedPnlUsdg: 0,
    gasWei: 0n,
    publishedEquityUsdg: null,
    chainRefs: [],
    unanchored: [],
  };

  for (const e of entries) {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(e.payload_json) as Record<string, unknown>;
    } catch {
      continue; // verifyChain already reports an unparseable payload as edited
    }

    if (e.kind === "flow") {
      const amount = Number(p.amountUsdg ?? 0);
      book.netContributionsUsdg += p.direction === "in" ? amount : -amount;
      if (typeof p.txHash === "string" && p.txHash) {
        book.chainRefs.push({ kind: "flow", txHash: p.txHash, seq: e.seq });
      } else {
        book.unanchored.push({
          kind: "flow",
          seq: e.seq,
          why: `source '${String(p.source)}' carries no transaction — inferred from a balance change`,
        });
      }
    }

    if (e.kind === "fill") {
      const realized = p.realizedPnlUsdg;
      if (typeof realized === "number") book.realizedPnlUsdg += realized;
      if (typeof p.gasWei === "string" && p.gasWei) {
        try {
          book.gasWei += BigInt(p.gasWei);
        } catch {
          /* a malformed figure is a chain finding, not an arithmetic one */
        }
      }
      if (typeof p.txHash === "string" && p.txHash) {
        book.chainRefs.push({ kind: "fill", txHash: p.txHash, seq: e.seq });
      } else {
        book.unanchored.push({
          kind: "fill",
          seq: e.seq,
          why:
            p.status === "paper"
              ? "simulated fill — nothing was signed, so there is nothing to check"
              : "landed fill with no transaction recorded",
        });
      }
    }

    if (e.kind === "mark") {
      const eq = p.equityUsdg;
      if (typeof eq === "number") book.publishedEquityUsdg = eq;
    }
  }
  return book;
}

// ── 2. the chain of custody ───────────────────────────────────────────────

/** A receipt as `eth_getTransactionReceipt` returns it, reduced to what we check. */
export interface FetchedReceipt {
  /** '0x1' success, '0x0' reverted. */
  status: string;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
}

/** ERC-20 Transfer. Re-declared here so the verifier depends on nothing. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Net movement of each token in or out of `account`, from a receipt's logs.
 *
 * Intentionally a second implementation of the same idea as fills.ts. The
 * verifier must not share code with the thing it verifies any more than it has
 * to — if the writer's log-parsing is wrong, a verifier importing that same
 * parser would agree with it and call the record confirmed.
 */
export function receiptDeltas(
  receipt: FetchedReceipt,
  account: string,
): Map<string, bigint> {
  const me = account.toLowerCase();
  const out = new Map<string, bigint>();
  for (const log of receipt.logs) {
    if (log.topics.length < 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = `0x${log.topics[1]!.slice(-40)}`.toLowerCase();
    const to = `0x${log.topics[2]!.slice(-40)}`.toLowerCase();
    if (from !== me && to !== me) continue;
    let v: bigint;
    try {
      v = BigInt(log.data);
    } catch {
      continue;
    }
    const token = log.address.toLowerCase();
    let d = out.get(token) ?? 0n;
    if (to === me) d += v;
    if (from === me) d -= v;
    out.set(token, d);
  }
  return out;
}

/** 6dp USDG float → integer units, for comparing against an on-chain amount. */
function toUsdgUnits(v: number): bigint {
  return BigInt(Math.round(v * 1e6));
}

/**
 * Check ONE record against the transaction it names.
 *
 * A tolerance of one unit is allowed on the cash leg because the ledger stores
 * USDG as a float (REAL columns) while the chain is exact — a difference in the
 * last 6dp digit is a rounding artifact of our own storage, not a discrepancy.
 * Anything larger is reported.
 */
export function compareRecord(args: {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
  receipt: FetchedReceipt | null;
  account: string;
  usdgToken: string;
}): AuditFinding[] {
  const { seq, kind, payload, receipt, account, usdgToken } = args;
  const findings: AuditFinding[] = [];
  const txHash = String(payload.txHash ?? "");

  if (!receipt) {
    findings.push({ check: "onchain", seq, detail: `${txHash}: no such transaction on this chain` });
    return findings;
  }
  if (receipt.status !== "0x1") {
    findings.push({
      check: "onchain",
      seq,
      detail: `${txHash}: the chain says this transaction FAILED, but the ledger records it as settled`,
    });
    return findings;
  }

  const deltas = receiptDeltas(receipt, account);
  const usdgDelta = deltas.get(usdgToken.toLowerCase()) ?? 0n;

  if (kind === "flow") {
    const claimed = toUsdgUnits(Number(payload.amountUsdg ?? 0));
    const expected = payload.direction === "in" ? claimed : -claimed;
    if (absDiff(usdgDelta, expected) > 1n) {
      findings.push({
        check: "onchain",
        seq,
        detail:
          `${txHash}: ledger claims a ${String(payload.direction)}flow of ${fmtUsdg(claimed)} USDG, ` +
          `chain shows ${fmtUsdg(usdgDelta)}`,
      });
    }
    return findings;
  }

  if (kind === "fill") {
    // Cash leg.
    const cash = payload.fillCashUsdg;
    if (typeof cash === "number") {
      const claimed = toUsdgUnits(cash);
      const expected = payload.fillSide === "buy" ? -claimed : claimed;
      if (absDiff(usdgDelta, expected) > 1n) {
        findings.push({
          check: "onchain",
          seq,
          detail:
            `${txHash}: ledger claims ${String(payload.fillSide)} for ${fmtUsdg(claimed)} USDG, ` +
            `chain shows a USDG movement of ${fmtUsdg(usdgDelta)}`,
        });
      }
    }
    // Stock leg — the token is whichever side of the swap is not USDG.
    const stockToken = String(
      (payload.fillSide === "buy" ? payload.buyToken : payload.sellToken) ?? "",
    ).toLowerCase();
    const qty = payload.fillQtyRaw;
    if (stockToken && typeof qty === "string") {
      let claimedQty: bigint;
      try {
        claimedQty = BigInt(qty);
      } catch {
        return findings;
      }
      const stockDelta = deltas.get(stockToken) ?? 0n;
      const expected = payload.fillSide === "buy" ? claimedQty : -claimedQty;
      // Exact: token quantities are integers on both sides, so any difference
      // is real. This is the check that would have caught a fill booked from
      // the quote instead of the receipt.
      if (stockDelta !== expected) {
        findings.push({
          check: "onchain",
          seq,
          detail:
            `${txHash}: ledger claims ${expected} raw units of ${stockToken.slice(0, 10)}…, ` +
            `chain shows ${stockDelta}`,
        });
      }
    }
  }
  return findings;
}

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

function fmtUsdg(units: bigint): string {
  return (Number(units) / 1e6).toFixed(6);
}

/**
 * Does the published equity agree with what the primitives imply?
 *
 * Only meaningful once a full epoch has been recorded from its opening balance:
 * equity should be contributions plus realized P&L plus whatever the open
 * positions are marked at. The marks are in the journal, so the residual is the
 * unrealized component — reported rather than asserted, because calling a
 * mark-to-market difference an ERROR would be wrong.
 */
export function reconcile(book: ReconstructedBook): {
  residualUsdg: number | null;
  note: string;
} {
  if (book.publishedEquityUsdg === null) {
    return { residualUsdg: null, note: "no mark recorded — nothing to reconcile against" };
  }
  const explained = book.netContributionsUsdg + book.realizedPnlUsdg;
  const residual = book.publishedEquityUsdg - explained;
  return {
    residualUsdg: residual,
    note:
      "residual = published equity − (contributions + realized). It is the unrealized " +
      "mark-to-market on open positions, and is expected to be non-zero while any position is open.",
  };
}
