"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";
import type { Screen } from "./live";
import "./first-visit.css";

/**
 * THE GUIDED FIRST VISIT, as a spotlight tour.
 *
 * It was an inline panel that sat above the page and offered a different set of
 * branching buttons at every stop — "Explore first", "Meet my agent", "Find a
 * token". That shape asks the reader to make a decision seven times before they
 * know what any of the words mean, and the panel pushed the app down the page,
 * so the thing being described moved while it was described.
 *
 * This is the ordinary product-tour shape instead: one card, a step counter, a
 * dot per stop, Back and Next, and one way out that is always in the same place.
 * The page dims and the thing the stop is about stays lit.
 *
 * ── WHAT "SHOWN ONCE" ACTUALLY REQUIRES ─────────────────────────────────────
 *
 * Two stores, because neither one is enough on its own.
 *
 * `localStorage` is the layer that is always there. It works signed-out, it
 * works offline, and it answers synchronously — which is what stops the tour
 * flashing onto the screen of somebody who dismissed it last week while a fetch
 * is still in flight.
 *
 * The server store is what makes the dismissal a fact about a PERSON rather than
 * about a browser. Skipping on a laptop and being interrupted again on a phone
 * reads as the product forgetting them.
 *
 * EITHER SAYING "DONE" IS DONE. Not both, and not the more recent one. The
 * promise a skip makes is "do not interrupt me again", and the only way to keep
 * it under two stores that can disagree is to let either veto. The cost of that
 * rule is that an owner who wants it back must ask for it, which the relaunch
 * control below is for; the cost of the other rule is breaking the promise.
 *
 * THE KEY IS VERSIONED, and this is v2 while the panel was v1. A tour that
 * changed is a tour nobody has seen, so everyone is shown this one exactly once
 * — including people who dismissed the old one. Bumping it again is how a future
 * rewrite reaches everybody without a migration.
 */

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

const KEY = "merrymen.tour.v2";
type Saved = { done: boolean; step: number };

function readLocal(): Saved | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Saved>;
    if (typeof v.done !== "boolean") return null;
    const step = Number.isInteger(v.step) && v.step! >= 0 && v.step! < STOPS.length ? v.step! : 0;
    return { done: v.done, step };
  } catch {
    // Storage can be unavailable (private windows, blocked cookies). The tour
    // still works; it simply cannot remember, which is the safe direction.
    return null;
  }
}

function writeLocal(v: Saved): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    /* see readLocal */
  }
}

/** Where the card sits, in viewport coordinates. */
type Spot = { top: number; left: number; width: number; height: number } | null;

/**
 * NO ACCOUNT GATE, deliberately.
 *
 * The panel this replaced rendered nothing until an account had loaded, because
 * it keyed its storage per account. The result was that the one person a first
 * visit is for — somebody who has never signed in and has no agent — was the
 * one person who never saw it.
 *
 * The dismissal is keyed per browser locally and per tenant on the server, so
 * there is nothing an account is needed for here.
 */
export function FirstVisit({
  onScreen,
  onQuestion,
}: {
  onScreen: (screen: Screen) => void;
  onQuestion: () => void;
}) {
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(true);
  const [step, setStep] = useState(0);
  const [spot, setSpot] = useState<Spot>(null);
  const askedRef = useRef(false);

  // ── WHAT DOES THIS BROWSER ALREADY KNOW ───────────────────────────────────
  //
  // Synchronously, before the first paint that could show anything. `done`
  // starts TRUE so the tour cannot flash for a returning visitor between mount
  // and this effect — the failure the old panel had, and the one the owner
  // asked to stop.
  useEffect(() => {
    const local = readLocal();
    setDone(local?.done ?? false);
    setStep(local?.step ?? 0);
    setReady(true);
  }, []);

  // ── AND WHAT DOES THE SERVER KNOW ─────────────────────────────────────────
  //
  // Only ever used to ADD a dismissal, never to take one away: `signedIn:false`
  // means "no opinion", and a store that will not answer says the same. Neither
  // may reopen a tour somebody already closed.
  useEffect(() => {
    if (!ready || done) return;
    let alive = true;
    fetch("/api/tour", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s: { done?: boolean; signedIn?: boolean } | null) => {
        if (!alive || !s?.signedIn || !s.done) return;
        setDone(true);
        // Write it locally too, so the next load is instant and offline-safe.
        writeLocal({ done: true, step });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [ready, done, step]);

  const finish = useCallback(() => {
    setDone(true);
    writeLocal({ done: true, step });
    // Local first, server second, and the server's answer is not awaited by the
    // UI: the card is already gone. A failure costs a re-show on a different
    // device, never on this one.
    fetch("/api/tour", { method: "POST" }).catch(() => {});
  }, [step]);

  const goto = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(next, STOPS.length - 1));
      setStep(clamped);
      writeLocal({ done: false, step: clamped });
      const stop = STOPS[clamped]!;
      if (stop.screen) onScreen(stop.screen);
      // The chat draft is prepared ONCE, when the conversation stop is first
      // reached, so stepping back and forth does not overwrite something the
      // reader has since typed.
      if (clamped === 3 && !askedRef.current) {
        askedRef.current = true;
        onQuestion();
      }
    },
    [onScreen, onQuestion],
  );

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
            setDone(false);
            setStep(0);
            writeLocal({ done: false, step: 0 });
          }}
        >
          <Compass size={14} />
          Show me around
        </button>
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
