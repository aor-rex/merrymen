"use client";

import { useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/read-candles";

/**
 * THE PRICE CHART, drawn by TradingView's lightweight-charts.
 *
 * The one place in this product where a third-party renderer earns its bytes.
 * Every other chart here is server-rendered SVG, and that is right for a
 * sparkline or an oracle series — but a candle chart is a crosshair, a
 * scrollable time axis, a price scale that re-fits as you pan, and a tooltip
 * that follows the pointer. Hand-rolling those is a month of work to arrive
 * where a 45kB library already is.
 *
 * IT IS LOADED ONLY WHEN A CHART ACTUALLY DRAWS. The import is dynamic and
 * inside an effect, so a token page with no candles — every stock token, every
 * coin the index has never returned — ships none of it.
 *
 * IT IS NOT SERVER-RENDERED, which is the cost. The bars arrive with the HTML
 * and the canvas paints on hydration, so this reserves its own height up front:
 * a chart that pushes the theses down when it appears is the layout shift the
 * rest of the redesign has been removing.
 */

/** Colours come from the design system, read off the element at mount. */
function tokenColour(el: HTMLElement, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export function CandleChart({
  candles,
  height = 320,
}: {
  candles: Candle[];
  height?: number;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el || candles.length === 0) return;

    let disposed = false;
    // Kept out of the closure's type so the dynamic import stays the only
    // reference to the library.
    let chart: { remove: () => void; applyOptions: (o: unknown) => void } | null = null;

    void (async () => {
      try {
        const lib = await import("lightweight-charts");
        if (disposed || !box.current) return;

        const up = tokenColour(el, "--mm-up", "#34d399");
        const down = tokenColour(el, "--mm-down", "#fb7185");
        const grid = tokenColour(el, "--mm-edge", "#232729");
        const text = tokenColour(el, "--mm-faint", "#757068");

        const c = lib.createChart(el, {
          height,
          layout: {
            // The page's own ground, not the library's white default.
            background: { color: "transparent" },
            textColor: text,
            fontFamily: getComputedStyle(el).fontFamily,
            fontSize: 10,
            attributionLogo: false,
          },
          grid: {
            vertLines: { color: grid },
            horzLines: { color: grid },
          },
          rightPriceScale: { borderColor: grid },
          timeScale: { borderColor: grid, timeVisible: true, secondsVisible: false },
          crosshair: { mode: lib.CrosshairMode.Normal },
          handleScale: { axisPressedMouseMove: false },
          localization: {
            // A coin here can trade at 2.8e-6, and the library's default
            // formatter renders that as $0.00 — the same failure as showing a
            // null as zero, a real number displayed as nothing.
            //
            // The first clause is the other half of that. The scale computes
            // gridlines by arithmetic, so its bottom line lands on a floating
            // point crumb like -1.73e-18, and toPrecision printed it verbatim.
            // Anything below a hundredth of a cent on this axis is zero.
            priceFormatter: (p: number) => {
              if (!Number.isFinite(p) || Math.abs(p) < 1e-12) return "$0";
              if (p < 0) return "";
              if (p >= 1) return `$${p.toFixed(2)}`;
              if (p >= 0.01) return `$${p.toFixed(4)}`;
              return `$${p.toPrecision(3)}`;
            },
          },
        });
        chart = c as unknown as typeof chart;

        const series = c.addSeries(lib.CandlestickSeries, {
          upColor: up,
          downColor: down,
          borderUpColor: up,
          borderDownColor: down,
          wickUpColor: up,
          wickDownColor: down,
          priceFormat: { type: "price", precision: 8, minMove: 1e-8 },
        });
        series.setData(
          candles.map((k) => ({
            time: k.t as never,
            open: k.o,
            high: k.h,
            low: k.l,
            close: k.c,
          })),
        );

        // WIDTH BEFORE FIT, and fit again on every resize. Fitting first packed
        // three hundred bars into the right-hand sixth of the chart: the
        // container had not been measured when the chart was created, so the
        // time scale was fitted to a width that was about to change.
        const fit = () => {
          if (disposed || !box.current) return;
          c.applyOptions({ width: box.current.clientWidth });
          c.timeScale().fitContent();
        };
        const ro = new ResizeObserver(fit);
        ro.observe(el);
        fit();

        return () => ro.disconnect();
      } catch {
        // A chart that will not load must not take the page with it — the
        // theses beneath are the point of this product.
        if (!disposed) setFailed(true);
      }
    })();

    return () => {
      disposed = true;
      try {
        chart?.remove();
      } catch {
        /* already gone */
      }
    };
  }, [candles, height]);

  if (failed) {
    return <p className="mm-note">The chart could not be drawn. The figures above still stand.</p>;
  }

  // The height is reserved before anything paints, so the reasoning below never
  // gets pushed down on hydration.
  return <div className="mm-candles" ref={box} style={{ height }} aria-hidden />;
}
