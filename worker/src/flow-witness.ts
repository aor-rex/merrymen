/**
 * WHEN A CASH CHANGE MAY BE BOOKED AS MONEY THE OWNER MOVED.
 *
 * Flow inference (index.ts reconcileFlows) books a change in cash that nothing
 * this process did can explain as a deposit or a withdrawal: a row with source
 * "inferred", the high-water mark moved by the same amount, and a performance
 * fee possible in the same tick. None of it is ever reversed. So "nothing this
 * process did" has to be true, and it was not in two cases:
 *
 *   AN OP WHOSE OUTCOME COULD NOT BE READ. The pre-broadcast 'submitted' row is
 *   written by the executor hook, outside recordTrade, so it never counted as a
 *   write. When the receipt read failed (UserOpUnresolved), or something after
 *   the send threw, no row followed either — and the op, which may land minutes
 *   later, moved cash that no counted write explained. The next reconcile booked
 *   the order's own debit as "📤 withdrawn X USDG (no trade explains this)".
 *
 *   A TRADE WHOSE ROW LANDED BETWEEN THE CASH READ AND THE RECONCILE. The count
 *   was snapshotted at the end of the reconcile, so a row written in that gap
 *   was taken as seen while the cash read had not seen its debit yet; the next
 *   tick booked the debit with no write since. A trade typed in Telegram can
 *   start at any moment of a tick.
 *
 * THE ORDINARY LOOK. The mark is taken just BEFORE the tick reads cash. A change
 * since the last reading is the owner's only when nothing was written since
 * that reading's mark — no row landed or simulated (wrote), and no op sent
 * (sent). A write after the read is then seen by the next look, which is the
 * first to see its cash. A deposit that lands in the same look as a fill is
 * absorbed, not inferred: separating the two would mean trusting fill
 * economics, and that rule is older than this module.
 *
 * THE HOLD, AND WHY IT DEFERS RATHER THAN ABSORBS. While the ledger shows an op
 * of this agent's out with no outcome, its landing time is unknown, so no look
 * can say which change is the owner's. The first version of this hold absorbed
 * every change in the window into the baseline — and an owner's deposit that
 * landed inside it was never booked as capital, while the same tick ran the
 * fee accrual on it as profit (100 USDG of fee on a 500 USDG deposit at 20%).
 *
 * So the window is judged once, when it closes, against the reading it
 * started from:
 *
 *   held       — an op is out (or one that settled did so after this reading's
 *                mark, so its landing may postdate this cash read). Nothing is
 *                booked, the baseline stays where it was, and the tick writes
 *                down no fee and no peak (command-wake.ts tickRatchets) — a
 *                deposit sitting in this equity is not yet capital, and a peak
 *                or a fee taken on it could not be taken back when it is.
 *   settled    — the window closed and could be separated exactly: every op in
 *                it was sent after its baseline was read, each one's own USDG
 *                movement is known (the resolver read it off the op's receipt,
 *                or the op reverted and moved none), and no other row was
 *                written. What is left once those are taken out is the owner's,
 *                and it is booked as capital now — the peak moves with it
 *                before the same tick accrues anything.
 *   waived     — the window closed and could NOT be separated: a trade's row
 *                landed inside it, an op settled with no readable receipt or
 *                was never settled here, or the baseline itself was read while
 *                an op was out. The change is absorbed, as the ordinary rule
 *                does for a fill, and this tick's fee is waived while the peaks
 *                still rise: a deposit in that window is then carried by the
 *                peak and never charged. What it costs: it is not booked as a
 *                contribution, and whatever the window earned is not charged
 *                either.
 *
 * The hold is bounded (UNRESOLVED_OP_HOLD_MS) rather than lasting as long as
 * the row: an op nobody can find stays 'submitted' forever, and inference must
 * not stop for good. A window that closes because its op aged out is waived.
 */

import { netTokenDeltas, type ReceiptLog } from "./fills";

