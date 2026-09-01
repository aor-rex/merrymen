"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { MarketData } from "@/lib/market";

/**
 * THE TAPE ALONG THE BOTTOM.
 *
 * A trading surface says what the market is doing whether or not you asked, and
 * it says it on every screen. Without this the product reads as a blog about
 * agents; with it, it reads as somewhere trading happens — which is the honest
 * framing, because it is.
 *
 * Cheap by construction: one fetch of /api/market, which is already cached for
 * thirty seconds and already read by /tokens, so a visitor moving between pages
 * pays nothing extra. No animation, no marquee — it SCROLLS if it overflows,
 * because a moving strip of prices is unreadable and this one is meant to be
 * read.
 */

const money = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toPrecision(3)}`;
};

const compact = (n: number | null): string => {
  if (n === null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}k`;
  return `$${Math.round(n)}`;
};

export function Ticker() {
  const [market, setMarket] = useState<MarketData | null>(null);
  const [wall, setWall] = useState<{ turned: number; through: number } | null>(null);

  useEffect(() => {
    let alive = true;
    let first = true;
    const load = async () => {
      // Gate the poll, never the first load: a tab opened in the background
      // would otherwise show an empty strip for ever.
      if (!first && document.visibilityState !== "visible") return;
      first = false;
      try {
        const [m, w] = await Promise.all([
          fetch("/api/market").then((r) => r.json()),
          fetch("/api/wall-tape").then((r) => r.json()).catch(() => null),
        ]);
        if (!alive) return;
        setMarket(m);
        if (w?.counts) setWall({ turned: w.counts.turned, through: w.counts.through });
      } catch {
        /* keep the last good strip rather than blanking it */
      }
    };
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const tokens = (market?.tokens ?? [])
    .filter((t) => t.priceUsd !== null)
    .slice(0, 14);

  if (!tokens.length && !wall) return null;

  return (
    <aside className="mm-ticker" aria-label="Market">
      <div className="mm-ticker-scroll">
        {/* THE FLEET'S OWN NUMBER FIRST. Every other tape on the internet opens
            with BTC; this product's headline fact is the boundary, so it opens
            with how many intents the wall turned back today. */}
        {wall && (
          <Link href="/" className="mm-tick fleet">
            <span className="k">wall</span>
            <b className="mono warn">{wall.turned.toLocaleString("en-US")}</b>
            <span className="mono dim">turned</span>
            <b className="mono up">{wall.through.toLocaleString("en-US")}</b>
            <span className="mono dim">through</span>
          </Link>
        )}

        {tokens.map((t) => {
          const stale = t.priceUpdatedAt !== null && Date.now() / 1000 - t.priceUpdatedAt > 3600;
          return (
            // NO PREFETCH. Fourteen of these sit in the viewport on every
            // page of the product, and /t/[token] is now force-dynamic — so
            // the default would warm fourteen full server renders, each one a
            // ledger read and a market read, every time anyone looks at
            // anything.
            <Link
              key={t.address}
              href={`/t/${t.address}`}
              className="mm-tick"
              prefetch={false}
            >
              <span className="k">{t.symbol}</span>
              <b className="mono">{money(t.priceUsd)}</b>
              {t.volume24hUsd !== null && (
                <span className="mono dim">{compact(t.volume24hUsd)}</span>
              )}
              {/* A stale feed is said, not hidden. A price nobody has updated in
                  an hour is not a current price, and a tape that implies it is
                  is worse than one that admits it. */}
              {t.paused === true ? (
                <span className="mono halted">halted</span>
              ) : stale ? (
                <span className="mono stale" title="This feed has not updated in over an hour">
                  stale
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
