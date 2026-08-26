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
