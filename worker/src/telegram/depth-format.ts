/**
 * Render a pool depth map as chat text.
 *
 * Pure on purpose: the chain read lives in index.ts where the client is, and
 * this takes the finished map. That means the wording — which is the part that
 * can mislead — is testable without a network.
 *
 * The framing rule for everything here: say what was measured, not what it
 * implies. "Where the money sits" is true. "Buyers are stacked here" is a claim
 * about intent that a v3 range does not support, because a range is a two-sided
 * quote that flips as price crosses it, and its owner can withdraw in a block.
 */

import { cashToNumber, cashWithinBps, type PoolDepth } from "../venues/depth";
import { esc } from "./api";

/** Compact money — chat is narrow and nobody needs cents on a $500k figure. */
export function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `$${n.toFixed(0)}`;
}

export function price8(v: bigint): string {
  const n = Number(v) / 1e8;
  return `$${n.toFixed(n >= 100 ? 2 : n >= 1 ? 3 : 6)}`;
}

export interface DepthReadContext {
  symbol: string;
  depth: PoolDepth;
  /** Robinhood's published NBBO mid, when it answered. A cross-check from a
   * completely independent source is worth more than another on-chain number. */
  nbboMid?: number | null;
  /** The pool's fee tier, in Uniswap units — hundredths of a bip, so 500 is
   * 0.05%, NOT 5%. Named plainly because `feeBps` invited exactly that error. */
  fee?: number;
}

export function formatDepth(ctx: DepthReadContext): string {
  const { depth: d, symbol } = ctx;
  const spot = Number(d.spot8) / 1e8;
  const cash = (raw: bigint) => money(cashToNumber(raw, d.cashDecimals));
  const lines: string[] = [];

  lines.push(`<b>${esc(symbol)}</b> — ${price8(d.spot8)} in the pool`);

  if (typeof ctx.nbboMid === "number" && Number.isFinite(ctx.nbboMid) && ctx.nbboMid > 0) {
    const bps = ((spot - ctx.nbboMid) / ctx.nbboMid) * 10_000;
    lines.push(
      `Robinhood's quote: $${ctx.nbboMid.toFixed(2)} — the pool is ${bps >= 0 ? "+" : ""}${bps.toFixed(1)}bps off it`,
    );
  }

  // The number a trader actually wants: not "how much is in there" but "how much
  // can I do before I move it".
  lines.push("");
  lines.push("<b>Trade without moving it more than 0.5%</b>");
  lines.push(`  buy  ${cash(cashWithinBps(d, 50, "ask"))}`);
  lines.push(`  sell ${cash(cashWithinBps(d, 50, "bid"))}`);

  const zones = d.zones.slice(0, 5);
  if (zones.length > 0) {
    lines.push("");
    lines.push(`<b>Where the money sits</b> (±${(d.bandBps / 100).toFixed(0)}%)`);
    for (const z of zones) {
      const label = z.side === "support" ? "support   " : "resistance";
      const away = z.distanceBps < 25 ? "at spot" : `${(z.distanceBps / 100).toFixed(1)}% away`;
      lines.push(
        `  ${label} ${price8(z.priceLow8)}–${price8(z.priceHigh8)}  ${cash(z.cashRaw)}  ${(z.shareBps / 100).toFixed(0)}% of that side, ${away}`,
      );
    }
  } else {
    lines.push("");
    lines.push("No liquidity clusters worth naming — this pool is flat across the band.");
  }

  if (d.truncated) {
    // Never let a partial map read as a complete one. Every total above is a
    // floor when this fires.
    lines.push("");
    lines.push("<i>The band ran past the read limit — the figures above are floors, not totals.</i>");
  }

  lines.push("");
  lines.push(
    `<i>Read live from the ${esc(symbol)}/USDG pool${ctx.fee ? ` (${(ctx.fee / 10_000).toFixed(2)}% tier)` : ""}. ` +
      "This is posted liquidity, not resting orders — an LP can pull it in a block, and each range is a " +
      "two-sided quote rather than someone's bid. It is also one pool; a trade may route across several.</i>",
  );

  return lines.join("\n");
}

/** What to say when the token has no pool worth reading. */
export function formatNoDepth(symbol: string): string {
  return (
    `<b>${esc(symbol)}</b> — no pool deep enough to map.\n\n` +
    "<i>Either nothing is listed against USDG, or what is there holds too little to say anything " +
    "honest about support and resistance.</i>"
  );
}
