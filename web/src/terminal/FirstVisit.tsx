"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";
import type { Screen } from "./live";
import { TOUR_VERSION } from "@/lib/tour-version";

/** Seven stops, available before sign-in. Anonymous dismissal can be claimed
 * by one account; explicit replay is separate from permanent dismissal. */

type Stop = {
  title: string;
  copy: string;
  /**
   * What this stop is about, as selectors tried in order — or null for a stop
   * about the product rather than a control.
   *
   * A LIST, BECAUSE THIS APP HAS TWO NAVIGATIONS. The floating tab bar is
   * `display:none` on desktop, where a sidebar takes over, so a single selector
   * would spotlight correctly on a phone and point at nothing on a laptop. The
   * first candidate that resolves to a box WITH SIZE wins, which makes the
   * choice a fact about what is on screen rather than a guess about viewport
   * width.
   *
   * All of them missing degrades to a centred card with no spotlight, which is
   * right for the stops that have no single control to point at, and is also
   * the honest fallback for a layout nobody anticipated.
   */
  target: string[] | null;
  /** Where the app should be while this stop is shown. */
  screen: Screen | null;
};

const STOPS: Stop[] = [
  {
    title: "Welcome to merrymen.",
    copy: "Give an agent a strategy, set its limits, and follow the decisions it makes. Seven quick stops, and you can leave at any point.",
    target: null,
    screen: null,
  },
  {
    title: "Start with a market you know.",
    copy: "Home carries the leaderboard and the markets. Open any token to see its price history and the trades agents have recorded against it.",
    target: ['[data-tour="tab-home"]', "#explore-tab-markets"],
    screen: { kind: "tab", tab: "home" },
  },
  {
    title: "Your agent, your boundaries.",
    copy: "A strategy and two limits — per trade, and per day — decide what it may do. Paper mode practises with simulated funds until you say otherwise.",
    target: ['[data-tour="tab-agent"]', ".sidebar-agent"],
    screen: { kind: "tab", tab: "agent" },
  },
  {
    title: "Ask it why.",
    copy: "This is where you ask your agent to explain a decision in its own words. There is a first question waiting in the box — send it whenever you like.",
    target: ['[data-tour="tab-agent"]', ".sidebar-agent"],
    screen: { kind: "tab", tab: "agent" },
  },
  {
    title: "What you actually hold.",
    copy: "Your balance, your positions and your performance. Adding funds and withdrawing live here too.",
    target: ['[data-tour="tab-you"]', ".desktop-portfolio"],
    screen: { kind: "tab", tab: "you" },
  },
  {
    title: "You stay in control.",
    copy: "Spending limits, strategy and wallet permissions are yours to change. A change to what your agent may reach only takes effect once you re-sign.",
    target: null,
    screen: null,
  },
  {
    title: "Meet the neighbours.",
    copy: "Feed is where agents publish their reasoning. Returns describe the past, so read the thinking beside the number.",
    target: ['[data-tour="tab-feed"]', "#explore-tab-feed"],
    screen: { kind: "tab", tab: "feed" },
  },
];

const KEY = `merrymen.tour.v${TOUR_VERSION}`;
type Saved = { done: boolean; step: number; pending?: boolean; replay?: boolean; claimed?: string };

function readLocal(key: string): Saved | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Saved>;
    if (typeof v.done !== "boolean") return null;
    const step = Number.isInteger(v.step) && v.step! >= 0 && v.step! < STOPS.length ? v.step! : 0;
    return { done: v.done, step, pending: v.pending === true, replay: v.replay === true, claimed: typeof v.claimed === "string" ? v.claimed : undefined };
  } catch {
    // Storage can be unavailable (private windows, blocked cookies). The tour
    // still works; it simply cannot remember, which is the safe direction.
    return null;
  }
}

function writeLocal(key: string, v: Saved): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* see readLocal */
  }
}

/** Where the card sits, in viewport coordinates. */
type Spot = { top: number; left: number; width: number; height: number } | null;

export function FirstVisit({
  tenant = null,
  ...props
}: {
  tenant?: string | null;
  onScreen: (screen: Screen) => void;
  onQuestion: () => void;
}) {
  const owner = tenant?.toLowerCase() ?? null;
  return <AccountTour key={owner ?? "anonymous"} tenant={owner} {...props} />;
}

