import { MAX_DECISION_INTERVAL_SEC, reviewLookaheadSec } from "./decision-cadence";

export interface ReviewQuote {
  symbol: string;
  priceUsd: number;
  stale: boolean;
  at: number;
}

export interface MarketReview {
  action: "hold";
  symbol: string;
  reason: string;
  evidence_json: string;
}

/**
 * A conservative research view when the trading strategy has no order. Prices
 * are observations, never forecasts. This module cannot propose an order and
 * neither an outage nor a private portfolio balance becomes public prose.
 */
export function marketReview(quote: ReviewQuote, previous?: ReviewQuote | null): MarketReview | null {
  const { symbol, priceUsd, at } = quote;
  if (!/^[A-Z0-9._-]{1,20}$/.test(symbol) || !Number.isFinite(priceUsd) || priceUsd <= 0 || quote.stale || !Number.isFinite(at)) return null;
  const price = (n: number) => `$${n >= 1 ? n.toFixed(2) : n.toPrecision(3)}`;
  const comparable = previous && previous.symbol === symbol && !previous.stale &&
    Number.isFinite(previous.priceUsd) && previous.priceUsd > 0 && previous.at < at &&
    at - previous.at <= MAX_DECISION_INTERVAL_SEC * 3;
  let reason: string;
  if (comparable) {
    const change = (priceUsd / previous.priceUsd - 1) * 100;
    if (Math.abs(change) < 0.1) {
      reason = `${symbol}'s observed quote is unchanged near ${price(priceUsd)}. My view is neutral; I want a sustained move away from this level before changing exposure.`;
    } else if (change > 0) {
      reason = `${symbol} rose ${change.toFixed(1)}% to ${price(priceUsd)} since my last review. I'm waiting for another higher quote; falling back below ${price(previous.priceUsd)} would weaken the momentum case.`;
    } else {
      reason = `${symbol} fell ${Math.abs(change).toFixed(1)}% to ${price(priceUsd)} since my last review. I'm waiting for it to stabilize; reclaiming ${price(previous.priceUsd)} would be the first sign of recovery.`;
    }
  } else {
    reason = `${symbol} at ${price(priceUsd)} is my reference for the next review. My view is neutral until fresh quotes establish direction; a sustained move above this level would support a bullish case.`;
  }
  return {
    action: "hold", symbol, reason,
    evidence_json: JSON.stringify({ kind: "market-review", quote, previous: comparable ? previous : null }),
  };
}

/** State is advanced only after the caller successfully records a review. */
export class MarketReviewClock {
  private lastDecisionAt = -Infinity;
  private lastQuote: ReviewQuote | null = null;

  get nextAt(): number | null {
    return Number.isFinite(this.lastDecisionAt) ? this.lastDecisionAt + MAX_DECISION_INTERVAL_SEC : null;
  }

  noteDecision(at: number): void {
    this.lastDecisionAt = at;
  }

  prepare(quote: ReviewQuote, preparationMs = 0): MarketReview | null {
    if (quote.at + reviewLookaheadSec(preparationMs) - this.lastDecisionAt < MAX_DECISION_INTERVAL_SEC) return null;
    return marketReview(quote, this.lastQuote);
  }

  recorded(quote: ReviewQuote): void {
    this.lastQuote = quote;
    this.noteDecision(quote.at);
  }
}
