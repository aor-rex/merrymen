/**
 * What the book is worth, and what of that the agent actually earned.
 *
 * Pure, and extracted deliberately. All of it lived inside closures in
 * index.ts — a 1,900-line file with zero exports — so nothing here was
 * reachable from a test. That is how a set of money bugs survived next to a
 * green suite: the arithmetic was never wrong in a way a unit test could see,
 * because no unit test could see the arithmetic.
 */

/** Everything that counts toward the book's value, in 6dp USDG units. */
export interface BookParts {
  cashUsdg: bigint;
  vaultUsdg: bigint;
  positionsUsdg: bigint;
  /**
   * Cost sitting in positions we cannot currently price (see quarantine.ts).
   * Carried at COST, not at a mark, because a mark is exactly what we don't
   * have — but dropping it entirely would understate the book by the whole
   * value of the holding.
   */
  quarantinedCostUsdg: bigint;
}

/**
 * The one definition of equity.
 *
 * There used to be two. index.ts summed cash + vault + positions + quarantine
 * for the high-water mark, the performance fee and the drawdown breaker, while
 * addEquity RE-derived the total from three of those four fields for the row it
 * wrote. So the curve everyone reads sat below the figure the fee ratcheted on,
 * permanently, by the quarantined cost.
 *
 * NOTE what is still absent: ETH. Gas is paid from it and it is genuinely part
 * of the account, but there is no ETH/USD feed here, and inventing a rate for
 * this number is not a trade worth making. Gas is recorded per trade in wei
 * instead (trades.gas_wei), and every figure derived from equity is therefore
 * GROSS OF GAS — which the surfaces say out loud.
 */
export function composeEquityUsdg(parts: BookParts): bigint {
  return parts.cashUsdg + parts.vaultUsdg + parts.positionsUsdg + parts.quarantinedCostUsdg;
}

/**
 * Profit: what the book is worth, less what its owner put into it.
 *
 * Returns null when contributions are UNKNOWN, which is not the same as zero. A
 * ledger written before flow tracking existed knows nothing about deposits, and
 * `equity - 0` is the bankroll — reporting that as profit is the original bug.
 * Callers must show nothing rather than something wrong.
 */
export function pnlUsdg(equityUsdg: number, netContributionsUsdg: number | null): number | null {
  if (netContributionsUsdg === null) return null;
  return equityUsdg - netContributionsUsdg;
}

/**
 * Drawdown from the high-water mark, in basis points, floored at zero.
 *
 * The mark is expected to have already moved with any capital that crossed the
 * boundary (see store.adjustAgentHwm) — otherwise a withdrawal reads as a loss
 * of exactly the amount withdrawn and trips the breaker on an owner who simply
 * took their money home.
 */
export function drawdownBps(highWaterMarkUsdg: bigint, equityUsdg: bigint): number {
  if (highWaterMarkUsdg <= 0n) return 0;
  if (equityUsdg >= highWaterMarkUsdg) return 0;
  return Number(((highWaterMarkUsdg - equityUsdg) * 10_000n) / highWaterMarkUsdg);
}

/**
 * Can this tick's book be believed?
 *
 * Any gap means the answer is no, and the tick must write nothing — an unknown
 * booked as a zero becomes the baseline every later figure is measured against.
 * Returns the reasons so the operator is told which, rather than just "paused".
 */
export function bookGaps(args: {
  /** Balances the chain would not report (snapshot.readAccountBalances). */
  unreadBalances: readonly string[];
  /** The whole position read failed — empty means unknown, not unheld. */
  positionsReadFailed: boolean;
  /** Held symbols with a configured feed that did not price this tick. */
  missingPrice: readonly string[];
}): string[] {
  const gaps: string[] = [...args.unreadBalances];
  if (args.positionsReadFailed) gaps.push("positions");
  gaps.push(...args.missingPrice);
  return gaps;
}
