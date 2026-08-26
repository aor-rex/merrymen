/**
 * What a trade ACTUALLY moved, read from the transaction receipt.
 *
 * Until this existed, a live fill was booked from the pre-trade quote — and not
 * even the quote, but `minOut`, the slippage floor. The comment defending it
 * was right about the direction (a fill can come in worse than quoted, never
 * better, so the bound is conservative on PRICE) and wrong about the
 * consequence: the tracked quantity ended up systematically SMALLER than the
 * balance actually sitting on-chain, by roughly slippageBps, on every buy.
 *
 * Every full exit then sells `held.rawBalance` — the real chain balance — which
 * exceeds the tracked basis, so applyFill flags it partlyUnbacked, returns zero
 * realized P&L, and writes NULL. The net effect was that a live round trip
 * could not book realized P&L AT ALL, while the warning blamed a position that
 * "predates basis tracking".
 *
 * Reading the receipt replaces an estimate of a settled fact with the fact.
 * Pure and side-effect free so it can be tested without a chain — the
 * orchestration in index.ts has no seams, which is how the original bug
 * survived a green test suite.
 */

/** ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)`. */
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ReceiptLog {
  address: string;
  topics: readonly string[];
  data: string;
}

/** A 32-byte topic carries an address in its low 20 bytes. */
function addressFromTopic(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * Net movement of every ERC-20 token in or out of `account`, from the receipt's
 * Transfer logs. Positive is received, negative is sent.
 *
 * Netting matters: a swap's receipt contains the router's legs as well as ours,
 * and a token that arrives and leaves within the same operation moved nothing.
 * Filtering to logs that name our account on one side is what makes this the
 * account's own ledger rather than the transaction's.
 */
export function netTokenDeltas(
  logs: readonly ReceiptLog[],
  account: string,
): Map<string, bigint> {
  const me = account.toLowerCase();
  const deltas = new Map<string, bigint>();
  for (const log of logs) {
    if (log.topics.length < 3) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
    const from = addressFromTopic(log.topics[1]!);
    const to = addressFromTopic(log.topics[2]!);
    if (from !== me && to !== me) continue;
    let value: bigint;
    try {
      value = BigInt(log.data);
    } catch {
      continue; // malformed data field — better skipped than guessed at
    }
    const token = log.address.toLowerCase();
    let delta = deltas.get(token) ?? 0n;
    if (to === me) delta += value;
    if (from === me) delta -= value;
    deltas.set(token, delta);
  }
  return deltas;
}

export interface ReceiptFill {
  side: "buy" | "sell";
  symbol: string;
  /** Stock-token units, 18dp — what the account's balance actually changed by. */
  qtyRaw: bigint;
  /** USDG, 6dp. Positive on both sides: paid on a buy, received on a sell. */
  cashUsdg: bigint;
  priceUsd: number;
}

/**
 * Turn the account's net movements into a fill, or null when the pair cannot be
 * attributed. Returning null is deliberate — a fill we cannot explain must not
 * be guessed at, because a wrong cost basis is worse than a missing one.
 */
export function fillFromDeltas(opts: {
  deltas: Map<string, bigint>;
  usdgToken: string;
  stockToken: string;
  symbol: string;
}): ReceiptFill | null {
  const usdgDelta = opts.deltas.get(opts.usdgToken.toLowerCase()) ?? 0n;
  const stockDelta = opts.deltas.get(opts.stockToken.toLowerCase()) ?? 0n;
  if (usdgDelta === 0n || stockDelta === 0n) return null;

  let side: "buy" | "sell";
  let qtyRaw: bigint;
  let cashUsdg: bigint;
  if (usdgDelta < 0n && stockDelta > 0n) {
    side = "buy";
    qtyRaw = stockDelta;
    cashUsdg = -usdgDelta;
  } else if (usdgDelta > 0n && stockDelta < 0n) {
    side = "sell";
    qtyRaw = -stockDelta;
    cashUsdg = usdgDelta;
  } else {
    // Both legs moved the same way. That is not a swap, and whatever it is, we
    // have no basis for calling it one.
    return null;
  }

  // Stock tokens are 18dp, USDG is 6dp — the same convention bookFill uses.
  const priceUsd = Number(cashUsdg) / 1e6 / (Number(qtyRaw) / 1e18);
  return { side, symbol: opts.symbol, qtyRaw, cashUsdg, priceUsd };
}

/**
 * How far the fill landed from what the quote promised, in basis points.
 * Positive means WORSE than quoted. Recorded per trade so the flat slippage
 * setting can eventually be replaced by a measured distribution instead of a
 * guess — today it is a single 1% constant applied to a $5 trade and a $5,000
 * one alike.
 */
export function slippageBpsAgainst(quotedOut: bigint, actualOut: bigint): number | null {
  if (quotedOut <= 0n) return null;
  const diff = quotedOut - actualOut;
  return Number((diff * 10_000n) / quotedOut);
}
