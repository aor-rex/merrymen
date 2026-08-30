/**
 * Which of the last hour's launches anyone is actually trading.
 *
 * THE FUNNEL PROBLEM. Pons runs at roughly 940 launches an hour — the 475 this
 * repo recorded earlier was half the current rate, and it swings between 259
 * and 1,520. Nothing expensive can run per launch: not an LLM, not a page
 * fetch, not a dashboard row. What is needed first is a cheap signal that gets
 * from ~940/hour to a double-digit handful, and it has to be cheap in RPC calls
 * as well as in thought.
 *
 * THE SIGNAL THAT WORKS, and the ones that do not. Measured against the real
 * outcome — a curve selling out, which happens to 1.57% of launches:
 *
 *     >= 25 trades in the first 180s   keeps 12.6%, holds 96% of graduations   7.6x
 *     >= 100 trades in the first 180s  keeps  4.4%,                           16.9x
 *     >= 3 distinct buyers at 60s      keeps 40.6%, holds 100% of graduations
 *     zero trades at 60s               kills 19.3% at no cost to recall
 *
 * And the ones that sound good and are not: a dev buy in the launch transaction
 * (1.1x), having socials (1.0x), the creator's launch history (1.3x). Half of
 * all launches carry a dev buy, so it separates nothing. TRADING is the signal;
 * everything else is decoration.
 *
 * WHY THIS IS ONE CALL AND NOT NINE HUNDRED. Every Pons curve emits its buy
 * event with the same topic0, so a single `eth_getLogs` with NO address filter
 * returns every trade on every curve in the window — about 950 logs across ~58
 * active curves. Per-token polling never happens. That is the whole reason the
 * funnel is affordable at this launch rate.
 */
import type { PublicClient } from "viem";

/**
 * topic0 of a curve BUY, verified on mainnet: it fired 1,151 times across 40
 * sampled curves in one 8,000-block window, far and away the most common event
 * the curves emit. Data words are (quoteIn, tokensOut, fee1, fee2).
 */
export const PONS_BUY_TOPIC =
  "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455" as const;

/** topic0 of a curve SELL. Same shape, words (tokensIn, quoteOut, fee1, fee2). */
export const PONS_SELL_TOPIC =
  "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df" as const;

/** What a curve's tape looked like over the window that was read. */
export interface CurveActivity {
  /** Lowercased curve address. */
  curve: string;
  buys: number;
  sells: number;
  /**
   * Distinct trader ADDRESSES, from the event's own indexed topic1.
   *
   * The honest participation figure, and genuinely different from the trade
   * count: over a sampled 168 buys there were 94 distinct addresses. An earlier
   * version of this counted distinct TRANSACTIONS instead, on the assumption
   * that the event carried no sender — it does — and that proxy measured
   * nothing at all, since every trade is its own transaction (1,825 trades read
   * as 1,822 "traders"). A signal that tracks the thing it is supposed to
   * discriminate against is worse than no signal.
   *
   * Still only a SCREENING figure. Distinct addresses cost more to manufacture
   * than trade count, but on a chain this cheap they do not cost much.
   */
  traders: number;
}

/**
 * The widest window one chain-wide query can cover.
 *
 * The node caps any response at 10,000 logs. MEASURED on this chain, both
 * sides in one OR query: 1,800 blocks returns 1,668 logs and 5,000 returns
 * 4,159 — so roughly 0.85 logs per block, and the cap arrives at about 12,000
 * blocks. Asking for more does not return more: it returns an ERROR, which this
 * module reports as null and a caller could easily mistake for a quiet chain.
 * Found the hard way, by asking for an hour and getting nothing back.
 *
 * 9,000 blocks is ~15 minutes at ~7,600 logs — headroom for the trade rate to
 * rise by a third before the ceiling is anywhere near, which matters because
 * the launch rate has already doubled once since this repo first measured it.
 *
 * THE CONSEQUENCE FOR THE FUNNEL, which is not obvious: activity can only be
 * counted over a window this wide, so a launch older than it will read as
 * untraded whether or not it ever traded. The launch scan must therefore use
 * the SAME window, or the funnel quietly discards everything older.
 */
export const MAX_ACTIVITY_BLOCKS = 9_000n;

/** A log as the node returns it, narrowed to what this module reads. */
export interface ActivityLog {
  address: string;
  topics: readonly string[];
  transactionHash: string | null;
}

/**
 * Tally trades per curve from a window of raw logs.
 *
 * Pure, so it can be tested against captured logs rather than the network.
 * Traders come from the event's own indexed topic1 — the trading address —
 * which is what makes the count mean something. Both sides of the book are
 * counted into the same set: someone who bought and sold is one participant.
 */