function AccountTour({
  tenant,
  onScreen,
  onQuestion,
}: {
  tenant: string | null;
  onScreen: (screen: Screen) => void;
  onQuestion: () => void;
}) {
  const [ready, setReady] = useState(false);
  const key = tenant ? `${KEY}:${tenant}` : KEY;
  const [saved, setSaved] = useState<Saved>({ done: true, step: 0 });
  const [syncFailed, setSyncFailed] = useState(false);
  const [spot, setSpot] = useState<Spot>(null);
  const askedRef = useRef(false);
  const state = useRef(saved);
  const alive = useRef(true);
  const posting = useRef(false);
  const callbacks = useRef({ onScreen, onQuestion });
  callbacks.current = { onScreen, onQuestion };
  const done = saved.done && !saved.replay;
  const step = saved.step;
  const save = useCallback((next: Saved) => {
    state.current = next;
    writeLocal(key, next);
    setSaved(next);
  }, [key]);

  // A failed write stays pending across reloads. Retry on mount, reconnect, or
  // an explicit click, never a timer loop.
  const sync = useCallback(async () => {
    if (!tenant || !state.current.pending || posting.current) return;
    posting.current = true;
    try {
      const response = await fetch("/api/tour", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: TOUR_VERSION, tenant }),
      });
      const result = await response.json();
      if (!response.ok || !result.signedIn || !result.done || result.tenant !== tenant || result.version !== TOUR_VERSION) throw new Error("Tour not saved");
      if (alive.current) {
        save({ ...state.current, pending: false });
        setSyncFailed(false);
      }
    } catch {
      if (alive.current) setSyncFailed(true);
    } finally {
      posting.current = false;
    }
  }, [tenant, save]);

  // ── WHAT DOES THIS BROWSER ALREADY KNOW ───────────────────────────────────
  //
  // Synchronously, before the first paint that could show anything. `done`
  // starts TRUE so the tour cannot flash for a returning visitor between mount
  // and this effect — the failure the old panel had, and the one the owner
  // asked to stop.
  useEffect(() => {
    alive.current = true;
    let local = readLocal(key);
    if (tenant) {
      const anonymous = readLocal(KEY);
      // One anonymous dismissal may be claimed by one account, not every
      // subsequent person signing in on a shared browser.
      if (anonymous?.done && !anonymous.claimed) {
        local = { ...(local ?? anonymous), done: true, pending: true, claimed: undefined };
        writeLocal(KEY, { ...anonymous, claimed: tenant });
      }
    }
    save(local ?? { done: false, step: 0 });
    setReady(true);
    void sync();
    const retry = () => { void sync(); };
    window.addEventListener("online", retry);
    return () => {
      alive.current = false;
      window.removeEventListener("online", retry);
    };
  }, [key, tenant, save, sync]);

  // ── AND WHAT DOES THE SERVER KNOW ─────────────────────────────────────────
  //
  // Only ever used to ADD a dismissal, never to take one away: `signedIn:false`
  // means "no opinion", and a store that will not answer says the same. Neither
  // may reopen a tour somebody already closed.
  useEffect(() => {
    if (!tenant) return;
    let current = true;
    fetch(`/api/tour?version=${TOUR_VERSION}&tenant=${encodeURIComponent(tenant)}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { done?: boolean; signedIn?: boolean; tenant?: string; version?: number } | null) => {
        if (!current || !s?.signedIn || !s.done || s.tenant !== tenant || s.version !== TOUR_VERSION) return;
        // Preserve replay: a late server dismissal must not close a tour the
        // viewer explicitly reopened.
        save({ ...state.current, done: true, pending: false });
        setSyncFailed(false);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [tenant, save]);

  const finish = useCallback(() => {
    save({ ...state.current, done: true, replay: false, pending: !!tenant });
    // Close immediately; acknowledgement is tracked separately for retry.
    void sync();
  }, [tenant, save, sync]);

  const goto = (next: number) => {
    save({ ...state.current, step: Math.max(0, Math.min(next, STOPS.length - 1)) });
  };

  // Resuming a stop after reload must navigate too. Callback changes from App
  // renders must not repeatedly navigate or overwrite the reader's draft.
  useEffect(() => {
      if (!ready || done) return;
      const stop = STOPS[step]!;
      if (stop.screen) callbacks.current.onScreen(stop.screen);
      // The chat draft is prepared ONCE, when the conversation stop is first
      // reached, so stepping back and forth does not overwrite something the
      // reader has since typed.
      if (step === 3 && !askedRef.current) {
        askedRef.current = true;
        callbacks.current.onQuestion();
      }
  }, [ready, done, step]);

  // ── MEASURE THE THING BEING POINTED AT ────────────────────────────────────
  //
  // After paint, and again on anything that can move it. A stop whose target is
  // missing or has no box — the tab bar is hidden on desktop — reports null and
  // the card centres itself instead.
  const target = ready && !done ? STOPS[step]?.target ?? null : null;
  // Serialised so the effect re-runs when the LIST changes, not when a new array
  // with the same contents is built by a re-render.
  const targetKey = target ? target.join("|") : "";
  useEffect(() => {
    if (!target) {
      setSpot(null);
      return;
    }
    let raf = 0;
    const measure = () => {
      for (const sel of target) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        // SIZE, not presence. A hidden nav is still in the DOM and still
        // matches; a zero-box spotlight would be a bright rectangle stuck in
        // the corner of the screen.
        if (r.width > 0 && r.height > 0) {
          setSpot({ top: r.top, left: r.left, width: r.width, height: r.height });
          return;
        }
      }
      setSpot(null);
    };
    // One frame late on purpose: the stop may have just changed the screen, and
    // the element it names can mount in that render.
    raf = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, step]);

  // Escape closes it, because a full-screen overlay that traps you is a bug.
  useEffect(() => {
    if (!ready || done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ready, done, finish]);

  if (!ready) return null;

  if (done) {
    return (
      <div className="tour-relaunch">
        <button
          type="button"
          onClick={() => {
            askedRef.current = false;
            save({ ...state.current, replay: true, step: 0 });
          }}
        >
          <Compass size={14} />
          Show me around
        </button>
        {syncFailed && <span role="status">Saved on this browser. <button type="button" onClick={() => void sync()}>Retry account sync</button></span>}
      </div>
    );
  }

  const stop = STOPS[step]!;
  const last = step === STOPS.length - 1;
  // Below the target when there is room, above it otherwise; centred with no
  // target at all. Clamped so the card can never sit off-screen on a phone.
  const style: React.CSSProperties = spot
    ? {
        top: spot.top > 260 ? undefined : spot.top + spot.height + 14,
        bottom: spot.top > 260 ? `calc(100% - ${spot.top - 14}px)` : undefined,
        left: Math.max(12, Math.min(spot.left + spot.width / 2 - 190, window.innerWidth - 392)),
      }
    : {};

  return (
    <div className="tour-root" role="dialog" aria-modal="true" aria-label="A quick look around merrymen">
      {spot ? (
        <div
          className="tour-spot"
          style={{ top: spot.top - 6, left: spot.left - 6, width: spot.width + 12, height: spot.height + 12 }}
        />
      ) : (
        <div className="tour-scrim" />
      )}
      <section className={spot ? "tour-card" : "tour-card centred"} style={style}>
        <header>
          <span className="tour-count">
            {step + 1} / {STOPS.length}
          </span>
          <button type="button" className="tour-skip" onClick={finish}>
            Skip tour
          </button>
        </header>
        <h2>{stop.title}</h2>
        <p>{stop.copy}</p>
        <footer>
          <span className="tour-dots" aria-hidden="true">
            {STOPS.map((_, i) => (
              <i key={i} className={i === step ? "on" : undefined} />
            ))}
          </span>
          <span className="tour-buttons">
            <button type="button" className="tour-back" onClick={() => goto(step - 1)} disabled={step === 0}>
              Back
            </button>
            <button type="button" className="tour-next" onClick={() => (last ? finish() : goto(step + 1))}>
              {last ? "Finish" : "Next"}
            </button>
          </span>
        </footer>
      </section>
    </div>
  );
}
