/**
 * CANDLES, FROM THE INDEX THAT ALREADY DESCRIBES THESE POOLS.
 *
 * This repo spent a long time asserting that OHLC was impossible here, reasoning
 * from GeckoPool.poolAddress being null for the 32-byte v4/Pons poolIds that
 * cover most of what is interesting on this chain. That field is about
 * CALLABILITY — somewhere to send an eth_call — and says nothing about whether
 * the index indexes the pool. Asked directly, it does: probed against our own
 * MICRODUCK fixture's poolId, /ohlcv/hour returns 200 with real candles.
 *
 * THE RATE LIMIT IS THE DESIGN, not a detail. Measured while building this: the
 * FOURTH request in a short burst came back 429. This API is keyless and it
 * refuses hard, so every decision below — the single-flight, the long TTL, the
 * one-at-a-time gate, the refusal to fetch a timeframe nobody asked for — is
 * there to keep a page people click through from being turned away.
 *
 * THE CURRENCY IS EXPLICIT even though usd is the default. Measured on the same
 * pool: currency=usd closes at 0.02125 and currency=token at 0.0000973, because
 * that pool is quoted in NVDA rather than a dollar. A chart that silently picked
 * up the quote-denominated series would disagree with the PRICE cell directly
 * above it by two orders of magnitude and look completely normal doing it.
 */

/** What a caller may ask for, and how the index spells it. */
export const CANDLE_WINDOWS = ["15m", "1h", "4h", "1d"] as const;
export type CandleWindow = (typeof CANDLE_WINDOWS)[number];

const SPEC: Readonly<Record<CandleWindow, { timeframe: string; aggregate: number }>> = {
  "15m": { timeframe: "minute", aggregate: 15 },
  "1h": { timeframe: "hour", aggregate: 1 },
  "4h": { timeframe: "hour", aggregate: 4 },
  "1d": { timeframe: "day", aggregate: 1 },
};

export interface Candle {
  /** Unix seconds, the bar's opening instant. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Quote volume in the bar, USD. */
  v: number;
}

export interface CandleRead {
  /**
   * ok      — the index answered and had bars.
   * none    — the index answered and this pool has no bars in that window.
   * refused — it would not answer: a 429, an outage, or a shape we cannot read.
   *
   * The middle one is a fact about the pool. The last is a fact about us, and
   * rendering it as the middle would state that a token does not trade.
   */
  state: "ok" | "none" | "refused";
  candles: Candle[];
  /** The base token the bars are actually about, lowercased. Null when unread. */
  base: string | null;
  /** What the pair is quoted in, for the caption. Null when unread. */
  quoteSymbol: string | null;
}

const EMPTY: CandleRead = { state: "refused", candles: [], base: null, quoteSymbol: null };

/** Bars per request. 300 is a readable chart and a small response. */
const LIMIT = 300;

/**
 * How long a series is kept.
 *
 * Long, deliberately. A 4h bar does not change meaningfully inside five
 * minutes, and the alternative is being refused — which costs the reader the
 * whole chart rather than a slightly stale last bar.
 */
const TTL_MS: Readonly<Record<CandleWindow, number>> = {
  "15m": 2 * 60_000,
  "1h": 5 * 60_000,
  "4h": 15 * 60_000,
  "1d": 30 * 60_000,
};

const cache = new Map<string, { at: number; read: CandleRead }>();
const inFlight = new Map<string, Promise<CandleRead>>();

/**
 * ONE REQUEST AT A TIME, PROCESS-WIDE.
 *
 * Distinct pools and windows have distinct memo keys, so single-flight alone
 * does not stop four different keys firing together — which is exactly the
 * burst measured to earn a 429. This queues them instead: slower for the fourth
 * viewer, and it does not lose them the chart.
 */
let gate: Promise<unknown> = Promise.resolve();
function queued<T>(run: () => Promise<T>): Promise<T> {
  const next = gate.then(run, run);
  // The gate must not inherit a rejection, or every later fetch is skipped.
  gate = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * The bars for one pool.
 *
 * `poolId` is whatever the index calls the pool — 20 bytes or 32, both work as
 * keys here. `token` is the address the PAGE is about, and it is checked against
 * the bars' own base: a pool's base side is not always the token whose page you
 * are on, and charting the other half of the pair would be a price chart of the
 * wrong asset.
 */
export async function readCandles(
  poolId: string,
  token: string,
  window: CandleWindow = "1h",
): Promise<CandleRead> {
  const key = `${poolId.toLowerCase()}:${window}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS[window]) return hit.read;

  const running = inFlight.get(key);
  if (running) return running;

  const started = queued(() => fetchCandles(poolId, token, window))
    .then((read) => {
      // A refusal is cached briefly too, so a rate-limited page does not spend
      // its next render earning another 429.
      cache.set(key, { at: read.state === "refused" ? Date.now() - TTL_MS[window] + 30_000 : Date.now(), read });
      return read;
    })
    .finally(() => {
      inFlight.delete(key);
    });

  inFlight.set(key, started);
  return started;
}

async function fetchCandles(
  poolId: string,
  token: string,
  window: CandleWindow,
): Promise<CandleRead> {
  const { timeframe, aggregate } = SPEC[window];
  const url =
    `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${poolId}/ohlcv/${timeframe}` +
    `?aggregate=${aggregate}&limit=${LIMIT}&currency=usd`;

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      // Next's own cache on top of the memo. Kept short: the memo is the real
      // guard and two layers disagreeing about freshness is worse than one.
      next: { revalidate: 60 },
    });
    if (!res.ok) return EMPTY; // 429 included, and it is the common one
    const j = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: unknown[][] } };
      meta?: { base?: { address?: string; symbol?: string }; quote?: { symbol?: string } };
    };

    const list = j.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return EMPTY; // a shape we cannot read is a refusal

    const base = (j.meta?.base?.address ?? "").toLowerCase() || null;
    const quoteSymbol = j.meta?.quote?.symbol ?? null;

    // THE BARS MUST BE ABOUT THE TOKEN IN THE URL. A pool has two sides and the
    // index charts its base; if that is not us, these candles are a price chart
    // of the other asset and would be worse than no chart at all.
    if (base && base !== token.toLowerCase()) {
      return { state: "none", candles: [], base, quoteSymbol };
    }

    const candles: Candle[] = [];
    for (const row of list) {
      if (!Array.isArray(row) || row.length < 5) continue;
      const t = num(row[0]);
      const o = num(row[1]);
      const h = num(row[2]);
      const l = num(row[3]);
      const c = num(row[4]);
      const v = num(row[5]) ?? 0;
      // A bar missing any of its four prices is not a bar. Dropping it beats
      // drawing a zero, which on a price axis is a crash that never happened.
      if (t === null || o === null || h === null || l === null || c === null) continue;
      if (t <= 0 || o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
      candles.push({ t, o, h, l, c, v });
    }

    // The index returns newest first; every chart wants the opposite.
    candles.sort((a, b) => a.t - b.t);

    if (!candles.length) return { state: "none", candles: [], base, quoteSymbol };
    return { state: "ok", candles, base, quoteSymbol };
  } catch {
    return EMPTY;
  }
}
