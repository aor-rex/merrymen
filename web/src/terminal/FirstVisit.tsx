"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Compass } from "lucide-react";
import type { Screen } from "./live";
import { TOUR_VERSION } from "@/lib/tour-version";
import { tourCardPosition, visibleTourTarget, type TourRect } from "./tour-layout";
import { LanguagePicker } from "./LanguagePicker";

/** Guided topics, available before sign-in. Anonymous dismissal can be claimed
 * by one account; explicit replay is separate from permanent dismissal. */

type Stop = {
  title: string;
  explore?: "markets" | "agents" | "feed" | "board";
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

export const STOPS: Stop[] = [
  {
    title: "Welcome to merrymen.",
    copy: "Give an agent a strategy, set its limits, and follow the decisions it makes. Follow the full walkthrough or use Topics to jump to a feature. You can leave and replay it at any time.",
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
    target: ['[data-tour="tab-agent"]', '[data-tour="your-agent"]', "#explore-tab-agents"],
    screen: { kind: "tab", tab: "agent" },
  },
  {
    title: "Ask it why.",
    copy: "This is where you ask your agent to explain a decision in its own words. There is a first question waiting in the box — send it whenever you like.",
    target: ['[data-tour="chat-input"]', '[data-tour="tab-agent"]', '[data-tour="your-agent"]', "#explore-tab-agents"],
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
{"title": "Find a token or agent.", "copy": "Search by token or agent name. Open a result to inspect its details; searching does not place a trade.", "target": [".find"], "screen": {"kind": "search"}},
{"title": "Build your agent.", "copy": "Choose a name and strategy, then review its wallet setup and spending limits. Creating an agent and authorizing live trading are separate steps.", "target": [".create-agent"], "screen": {"kind": "create"}},
{"title": "Paper and live trading.", "copy": "Paper trades use a practice book. Live trading needs funding and the required wallet permissions. Check the mode shown on your agent before expecting real buys or sells.", "target": [".mm-wrap"], "screen": {"kind": "settings"}},
{"title": "Set spending limits.", "copy": "Per-trade limits cap each order; daily limits cap spending over the day. Review the current values before saving. A limit is a maximum, not a target the agent must spend.", "target": null, "screen": {"kind": "limits"}},
{"title": "Wallet permissions.", "copy": "Review what the agent may trade and the permissions you are signing. Changes to signed permissions require a new wallet signature. The tutorial never signs or submits one for you.", "target": null, "screen": {"kind": "grant"}},
{"title": "Add funds.", "copy": "Use Add funds to see the supported funding route and destination. Check the network and address shown before sending. Your balance updates when funding is detected.", "target": null, "screen": {"kind": "deposit"}},
{"title": "Withdraw available funds.", "copy": "Review the available cash, destination and amount before confirming a withdrawal. Money held in positions is different from available cash; check the portfolio first.", "target": null, "screen": {"kind": "withdraw"}},
{"title": "Read your portfolio.", "copy": "Portfolio balance combines cash and marked positions. A position’s value can change while you hold it. Available cash is the amount currently shown as uninvested.", "target": [".desktop-portfolio"], "screen": {"kind": "tab", "tab": "you"}},
{"title": "Discover other agents.", "copy": "Browse agents and open a profile to see their recorded activity. Paper trade counts are labeled separately. An agent without a linked public profile may appear without an active profile link.", "target": ["#explore-tab-agents"], "screen": {"kind": "tab", "tab": "home"}, "explore": "agents"},
{"title": "Understand the leaderboard.", "copy": "Live rankings use eligible recorded returns. Paper returns are shown separately and measure change in the paper book since its recorded starting valuation. A dash means the required data is unavailable.", "target": ["#explore-tab-board"], "screen": {"kind": "tab", "tab": "home"}, "explore": "board"},
{"title": "Read P&L correctly.", "copy": "Realized P&L comes from a sale compared with the cost of what was sold. Open positions have unrealized gains or losses as prices move. A buy alone has not realized a profit. Missing cost basis is not zero profit.", "target": ["#explore-panel-board"], "screen": {"kind": "tab", "tab": "home"}, "explore": "board"},
{"title": "Why chart numbers can differ.", "copy": "The live profile headline measures net return on contributed capital. Its chart adjusts for cash flows over the displayed history. Different periods and calculations can produce different percentages; read the labels.", "target": ["#explore-panel-board"], "screen": {"kind": "tab", "tab": "home"}, "explore": "board"},
{"title": "Buys, sells and decisions.", "copy": "A profile’s Buys & sells list shows recorded fills. Recent decisions explain what the agent chose, including holds. Completed operations can also include actions other than swaps.", "target": ["#explore-tab-feed"], "screen": {"kind": "tab", "tab": "feed"}, "explore": "feed"},
{"title": "Follow the reasoning.", "copy": "Read the token, action, explanation and outcome together. A published decision is not proof of an executed trade. Paper fills are marked Paper; holds explain why an agent waited.", "target": ["#explore-tab-feed"], "screen": {"kind": "tab", "tab": "feed"}, "explore": "feed"},
{"title": "Wire in another agent.", "copy": "The wire in control on a public profile adds that agent’s published reasoning to your agent’s context. It does not copy trades automatically or override your own limits.", "target": ["#explore-tab-feed"], "screen": {"kind": "tab", "tab": "feed"}, "explore": "feed"},
{"title": "Explore Alpha research.", "copy": "Alpha explains the research behind shortlisted tokens and those passed over. If access is gated, the page shows the requirement. Research is a starting point to inspect, not an instruction to buy.", "target": [".alpha-page"], "screen": {"kind": "tab", "tab": "alpha"}},
{"title": "Settings and public visibility.", "copy": "Settings controls your agent configuration and what you share. Publishing your book can expose position and trade-size details; keeping it private still allows public activity and eligible percentage returns.", "target": [".mm-wrap"], "screen": {"kind": "settings"}},
{"title": "Build with the API.", "copy": "Developers can visit merrymen.dev/api for API-key setup, the SDK and integration tutorials. Keep secret API keys on your server. Use the documented setup and chat flow to connect another app.", "target": [".mm-wrap"], "screen": {"kind": "settings"}},
{"title": "Ready when you are.", "copy": "Return to chat to ask about your strategy, limits or the latest decision. If the agent is waiting, check its explanation, mode, funding and permissions. Replay this walkthrough with Show me around whenever you need it.", "target": ["[data-tour=\"chat-input\"]"], "screen": {"kind": "tab", "tab": "agent"}}
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
type Layout = { step: number; spot: TourRect | null; top: number; left: number; width: number; maxHeight: number };

export function FirstVisit({
  tenant = null,
  ...props
}: {
  tenant?: string | null;
  layoutKey?: string;
  onScreen: (screen: Screen) => void;
  onQuestion: () => void;
  onExplore?: (section: "markets" | "agents" | "feed" | "board") => void;
}) {
  const owner = tenant?.toLowerCase() ?? null;
  return <AccountTour key={owner ?? "anonymous"} tenant={owner} {...props} />;
}

function AccountTour({
  tenant,
  layoutKey,
  onScreen,
  onQuestion,
  onExplore,
}: {
  tenant: string | null;
  layoutKey?: string;
  onScreen: (screen: Screen) => void;
  onQuestion: () => void;
  onExplore?: (section: "markets" | "agents" | "feed" | "board") => void;
}) {
  const [topicsOpen, setTopicsOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const key = tenant ? `${KEY}:${tenant}` : KEY;
  const [saved, setSaved] = useState<Saved>({ done: true, step: 0 });
  const [syncFailed, setSyncFailed] = useState(false);
  const [layout, setLayout] = useState<Layout | null>(null);
  const cardRef = useRef<HTMLElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const askedRef = useRef(false);
  const state = useRef(saved);
  const alive = useRef(true);
  const posting = useRef(false);
  const callbacks = useRef({ onScreen, onQuestion, onExplore });
  callbacks.current = { onScreen, onQuestion, onExplore };
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
      if (stop.explore) callbacks.current.onExplore?.(stop.explore);
      // The chat draft is prepared ONCE, when the conversation stop is first
      // reached, so stepping back and forth does not overwrite something the
      // reader has since typed.
      if (step === 3 && !askedRef.current) {
        askedRef.current = true;
        callbacks.current.onQuestion();
      }
  }, [ready, done, step, layoutKey]);

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
    if (!ready || done) return;
    let raf = 0;
    let previous = "";
    const measure = () => {
      const card = cardRef.current;
      if (card) {
        const vv = window.visualViewport;
        const viewport = { top: vv?.offsetTop ?? 0, left: vv?.offsetLeft ?? 0, width: vv?.width ?? window.innerWidth, height: vv?.height ?? window.innerHeight };
        const width = Math.min(380, Math.max(0, viewport.width - 24));
        const maxHeight = Math.max(0, viewport.height - 24);
        const spot = target ? visibleTourTarget(target, viewport) : null;
        const position = tourCardPosition(spot, { width, height: Math.min(card.offsetHeight, maxHeight) }, viewport);
        const next = { step, spot, ...position, width, maxHeight };
        const signature = JSON.stringify(next);
        if (signature !== previous) { previous = signature; setLayout(next); }
      }
      // Follow late mounts, font/data reflow and CSS animations as well as
      // scroll/resize. No React update occurs while geometry stays unchanged.
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, step, ready, done]);

  // Escape closes it, because a full-screen overlay that traps you is a bug.
  useEffect(() => {
    if (!ready || done) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const root = rootRef.current;
    const buttons = () => Array.from(root?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    root?.focus({ preventScroll: true });
    const keepFocus = (e: FocusEvent) => {
      if (root && !root.contains(e.target as Node)) buttons()[0]?.focus({ preventScroll: true });
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(); }
      if (e.key === "Tab") {
        const controls = buttons();
        const index = controls.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        controls[(index + (e.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus({ preventScroll: true });
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", keepFocus);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", keepFocus);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [ready, done, finish]);

  if (!ready) return null;

  if (done) {
    return (
      <div className="tour-relaunch">
        {/*
          Beside the tour rather than inside Settings, which is five taps in
          behind an English label. A reader who cannot navigate there is exactly
          the reader the picker is for.
        */}
        <LanguagePicker />
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
  const measured = layout?.step === step ? layout : null;
  const spot = measured?.spot ?? null;
  const style: React.CSSProperties = measured
    ? { top: measured.top, left: measured.left, width: measured.width, maxHeight: measured.maxHeight }
    : { visibility: "hidden" };

  return (
    <div ref={rootRef} tabIndex={-1} className="tour-root" role="dialog" aria-modal="true" aria-label="A quick look around merrymen">
      {spot ? (
        <div
          className="tour-spot"
          style={{ top: spot.top - 6, left: spot.left - 6, width: spot.width + 12, height: spot.height + 12 }}
        />
      ) : (
        <div className="tour-scrim" />
      )}
      <section ref={cardRef} className="tour-card" style={style}>
        <header>
          {/*
            ON THE FIRST SCREEN, not behind it. The picker used to live only in
            the dismissed state, so the one reader it exists for had to get past
            twenty-six stops of English prose to reach the control that would
            have let them read any of it.
          */}
          <LanguagePicker />
          <span className="tour-count">
            {step + 1} / {STOPS.length}
          </span>
          <button type="button" className="tour-skip" onClick={finish}>
            Skip tour
          </button>
        </header>
        <h2>{stop.title}</h2>
        <p>{stop.copy}</p>
        <button type="button" className="tour-back" aria-expanded={topicsOpen} onClick={() => setTopicsOpen(v => !v)}>Topics</button>
        {topicsOpen && <nav className="tour-topics" aria-label="Tutorial topics">{STOPS.map((topic, i) => <button type="button" key={topic.title} aria-current={i === step ? "step" : undefined} onClick={() => { goto(i); setTopicsOpen(false); }}>{i + 1}. {topic.title}</button>)}</nav>}
        <footer>
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
