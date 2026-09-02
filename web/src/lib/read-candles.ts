/**
 * CANDLES, FROM THE INDEX THAT ALREADY DESCRIBES THESE POOLS.
 *
 * This repo spent a long time asserting that OHLC was impossible here, reasoning
 * from GeckoPool.poolAddress being null for the 32-byte v4/Pons poolIds that
 * cover most of what is interesting on this chain. That field is about
 * CALLABILITY — somewhere to send an eth_call — and says nothing about whether
 * the index indexes the pool. Asked directly, it does.
 *
 * THE RATE LIMIT IS A TOKEN BUCKET, and the first version of this file modelled
 * it wrongly. Measured: twelve distinct URLs fired fully in parallel all return
 * 200 in about a second; twenty-five serialized one per second immediately
 * afterwards return twenty-five 429s. The burst allowance is at least twelve,
 * the sustained refill is about six a minute, and an empty bucket recovers in
 * roughly twenty seconds. So ARRANGEMENT BUYS NOTHING — the earlier
 * one-at-a-time gate conserved no budget and only made every viewer wait behind
 * the slowest fetch. What conserves budget is asking less often, which is the
 * TTL below.
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

const SPEC: Readonly<
  Record<CandleWindow, { timeframe: string; aggregate: number; seconds: number; label: string }>
> = {
  "15m": { timeframe: "minute", aggregate: 15, seconds: 900, label: "15-minute" },
  "1h": { timeframe: "hour", aggregate: 1, seconds: 3600, label: "hourly" },
  "4h": { timeframe: "hour", aggregate: 4, seconds: 14_400, label: "4-hour" },
  "1d": { timeframe: "day", aggregate: 1, seconds: 86_400, label: "daily" },
};

export interface Candle {
  /** Unix seconds, the bar's opening instant. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /**
   * Quote volume in the bar as the index reports it — NOT a figure to publish.
   *
   * Measured on an on-curve pons-v2 pool: the minute candles inside one hour
   * summed to 1.6x the hour bar containing them, and both exceeded that pool's
   * own volume_usd.h24 by three to five times. A graduated v3 pool reconciled
   * at exactly 1.000. On-curve is most of the population this chart is for, so
   * this number is kept for shape and never rendered as an amount.
   */
  v: number;
}

export interface CandleRead {
  /**
   * ok       — the index answered, the bars are about this token.
   * none     — it answered and this pool has no bars in that window.
   * mismatch — it has bars, but they are about the OTHER side of the pair.
   * refused  — it would not answer, or would not say what the bars are about.
   *
   * The middle two are facts about the pool and are different from each other.
   * The last is a fact about us, and rendering it as either of the others would
   * state something about a token out of our own outage.
   */
  state: "ok" | "none" | "mismatch" | "refused";
  candles: Candle[];
  /** The base token the bars are actually about, lowercased. Null when unread. */
  base: string | null;
  /** What the pair is quoted in, for the caption. Null when unread. */
  quoteSymbol: string | null;
  /** Seconds per bar, so a renderer can find the holes. */
  interval: number;
  /** How the window is said in a sentence. */
  label: string;
  /**
   * How many bar-slots inside the range have no bar.
   *
   * Measured on CHUMP hourly: 421 bars over 792 hours — 47% of the range is
   * missing, in 43 separate runs, the longest 63 hours. A caption that does not
   * mention that is describing a different chart.
   */
  gaps: number;
  /**
   * Seconds of the newest bar that have actually elapsed, against its interval.
   *
   * The newest bar is ALWAYS partial — measured at one minute into an hour, so
   * one sixtieth complete — and drawing it like a settled bar states a high and
   * a low that the rest of the hour has not had a chance to break.
   */
  lastBarAgeSec: number | null;
}

const refused = (): CandleRead => ({
  state: "refused",
  candles: [],
  base: null,
  quoteSymbol: null,
  interval: 0,
  label: "",
  gaps: 0,
  lastBarAgeSec: null,
});