/**
 * How long a 'submitted' row with no outcome is taken to be an op that may
 * still land. Three receipt reads of two minutes each (executor.ts), then the
 * stranded resolver on its five-minute clock, with room: an op not found by
 * then has been dropped, or is one the resolver will settle by hash anyway.
 */
export const UNRESOLVED_OP_HOLD_MS = 30 * 60_000;

/** Whether any of these 'submitted' rows (created_at in unix seconds) is recent enough to still land. */
export function opsStillOut(ops: readonly { createdAt: number }[], nowMs: number): boolean {
  return ops.some((o) => nowMs - o.createdAt * 1000 < UNRESOLVED_OP_HOLD_MS);
}

/** How a look ended, and so what the tick may write down after it (command-wake.ts tickRatchets). */
export type FlowStanding = "settled" | "held" | "waived";

/** The witness's position, taken just before the tick reads cash. */
export interface FlowMark {
  readonly seq: number;
}

/** One reconcile's reads, handed in so the whole decision runs here, where a test runs it. */
export interface FlowLook {
  /** The cash this tick read, after `mark` was taken. */
  cash: bigint;
  mark: FlowMark;
  /** Wall clock, ms. */
  now: number;
  /**
   * This agent's ops out with no outcome — the ledger's 'submitted' rows
   * (store.ts listSubmittedOps). Read first: a failed read throws out of the
   * look and nothing is judged, so the caller retries the same window.
   */
  outstanding: () => Promise<readonly { userOpHash: string; createdAt: number }[]>;
  /** The chain scan. True when it booked every flow of the window itself, and inference stands down. */
  covered: () => Promise<boolean>;
  /** This process's first reading — the accounting anchor's branch (bootstrap-state.ts), not inference. */
  first: () => Promise<void>;
  /** Book a flow as capital, the peak moved with it. Throws when it did not land; nothing is settled then. */
  book: (deltaUsdg: bigint, why: string) => Promise<void>;
}

export interface FlowWitness {
  /** A landed or simulated row — something this process did that moved cash, with its own row. */
  wrote(): void;
  /** An op whose pre-broadcast row landed and which is about to be sent. It can move cash from here on. */
  sent(opHash: string): void;
  /**
   * What an op that was out turned out to move in this account's USDG, signed:
   * 0n when it reverted, null when its receipt could not be read. Call it
   * BEFORE the ledger row is resolved, so no look can see the op settled
   * without knowing what it moved.
   */
  settled(opHash: string, usdgDelta: bigint | null): void;
  /** The position as of now; take it just before the cash read, and hand it to look(). */
  mark(): FlowMark;
  /** Judge one reading, book what is the owner's, and say how it ended. */
  look(reading: FlowLook): Promise<FlowStanding>;
}

type OpEvent = { seq: number; kind: "sent"; op: string } | { seq: number; kind: "settled"; op: string; usdgDelta: bigint | null };

interface Baseline {
  cash: bigint;
  mark: FlowMark;
  /**
   * No op was out at it, and none was sent or settled between its mark and its
   * ledger read — so every op's move is either wholly in this cash or wholly
   * after it.
   */
  clean: boolean;
}

export const NO_TRADE_EXPLAINS = "no trade explains this";

