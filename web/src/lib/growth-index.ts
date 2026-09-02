/**
 * WHAT THE BOOK DID, WITH THE OWNER'S CASH TAKEN OUT OF IT.
 *
 * Its own module with NO IMPORTS, for the reason rank-pnl is: this is a rule the
 * page exists to get right, and a rule buried inside a database read is a rule
 * nobody can test.
 *
 * THE MISTAKE IT REMOVES. `equity_usdg` is a point-in-time balance reading, so
 * the line rises the moment the owner funds the account and falls the moment
 * they take money out. A drawdown measured on that reports the owner's cash
 * management as the agent's losses — and a chart drawn from it shows a deposit
 * as a win. The profile page did both.
 *
 * THE CORRECTION is the standard one for a portfolio that takes deposits: divide
 * each period's flow out before compounding.
 *
 *     growth_t = growth_(t-1) x (E_t - F_t) / E_(t-1)
 *
 * where F_t is the net flow inside that period. What survives moves only when
 * the book itself moves, which is the only thing that is the agent's doing.
 *
 * It starts at 1. A value of 1.08 means the book is up 8% on its own merits,
 * whatever was paid in or out along the way.
 */

export interface EquityPoint {
  /** Unix seconds. */
  at: number;
  /** The balance reading, USDG. */
  v: number;
}

export interface Flow {
  /** Unix seconds. */
  at: number;
  /** Positive in, negative out. */
  signed: number;
}

/**
 * The growth index, one value per equity reading, in the same order.
 *
 * Both inputs must be sorted ascending by `at`; the caller reads them that way
 * out of the ledger and sorting again here would hide a caller that did not.
 */
export function growthIndex(points: readonly EquityPoint[], flows: readonly Flow[]): number[] {
  const out: number[] = [];
  let fi = 0;
  let index = 1;

  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    // Every flow at or before this reading, and none of them counted twice —
    // the pointer only ever moves forward.
    let flow = 0;
    while (fi < flows.length && flows[fi]!.at <= p.at) flow += flows[fi++]!.signed;

    const prev = i === 0 ? null : points[i - 1]!.v;
    // A period that opens at zero has no denominator. That is the first
    // deposit, which is funding rather than a return, and treating it as one
    // produces the infinite first bar that makes every later move invisible.
    if (prev !== null && prev > 0) {
      const r = (p.v - flow) / prev;
      // A non-positive ratio means the book went to zero or the readings are
      // inconsistent. Carrying the index forward unchanged says "this period
      // told us nothing", which is true, rather than zeroing the whole series.
      if (Number.isFinite(r) && r > 0) index *= r;
    }
    out.push(index);
  }

  return out;
}

/**
 * Worst peak-to-trough fall, in basis points, as a POSITIVE number.
 *
 * Give it the growth index, never the equity line. On the equity line a
 * withdrawal is indistinguishable from a loss, which is the whole point of the
 * function above.
 */
export function drawdownBps(series: readonly number[]): number | null {
  if (series.length < 2) return null;
  let peak = series[0]!;
  let worst = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const fall = (peak - v) / peak;
      if (fall > worst) worst = fall;
    }
  }
  return Math.round(worst * 10_000);
}
