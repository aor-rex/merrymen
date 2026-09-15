"use client";

import { useEffect, useRef } from "react";

/**
 * A canvas that is allowed to be alive, and only while somebody is looking.
 *
 * THIS EXISTS BECAUSE THE LAST ONE DID NOT. The surface this replaces was
 * called "Embers": thirty particles on a requestAnimationFrame loop over a
 * fixed, full-viewport canvas, mounted on the home screen, running forever on
 * every phone whether or not the tab was in front. It was deleted rather than
 * tuned, because the problem was never the particle count — it was that nothing
 * in it could ever decide to stop.
 *
 * So every stopping condition lives HERE, once, and a caller cannot forget one:
 *
 *   - OFF SCREEN. An IntersectionObserver halts the loop when the canvas
 *     scrolls out of view. On a feed this is the common case within one flick.
 *   - HIDDEN TAB. visibilitychange halts it too. A backgrounded tab animating
 *     for an hour is pure cost with no reader, and on some browsers rAF keeps
 *     firing in a background window that merely lost focus.
 *   - REDUCED MOTION. The loop never starts. `draw` is called ONCE with t = 0,
 *     so the surface still renders — a still frame, not a blank rectangle.
 *     Respecting the preference must not mean showing nothing.
 *
 * RESOLUTION IS A KNOB, AND A SMALL ONE IS THE POINT. `scale` renders the
 * backing store at a fraction of display size and lets the browser upscale it
 * with `image-rendering: pixelated`. At scale 0.15 a 1600px band is a 240px
 * buffer — roughly 2% of the pixels — and the coarse result is not a compromise
 * to be apologised for, it IS the dithered look. Cheap and correct at once.
 *
 * The DPR cap is deliberate on top of that: a 3x phone would otherwise triple
 * the work for a texture whose whole aesthetic is that it is coarse.
 */

export interface LivingCanvasOptions {
  /**
   * Paint one frame. `t` is seconds since the loop started, and it does NOT
   * advance while paused — so a surface returning from off-screen resumes where
   * it left off rather than jumping.
   *
   * `w` and `h` are BACKING-STORE pixels, already scaled. Draw in those.
   */
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number, t: number) => void;
  /** Fraction of display size to render at. Lower is coarser and cheaper. */
  scale?: number;
  /** Upper bound on devicePixelRatio. */
  maxDpr?: number;
  /**
   * Frames per second to aim for. The loop skips rAF callbacks to hit it, which
   * on a 120Hz display is most of them. A drifting dither does not need 120.
   */
  fps?: number;
}

export function useLivingCanvas<T extends HTMLCanvasElement>({
  draw,
  scale = 0.18,
  maxDpr = 1.5,
  fps = 24,
}: LivingCanvasOptions) {
  const ref = useRef<T | null>(null);
  // Held in a ref so a caller may pass an inline closure without restarting the
  // loop on every render — the usual way an animation hook becomes a stutter.
  const drawRef = useRef(draw);
  drawRef.current = draw;

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    let raf = 0;
    let visible = false;
    let running = false;
    // Accumulated ANIMATION time, not wall time. Paused seconds are not
    // counted, so nothing teleports on resume.
    let elapsed = 0;
    let last = 0;
    let acc = 0;
    const frame = 1 / Math.max(1, fps);

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr * scale));
      const h = Math.max(1, Math.round(r.height * dpr * scale));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      return { w, h };
    };

    /**
     * A BUFFER THIS SMALL IS NOT A PICTURE, IT IS A MEASUREMENT THAT HAPPENED
     * TOO EARLY.
     *
     * The mount paint can land before the element has been laid out — most
     * reliably when an ancestor carries `content-visibility: auto`, which is
     * exactly what a band worth skipping off-screen will have. The rect is then
     * ~0, the backing store rounds to 1x1, and the one frame anybody was ever
     * going to get is painted into a single pixel. Nothing corrects it later,
     * because a paused loop has no next frame and a page that never resizes
     * fires no resize event.
     *
     * Measured, not theorised: this shipped as a 1x33 buffer behind a 1017x168
     * canvas, and the band rendered as two lit pixels.
     */
    const TOO_SMALL = 8;

    const paint = (t: number) => {
      const { w, h } = size();
      if (w < TOO_SMALL || h < TOO_SMALL) return;
      ctx.clearRect(0, 0, w, h);
      drawRef.current(ctx, w, h, t);
    };

    const tick = (now: number) => {
      if (!running) return;
      raf = requestAnimationFrame(tick);
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      // A tab that was throttled hands back an enormous dt; clamping it stops
      // the animation lurching forward by however long nobody was watching.
      acc += Math.min(dt, 0.25);
      if (acc < frame) return;
      elapsed += acc;
      acc = 0;
      paint(elapsed);
    };

    const start = () => {
      if (running || reduced) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    const sync = () => {
      const shown = visible && document.visibilityState === "visible";
      if (shown) start();
      else stop();
    };

    // One still frame regardless, so the surface is never an empty rectangle —
    // for reduced motion this is the whole render.
    paint(0);

    const io = new IntersectionObserver(
      (entries) => {
        visible = entries.some((e) => e.isIntersecting);
        sync();
      },
      // A little margin so it is already running by the time it scrolls in.
      { rootMargin: "120px" },
    );
    io.observe(canvas);

    const onVis = () => sync();
    document.addEventListener("visibilitychange", onVis);

    // Repaint on resize even while paused, or a rotated phone keeps a
    // stretched frame until something else happens to wake it.
    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => paint(elapsed), 120);
    };
    window.addEventListener("resize", onResize);

    // AND ON THE ELEMENT ITSELF, which is the half a window listener misses.
    // The canvas can reach its real size without the window changing at all —
    // content-visibility revealing it, a font landing, a sibling collapsing —
    // and each of those is a first correct measurement, not a resize.
    const ro = new ResizeObserver(() => paint(elapsed));
    ro.observe(canvas);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(resizeTimer);
    };
  }, [scale, maxDpr, fps]);

  return ref;
}