/** Bars per request. 300 is a readable chart and a small response. */
const LIMIT = 300;

/**
 * How long a series is kept — the ONLY thing that conserves rate budget.
 *
 * Long, deliberately. A 4h bar does not change meaningfully inside fifteen
 * minutes, and the alternative is being refused, which costs the reader the
 * whole chart rather than a slightly stale last bar.
 */
const TTL_MS: Readonly<Record<CandleWindow, number>> = {
  "15m": 2 * 60_000,
  "1h": 5 * 60_000,
  "4h": 15 * 60_000,
  "1d": 30 * 60_000,
};

/** A refusal is kept briefly, so a rate-limited page does not earn another. */
const REFUSED_TTL_MS = 30_000;

const cache = new Map<string, { at: number; read: CandleRead }>();
const inFlight = new Map<string, Promise<CandleRead>>();

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
  if (hit) {
    const ttl = hit.read.state === "refused" ? REFUSED_TTL_MS : TTL_MS[window];
    if (Date.now() - hit.at < ttl) return hit.read;
  }

  const running = inFlight.get(key);
  if (running) return running;

  // NO CONCURRENCY GATE. The bucket refills on a clock, not on how the requests
  // are arranged, so serialising conserved nothing and only added latency.
  // Single-flight stays, because two viewers asking for the same pool at the
  // same instant genuinely is one request.
  const started = fetchCandles(poolId, token, window)
    .then((read) => {
      cache.set(key, { at: Date.now(), read });
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
  const { timeframe, aggregate, seconds, label } = SPEC[window];
  const url =
    `https://api.geckoterminal.com/api/v2/networks/robinhood/pools/${poolId}/ohlcv/${timeframe}` +
    // `token` is sent as well as checked below. A mis-resolved address comes
    // back as a 400 enumerating the allowed values, which is a far better
    // failure than a plausible chart of the wrong asset.
    `?aggregate=${aggregate}&limit=${LIMIT}&currency=usd&token=${token}`;

  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      next: { revalidate: 60 },
    });
    if (!res.ok) return refused(); // 429 included, and it is the common one
    const j = (await res.json()) as {
      data?: { attributes?: { ohlcv_list?: unknown[][] } };
      meta?: { base?: { address?: string; symbol?: string }; quote?: { symbol?: string } };
    };

    const list = j.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return refused(); // a shape we cannot read is a refusal

    // THE GUARD FAILS CLOSED. It used to read `if (base && base !== token)`, so
    // a response that named no base at all skipped the check entirely and
    // charted an unverified series — the exact outcome the check exists to
    // prevent. Not being told what the bars are about is a refusal.
    const base = (j.meta?.base?.address ?? "").toLowerCase();
    if (!base) return refused();

    const quoteSymbol = j.meta?.quote?.symbol ?? null;

    // A pool has two sides and the index charts its base. If that is not us,
    // these bars are a price history of the other asset — which is a different
    // fact from the pool having no bars, and gets its own state.
    if (base !== token.toLowerCase()) {
      return {
        state: "mismatch",
        candles: [],
        base,
        quoteSymbol,
        interval: seconds,
        label,
        gaps: 0,
        lastBarAgeSec: null,
      };
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

    if (!candles.length) {
      return {
        state: "none",
        candles: [],
        base,
        quoteSymbol,
        interval: seconds,
        label,
        gaps: 0,
        lastBarAgeSec: null,
      };
    }

    // How much of the range has no bar at all. Measured on one real pool: 47%.
    const first = candles[0]!.t;
    const last = candles[candles.length - 1]!.t;
    const slots = Math.floor((last - first) / seconds) + 1;
    const gaps = Math.max(0, slots - candles.length);

    return {
      state: "ok",
      candles,
      base,
      quoteSymbol,
      interval: seconds,
      label,
      gaps,
      lastBarAgeSec: Math.max(0, Math.floor(Date.now() / 1000) - last),
    };
  } catch {
    return refused();
  }
}
