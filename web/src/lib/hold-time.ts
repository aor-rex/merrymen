/**
 * HOW LONG THIS AGENT HOLDS WHAT IT BUYS, from its own fills and nothing else.
 *
 * Its own module with NO IMPORTS, for the reason growth-index and rank-pnl have
 * none: this is a figure published about a named agent, and a rule buried in a
 * database read is a rule nobody can test.
 *
 * FIFO BY QUANTITY. Each sell closes the oldest still-open buy of the same coin
 * first, taking as much of it as the sell sold, then the next oldest. Every
 * (buy, sell) piece that meets is one round trip, and the figure is the mean of
 * their holds, UNWEIGHTED. Weighting by quantity would compare raw units across
 * coins with different decimals — an 18-decimal memecoin would outvote a
 * 6-decimal stock token by a factor of 10^12 — so each pairing counts once.
 *
 * WHAT MAKES IT NULL, and why each is a refusal rather than a smaller figure:
 *  - no sell ever met a buy: there is no round trip, so there is no hold to
 *    average. The stats line leaves the term out rather than printing "0s".
 *  - any fill whose side, coin or quantity was not read. FIFO is ORDER-
 *    dependent: one unreadable sell shifts which buy every later sell of that
 *    coin closes, so skipping it would not make the answer smaller, it would
 *    make it a different answer about a different sequence.
 *
 * A sell with nothing open against it is NOT unread. The coin was bought before
 * this period began (a new epoch carries positions over), so that piece is not
 * a round trip within the period — it is simply outside what is measured.
 */

export interface HoldFill {
  side: "buy" | "sell" | null;
  /** The position key: the coin's symbol, else its address. Null when unread. */
  coin: string | null;
  /** Raw token units. Null when unread. */
  qty: bigint | null;
  /** Unix seconds. */
  at: number;
}

/**
 * The mean hold of every FIFO-paired round trip, in seconds, or null.
 *
 * `fills` must be oldest first — the order the ledger read returns — because
 * FIFO is defined over time and sorting here would hide a caller that did not.
 */
export function averageHoldSec(fills: readonly HoldFill[]): number | null {
  const open = new Map<string, { qty: bigint; at: number }[]>();
  let total = 0;
  let pairs = 0;
  for (const f of fills) {
    if (f.side === null || f.coin === null || f.qty === null || f.qty <= 0n || !Number.isFinite(f.at)) return null;
    const key = f.coin.toLowerCase();
    const lots = open.get(key) ?? [];
    if (f.side === "buy") {
      lots.push({ qty: f.qty, at: f.at });
      open.set(key, lots);
      continue;
    }
    let left = f.qty;
    while (left > 0n && lots.length > 0) {
      const lot = lots[0]!;
      const take = lot.qty < left ? lot.qty : left;
      total += Math.max(0, f.at - lot.at);
      pairs += 1;
      lot.qty -= take;
      left -= take;
      if (lot.qty === 0n) lots.shift();
    }
  }
  return pairs > 0 ? total / pairs : null;
}

/**
 * A hold, in the largest two units that say it: "45s", "12m", "3h 20m",
 * "2d 4h". Null in, null out — never "0s" for a figure that does not exist.
 */
export function holdWords(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return null;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}
