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
 *   tick read the debit with no write since, and booked it. A trade typed in
 *   Telegram can start at any moment of a tick.
 *
 * So:
 *
 *   wrote()   — anything that can move cash: an op about to be sent (counted
 *               before it goes, so it can never land uncounted) and a landed or
 *               simulated row.
 *   mark()    — taken just BEFORE the tick reads cash, and settled with that
 *               reading. A write after the read is then seen by the next look,
 *               which is the first to see its cash.
 *   opsOutstanding — whether an op of this agent's is out with no outcome
 *               (opsStillOut over the ledger's 'submitted' rows). Its landing
 *               time is unknown, so no look while it is out, and no look that
 *               follows one where it was out, can say the change is the owner's:
 *               the op may have landed inside that window.
 *
 * WHAT IT COSTS. A deposit that arrives while one of those holds is absorbed
 * into the baseline, not booked — the rule every fill already had ("a deposit
 * that lands in the same tick as a fill is NOT inferred"), now also true for
 * the look after an op it could not read. That is why the hold is bounded
 * (UNRESOLVED_OP_HOLD_MS) rather than lasting as long as the row: an op nobody
 * can find stays 'submitted' forever, and inference must not stop for good.
 */

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

export interface FlowWitness {
  /** Something this process did that can move cash. */
  wrote(): void;
  /** The count as of now; take it just before the cash read, and settle with it. */
  mark(): number;
  /**
   * Whether a change since the last settled reading is unexplained — nothing
   * written since that reading's mark, and no op out then or now. False before
   * any reading has been settled.
   */
  unexplained(now: { opsOutstanding: boolean }): boolean;
  /** Take this reading as the baseline: its mark, and whether an op was out at it. */
  settle(reading: { mark: number; opsOutstanding: boolean }): void;
}

export function createFlowWitness(): FlowWitness {
  let writes = 0;
  let since: { mark: number; opsOutstanding: boolean } | null = null;
  return {
    wrote: () => {
      writes += 1;
    },
    mark: () => writes,
    unexplained: (now) => since !== null && writes === since.mark && !since.opsOutstanding && !now.opsOutstanding,
    settle: (reading) => {
      since = { mark: reading.mark, opsOutstanding: reading.opsOutstanding };
    },
  };
}
