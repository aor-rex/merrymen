/**
 * POST-BUY DELIVERY — did the tokens we paid for actually arrive?
 *
 * fills.ts reads what moved from the receipt's `Transfer` logs, and index.ts
 * books that as `basisSource: "receipt"` because the receipt is a settled fact
 * where the quote was a hope. That reasoning is right about the quote and wrong
 * about the receipt: **logs are contract-authored**. A token can emit a
 * perfectly well-formed Transfer of any amount to anyone and move nothing, and
 * every check in netTokenDeltas — topic shape, three topics, a parseable
 * uint256 — is satisfied by a fabrication. So the one source we trusted
 * completely is the one the attacker writes.
 *
 * This is not hypothetical and it is not a different chain. Vex
 * (github.com/Vex-Foundation/Vex) built its own version of this after an
 * incident on 2026-08-10 **on chain 4663**: a confirmed buy of 43,932 TOM
 * emitted a decodable Transfer log, and `balanceOf(wallet)` returned zero. This
 * module is reimplemented from that guard, in merrymen's idiom, with its
 * author's permission.
 *
 * FOUR RULES, taken from theirs, each of which is a way this can go wrong:
 *
 *  1. **Claim a honeypot only on EXACT ZERO.** A balance below what the receipt
 *     claimed has ordinary explanations — a fee-on-transfer token, a prior
 *     position that moved, another op in the same block. Zero after a confirmed
 *     buy has one.
 *  2. **Never fail the swap on this.** The swap already landed; the money is
 *     already spent. Throwing here would turn a completed trade into an
 *     exception path and lose the ledger row, which is the opposite of useful.
 *     This produces an OBSERVATION, and observations do not change outcomes.
 *  3. **A failed read is UNKNOWN, not zero.** `token-stats.ts:74` coerces a
 *     failed balanceOf to `0n` — sound there, where it is summing burn
 *     addresses and a missing one contributes nothing. Here that same coercion
 *     converts an RPC hiccup into an accusation. `recover.ts`'s
 *     `classifyBalance` is the in-repo precedent and this follows it.
 *  4. **Say it as an observation.** The verdict names what was read and what it
 *     means; it does not assert intent.
 *
 * WHAT THIS CANNOT SEE, stated plainly because a guard that oversells itself is
 * worse than none. Reading only AFTER the op means a non-zero balance could be
 * a prior holding while this buy delivered nothing. Catching that needs a
 * pre-balance read on every swap — an extra round trip before every trade, and
 * a race against anything else touching the account. Vex declined that trade
 * and so does this: exact zero is the signal that needs no baseline, and it is
 * the one that matters, because a first buy into a fresh token is exactly the
 * case this exists for.
 */

/** What the chain said about our balance after a buy settled. */
export type Delivery =
  /** The tokens are there. `balanceRaw` is what we hold now, not what arrived. */
  | { kind: "delivered"; balanceRaw: bigint }
  /** Exact zero after a confirmed buy. The receipt described a transfer that did not happen. */
  | { kind: "undelivered" }
  /** We could not ask. Says nothing about the balance — see rule 3. */
  | { kind: "unknown"; why: string };

/**
 * Read the balance and classify it. Injectable rather than taking a client, so
 * every branch is testable without a chain — the discipline fills.ts uses, and
 * the reason its own logic survived a green suite while being wrong about this.
 */
export async function checkDelivery(io: {
  balanceOf: () => Promise<bigint>;
}): Promise<Delivery> {
  let raw: bigint;
  try {
    raw = await io.balanceOf();
  } catch (e) {
    return { kind: "unknown", why: e instanceof Error ? e.message : String(e) };
  }
  // Negative is impossible from a uint256 and would mean the decode is wrong,
  // not that the balance is. Treated as unreadable rather than as zero, because
  // the one thing this must never do is manufacture an accusation.
  if (raw < 0n) return { kind: "unknown", why: "balanceOf returned a negative value" };
  return raw === 0n ? { kind: "undelivered" } : { kind: "delivered", balanceRaw: raw };
}

/** The sentence the owner reads. Present tense, observation, no accusation. */
export function describeDelivery(symbol: string, d: Delivery): string | null {
  switch (d.kind) {
    case "delivered":
      return null; // the ordinary case says nothing — a tape of non-events is noise
    case "undelivered":
      return `${symbol}: the receipt shows tokens transferred to us and balanceOf reads exactly 0. The transfer log is written by the token contract, so a log alone is not delivery. Treat this position as unrecoverable and do not size up.`;
    case "unknown":
      return `${symbol}: couldn't confirm delivery (${d.why.slice(0, 80)}). This is a failed read, NOT a zero balance — the position is unverified, not missing.`;
  }
}

/**
 * How far the settled output fell BELOW the slippage floor we signed, in bps.
 * Null when it did not.
 *
 * merrymen computes `minOut` and hands it to the router, then measures the fill
 * against the QUOTE (`slippageBpsAgainst`) and never against the floor. Those
 * answer different questions: distance from the quote is execution quality, and
 * a number under the floor is something else entirely, because a well-behaved
 * router cannot produce one — it would have reverted. So a positive result here
 * means the amount the router paid out is not the amount that arrived, which is
 * the signature of a fee-on-transfer or rebasing token.
 *
 * Reported, never enforced. The trade has already settled; the value of knowing
 * is that the NEXT decision about this token is made with it.
 */
export function belowFloorBps(floorRaw: bigint, actualRaw: bigint): number | null {
  if (floorRaw <= 0n) return null;
  if (actualRaw >= floorRaw) return null;
  return Number(((floorRaw - actualRaw) * 10_000n) / floorRaw);
}
