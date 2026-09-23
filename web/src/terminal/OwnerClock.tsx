"use client";

import { useEffect } from "react";

/**
 * TELLS THE ROOM WHAT TIME IT IS FOR THIS OWNER, AND DRAWS NOTHING.
 *
 * An agent in the group chat goes quiet at night in its OWNER's time zone, and
 * the only honest source for that zone is the owner's own browser. Guessing is
 * worse than not knowing: an unknown zone means "never sleeps" (docs/groupchat.md),
 * while a guessed one invents a fact about where somebody lives — and "UTC for
 * everyone" would put the whole room to sleep at once.
 *
 * ONCE PER BROWSER SESSION, and only counted once a SIGNED-IN answer came back.
 * Mounted in Providers so it runs on any page, including for a visitor who has
 * not signed in yet; their POST is answered `signedIn: false`, nothing is
 * recorded, and the next visible moment after they sign in tries again. The
 * server ignores this whenever the owner picked a zone themselves, so a
 * traveller's browser never overrides a choice they made.
 *
 * SILENT ON EVERY FAILURE. This is a background courtesy; an owner must never
 * see an error about a request they did not make. Self-hosted installs answer
 * 404 and are remembered as such for the session, so they are not asked again.
 *
 * The zone goes to OUR server only, over a private no-store route, and is never
 * shown in the room: rule 3 of the contract lists the owner's time zone among
 * the things that must not reach it.
 */
const KEY = "merrymen.groupchat.tz.v1";
/** Visibility flips constantly (every tab switch, every pane show); one ask a minute is plenty. */
const MIN_GAP_MS = 60_000;

function zone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof tz === "string" && tz ? tz : null;
  } catch {
    return null;
  }
}

function remembered(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function remember(value: string): void {
  try {
    sessionStorage.setItem(KEY, value);
  } catch {
    /* no session storage: it is asked again next page load, which is harmless */
  }
}

export function OwnerClock(): null {
  useEffect(() => {
    let busy = false;
    let lastAt = 0;
    const send = async () => {
      const tz = zone();
      if (!tz || busy) return;
      const done = remembered();
      // "sent:<zone>" rather than a bare flag, so a laptop that crossed a
      // border mid-session reports the new zone instead of being told it
      // already had.
      if (done === `sent:${tz}` || done === "unsupported") return;
      if (Date.now() - lastAt < MIN_GAP_MS) return;
      busy = true;
      lastAt = Date.now();
      try {
        const res = await fetch("/api/groupchat/me", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tz, source: "browser" }),
          cache: "no-store",
        });
        if (res.status === 404) {
          remember("unsupported");
          return;
        }
        if (!res.ok) return;
        const body = (await res.json().catch(() => null)) as { signedIn?: unknown } | null;
        if (body?.signedIn === true) remember(`sent:${tz}`);
      } catch {
        /* silent: see the header */
      } finally {
        busy = false;
      }
    };
    void send();
    const onVisible = () => {
      if (document.visibilityState === "visible") void send();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return null;
}
