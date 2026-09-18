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

export interface ReviewPoint { at: number; priceUsd: number }

/** A conditional technical thesis from observed history; a spot quote alone is not research. */
export function marketReview(quote: ReviewQuote, previous?: ReviewQuote | null, history: readonly ReviewPoint[] = []): MarketReview | null {
  const { symbol, priceUsd, at } = quote;
  if (!/^[A-Z0-9._-]{1,20}$/.test(symbol) || !Number.isFinite(priceUsd) || priceUsd <= 0 || quote.stale || !Number.isFinite(at)) return null;
  const points = [...new Map(history.filter(p => Number.isFinite(p.at) && Number.isFinite(p.priceUsd) &&
    p.priceUsd > 0 && p.at <= at && p.at >= at - 86400).map(p => [p.at, p])).values()].sort((a,b) => a.at-b.at);
  const first = points[0], last = points.at(-1);
  if (points.length < 3 || !first || !last || last.at-first.at < 900 || at-last.at > 3600) return null;
  const low = Math.min(...points.map(p => p.priceUsd)), high = Math.max(...points.map(p => p.priceUsd));
  if (high === low) return null;
  const mean = points.reduce((sum,p) => sum+p.priceUsd,0)/points.length;
  const changePct = (priceUsd/first.priceUsd-1)*100;
  if (!Number.isFinite(mean) || !Number.isFinite(changePct)) return null;
  const money = (n: number) => '$' + (n >= 1 ? n.toFixed(2) : n.toPrecision(3));
  const hours = ((at-first.at)/3600).toFixed(1);
  const direction = priceUsd > mean ? 'upward' : priceUsd < mean ? 'downward' : 'range-bound';
  const reason = symbol + ' at ' + money(priceUsd) + ' is ' + (changePct >= 0 ? 'up ' : 'down ') +
    Math.abs(changePct).toFixed(2) + '% over the observed ' + hours + 'h window (' + points.length +
    ' oracle rounds; range ' + money(low) + '–' + money(high) + '). My technical bias is ' + direction +
    ' relative to the sampled mean of ' + money(mean) + '. I hold while testing this range over the next hour: ' +
    'two fresh oracle rounds above ' + money(high) + ' would support a bullish follow-up; two below ' + money(low) +
    ' would support a bearish follow-up. A move back across the sampled mean invalidates the directional bias. ' +
    'Oracle marks do not establish executable liquidity; review depth before acting.';
  return { action: 'hold', symbol, reason, evidence_json: JSON.stringify({
    kind: 'technical-review', quote, points, previous: previous?.symbol === symbol ? previous : null,
    observationStart: first.at, observationEnd: last.at, low, high, mean, changePct,
    horizonSec: 3600, confirmationRounds: 2,
  }) };
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

  due(at: number, preparationMs = 0): boolean {
    return at + reviewLookaheadSec(preparationMs) - this.lastDecisionAt >= MAX_DECISION_INTERVAL_SEC;
  }

  prepare(quote: ReviewQuote, preparationMs = 0, history: readonly ReviewPoint[] = [], decisionAt = quote.at): MarketReview | null {
    if (!this.due(decisionAt, preparationMs)) return null;
    return marketReview(quote, this.lastQuote, history);
  }

  recorded(quote: ReviewQuote): void {
    this.lastQuote = quote;
    this.noteDecision(quote.at);
  }
}