export function tallyActivity(logs: readonly ActivityLog[]): Map<string, CurveActivity> {
  const byCurve = new Map<string, { buys: number; sells: number; who: Set<string> }>();
  for (const l of logs) {
    const topic = l.topics[0]?.toLowerCase();
    const isBuy = topic === PONS_BUY_TOPIC;
    const isSell = topic === PONS_SELL_TOPIC;
    if (!isBuy && !isSell) continue;
    const key = l.address.toLowerCase();
    const e = byCurve.get(key) ?? { buys: 0, sells: 0, who: new Set<string>() };
    if (isBuy) e.buys++;
    else e.sells++;
    // topic1 carries the trader. An indexed address sits in the low 20 bytes.
    const who = l.topics[1];
    if (who && who.length >= 42) e.who.add(who.slice(-40).toLowerCase());
    byCurve.set(key, e);
  }
  const out = new Map<string, CurveActivity>();
  for (const [curve, e] of byCurve) {
    out.set(curve, { curve, buys: e.buys, sells: e.sells, traders: e.who.size });
  }
  return out;
}

/**
 * How many blocks go in one `eth_getLogs`.
 *
 * THE NODE CAPS A RESPONSE AT 10,000 LOGS, and this query asks for BOTH sides
 * of every curve trade on the chain. Measured 2026-08-30 over a 9,000-block
 * window: buys alone 6,024, buys+sells over the cap — the node answers
 * `-32000 logs matched by query exceeds limit of 10000` and the whole funnel
 * goes empty. It is not a rate limit and not bad luck: it is deterministic
 * above a certain level of launchpad activity, so it arrives for good the day
 * the chain gets busy and never leaves.
 *
 * 3,000 gives roughly 3x headroom at that measured rate while keeping the
 * window a caller asks for. Chunking rather than shrinking the window is what
 * matters: `ACTIVITY_GATE` counts trades ABSOLUTELY over the window, so halving
 * the window would silently tighten the gate ~2x and change which launches the
 * page is even about.
 */
export const ACTIVITY_CHUNK_BLOCKS = 3_000n;

/**
 * Read every curve trade on the chain over a block window.
 *
 * No address filter, deliberately — that is what makes this affordable. Split
 * into sequential sub-ranges so a busy launchpad cannot exceed the node's
 * 10,000-log response cap; `tallyActivity` merges per curve and dedupes traders
 * through a Set, so chunked input gives byte-identical output to one query.
 *
 * Returns null rather than an empty map when the node refuses, because "nobody
 * traded" and "I could not look" must not be the same answer: the first would
 * silently empty the funnel and make every launch look dead. That applies to a
 * PARTIAL read too — one refused chunk means the tape has a hole in it, and a
 * hole in the tape is a wrong trade count, not a smaller one.
 */
export async function readCurveActivity(
  client: PublicClient,
  lookbackBlocks: bigint,
): Promise<Map<string, CurveActivity> | null> {
  const span = lookbackBlocks > MAX_ACTIVITY_BLOCKS ? MAX_ACTIVITY_BLOCKS : lookbackBlocks;
  try {
    const head = await client.getBlockNumber();
    const from = head > span ? head - span : 0n;
    const all: ActivityLog[] = [];
    for (let lo = from; lo <= head; lo += ACTIVITY_CHUNK_BLOCKS) {
      const hi = lo + ACTIVITY_CHUNK_BLOCKS - 1n > head ? head : lo + ACTIVITY_CHUNK_BLOCKS - 1n;
      const raw = (await client.request({
        method: "eth_getLogs",
        params: [
          {
            fromBlock: `0x${lo.toString(16)}`,
            toBlock: `0x${hi.toString(16)}`,
            // Both sides in one query. An array of topic0s is an OR at the node.
            topics: [[PONS_BUY_TOPIC, PONS_SELL_TOPIC]],
          },
        ],
      } as never)) as ActivityLog[];
      // A chunk at the cap means even 3,000 blocks was too wide — the tally
      // would be silently short, so say nothing rather than something wrong.
      if (raw.length >= 10_000) return null;
      all.push(...raw);
    }
    return tallyActivity(all);
  } catch {
    return null;
  }
}

/** The bar a launch has to clear to be worth anything expensive. */
export interface ActivityGate {
  minTrades: number;
  minTraders: number;
}

/**
 * The measured sweet spot: 12.6% of launches, 96% of the ones that graduate.
 *
 * Tightening to 100 trades buys a 16.9x lift and keeps 4.4%, which is the right
 * setting if the step downstream is expensive enough to care. Loosening below
 * three traders buys nothing: zero-trade launches are already gone, and every
 * graduation in the sample had at least three.
 */
export const ACTIVITY_GATE: ActivityGate = { minTrades: 25, minTraders: 3 };

/** Does this curve's tape clear the bar? Absent activity is a no, not a maybe. */
export function isActive(a: CurveActivity | undefined, gate: ActivityGate = ACTIVITY_GATE): boolean {
  if (!a) return false;
  return a.buys + a.sells >= gate.minTrades && a.traders >= gate.minTraders;
}