export function createFlowWitness(): FlowWitness {
  let seq = 0;
  let lastRow = 0;
  let lastWrite = 0;
  // Only ops: rows are a count. Pruned to what follows the baseline's mark each
  // time a reading is adopted, so it holds one window's ops at most.
  let ops: OpEvent[] = [];
  let base: Baseline | null = null;
  // Ops seen out since the baseline; null while no look since it was held.
  let held: Set<string> | null = null;

  const adopt = (reading: Baseline, standing: FlowStanding): FlowStanding => {
    base = reading;
    held = null;
    ops = ops.filter((e) => e.seq > reading.mark.seq);
    return standing;
  };

  /**
   * The owner's part of a closed window, or null when it cannot be told apart
   * from what the window's own ops moved.
   */
  const separate = (b: Baseline, seen: ReadonlySet<string>, cash: bigint): bigint | null => {
    // A baseline read while an op was out, or while one was sent or settled,
    // may or may not hold that op's move in its cash.
    if (!b.clean) return null;
    // A row is a trade this process did whose move nobody set aside.
    if (lastRow > b.mark.seq) return null;
    const since = ops.filter((e) => e.seq > b.mark.seq);
    const window = new Set(seen);
    for (const e of since) if (e.kind === "sent") window.add(e.op);
    const moved = new Map<string, bigint | null>();
    for (const e of since) {
      if (e.kind !== "settled") continue;
      // An op this window never had out — an aged-out row, or another process's
      // — moved at a time nobody here knows.
      if (!window.has(e.op)) return null;
      moved.set(e.op, e.usdgDelta);
    }
    let ownMoves = 0n;
    for (const op of window) {
      const d = moved.get(op);
      if (d === undefined || d === null) return null;
      ownMoves += d;
    }
    return cash - b.cash - ownMoves;
  };

  return {
    wrote() {
      seq += 1;
      lastRow = seq;
      lastWrite = seq;
    },
    sent(opHash) {
      seq += 1;
      lastWrite = seq;
      ops.push({ seq, kind: "sent", op: opHash.toLowerCase() });
    },
    settled(opHash, usdgDelta) {
      seq += 1;
      ops.push({ seq, kind: "settled", op: opHash.toLowerCase(), usdgDelta });
    },
    mark: () => ({ seq }),
    async look(l) {
      const listed = await l.outstanding();
      const after = seq; // the position once the ledger answered
      const out = listed
        .filter((o) => l.now - o.createdAt * 1000 < UNRESOLVED_OP_HOLD_MS)
        .map((o) => o.userOpHash.toLowerCase());
      const covered = await l.covered();
      const reading: Baseline = {
        cash: l.cash,
        mark: l.mark,
        clean: out.length === 0 && !ops.some((e) => e.seq > l.mark.seq && e.seq <= after),
      };
      // EXACT BEFORE INFERRED: the scan booked the window's flows off the chain.
      if (covered) return adopt(reading, "settled");
      if (base === null) {
        await l.first();
        return adopt(reading, "settled");
      }
      const b: Baseline = base;
      if (out.length > 0) {
        const seen = held ?? new Set<string>();
        for (const op of out) seen.add(op);
        held = seen;
        return "held";
      }
      if (held === null && b.clean) {
        // THE ORDINARY LOOK.
        if (lastWrite <= b.mark.seq && l.cash !== b.cash) await l.book(l.cash - b.cash, NO_TRADE_EXPLAINS);
        return adopt(reading, "settled");
      }
      // A WINDOW CLOSES. An op of it that settled after this reading's mark may
      // have landed after this cash read: judged on the next look instead.
      const seen: ReadonlySet<string> = held ?? new Set<string>();
      const inWindow = (op: string) => seen.has(op) || ops.some((e) => e.kind === "sent" && e.op === op && e.seq > b.mark.seq);
      if (ops.some((e) => e.kind === "settled" && e.seq > l.mark.seq && inWindow(e.op))) {
        held = new Set(seen);
        return "held";
      }
      const owners = separate(b, seen, l.cash);
      if (owners === null) return adopt(reading, "waived");
      if (owners !== 0n) {
        await l.book(owners, `${NO_TRADE_EXPLAINS} — judged once the order that was out had settled, its own move set aside`);
      }
      return adopt(reading, "settled");
    },
  };
}

/**
 * What one landed op moved in this account's USDG, read off its receipt:
 * signed, and null when the receipt could not be read. The account alone, not
 * its custody contracts — this is set against the account's own cash balance.
 */
export async function opUsdgMoved(
  chain: { getReceiptLogs(txHash: `0x${string}`): Promise<readonly ReceiptLog[] | null> },
  txHash: string,
  account: string,
  usdgToken: string,
): Promise<bigint | null> {
  const logs = await chain.getReceiptLogs(txHash as `0x${string}`).catch(() => null);
  if (!logs) return null;
  return netTokenDeltas(logs, account).get(usdgToken.toLowerCase()) ?? 0n;
}
