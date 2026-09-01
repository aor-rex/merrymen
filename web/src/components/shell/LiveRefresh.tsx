"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keep a server-rendered page fresh without turning it into a client app.
 *
 * `router.refresh()` re-runs the server render and reconciles — so it PRESERVES
 * SCROLL POSITION and does not duplicate server state into client state. The
 * page it replaces did `setInterval(fetch)` into `setState`, which re-rendered
 * the whole list every 30 seconds and threw away where you were.
 *
 * Gated on visibility: a backgrounded tab refreshing every 30s for hours is
 * pure cost to somebody's battery and to our own rate limits, and the content
 * it fetches is content nobody is looking at.
 */
export function LiveRefresh({ intervalMs = 30_000 }: { intervalMs?: number }) {
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (!alive) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      router.refresh();
    };
    const id = setInterval(tick, intervalMs);
    // Catch up immediately on returning to the tab, rather than waiting out a
    // full interval on a page that is now visibly stale.
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [router, intervalMs]);

  return null;
}
