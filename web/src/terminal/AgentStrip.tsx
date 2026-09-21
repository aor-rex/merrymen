"use client";

/**
 * TWO THINGS ABOUT YOUR AGENT, ON THE SCREEN YOU ACTUALLY OPEN.
 *
 * The owner's words: "make sure telegram connection is more visible in the
 * home screen not ugly but not hidden, with all trencher mode settings as
 * well."
 *
 * ── WHY A STRIP AND NOT A PANEL OF CONTROLS ──────────────────────────────
 *
 * The obvious reading is "put the settings on Home". That would be the wrong
 * shape twice over. A toggle in two places is two places to disagree — this
 * product already carries the "one signing control" rule for exactly that
 * reason — and money behaviour with two front doors is how an owner turns
 * something on in one and finds it off in the other.
 *
 * So this is a READING with a way through to the real control. It answers the
 * question the buried settings were failing to answer ("is this actually on,
 * and if not, what do I do?") and leaves the changing where it already is.
 *
 * ── WHY IT FETCHES ITS OWN DATA ──────────────────────────────────────────
 *
 * `SetupChecklist` — the existing quiet status strip — does the same, and it
 * keeps `Home` a pure presentational component fed by the shell. Threading two
 * more request shapes through `App` to reach one card would spread knowledge
 * of Telegram across three files to save a request the screen makes once.
 *
 * NEITHER FETCH IS ALLOWED TO BREAK THE SCREEN. A failure leaves the row
 * unread, which renders as "checking…" and never as "not connected" — the
 * distinction the settings screen currently gets wrong, and the reason
 * `agent-status.ts` exists.
 *
 * ── AND WHY NEW VISITORS NEVER SEE IT ────────────────────────────────────
 *
 * `hasAgent` comes from the server's `exists`. Somebody who has not created an
 * agent has no bot to connect and no strategy to run, and a status card about
 * an agent that does not exist is noise on the one screen that should be
 * telling them to make one — which Home already does, in its own empty state.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { telegramRow, trencherRow, type TelegramRow, type TrencherRow } from "./agent-status";
import type { TelegramStatus } from "@/app/api/telegram/route";

interface SettingsShape {
  values?: { strategy?: string | null; trencherLiveEnabled?: boolean | null; assetMode?: string | null };
}

export function AgentStrip({ hasAgent }: { hasAgent: boolean }) {
  const [tg, setTg] = useState<TelegramStatus | null>(null);
  const [settings, setSettings] = useState<SettingsShape["values"] | null>(null);

  useEffect(() => {
    if (!hasAgent) return;
    let live = true;
    // BEST EFFORT, BOTH OF THEM. A rejected promise or a non-ok response
    // leaves the state null, which reads as "unread" and prints "checking…".
    // Nothing here may throw into the home screen's render.
    void fetch("/api/telegram")
      .then((r) => (r.ok ? (r.json() as Promise<TelegramStatus>) : null))
      .then((s) => { if (live && s) setTg(s); })
      .catch(() => {});
    void fetch("/api/settings")
      .then((r) => (r.ok ? (r.json() as Promise<SettingsShape>) : null))
      .then((s) => { if (live && s?.values) setSettings(s.values); })
      .catch(() => {});
    return () => { live = false; };
  }, [hasAgent]);

  if (!hasAgent) return null;

  return (
    <section className="agent-strip" aria-label="Agent connections">
      <TelegramLine row={telegramRow(tg)} />
      <TrencherLine row={trencherRow(settings)} />
    </section>
  );
}

function TelegramLine({ row }: { row: TelegramRow }) {
  switch (row.kind) {
    case "unread":
      return <Row tone="quiet" label="Telegram" value="checking…" />;
    case "no-token":
      return (
        <Row tone="quiet" label="Telegram" value="not set up"
          action={<Link href="/settings#telegram">Connect →</Link>}
        />
      );
    case "off":
      return (
        <Row tone="warn" label="Telegram" value="token saved, but switched off"
          action={<Link href="/settings#telegram">Turn on →</Link>}
        />
      );
    case "unverified":
      return (
        <Row tone="warn" label="Telegram" value="token saved, not verified yet"
          action={<Link href="/settings#telegram">Check it →</Link>}
        />
      );
    case "unlinked":
      /**
       * THE ONE CARD THAT CARRIES THE CODE.
       *
       * In Settings the instruction and the code are in two different closed
       * drawers, and two beta testers stopped right there. Putting them in one
       * sentence is the single change that unsticks them.
       *
       * A null code is a WAIT, not an absence: the agent mints one on its next
       * pass after a token is saved, so saying "no code" would be a claim we
       * cannot make about a code that is simply not minted yet.
       */
      return (
        <Row tone="warn" label="Telegram" value={row.linkCode ? "ready to connect" : "starting up"}
          action={
            row.linkCode ? (
              <>
                {row.botUsername ? (
                  // Carries the code into the chat instead of asking somebody
                  // to retype it, the way the mobile client already does.
                  <a href={`https://t.me/${row.botUsername}?start=${row.linkCode}`} target="_blank" rel="noreferrer">
                    Open Telegram →
                  </a>
                ) : null}
                <span className="mm-hint">
                  or send <code>/link {row.linkCode}</code> to your bot. Anyone who has this code can
                  control your agent — do not share or screenshot it.
                </span>
              </>
            ) : (
              <span className="mm-hint">Your agent mints a link code on its next pass. Check back shortly.</span>
            )
          }
        />
      );
    case "linked":
      return (
        <Row tone="ok" label="Telegram"
          value={row.botUsername ? `connected as @${row.botUsername}` : "connected"}
          action={<Link href="/settings#telegram">Manage →</Link>}
        />
      );
  }
}

function TrencherLine({ row }: { row: TrencherRow }) {
  switch (row.kind) {
    case "unread":
      return <Row tone="quiet" label="Trencher" value="checking…" />;
    case "off":
      return (
        <Row tone="quiet" label="Trencher" value="not your strategy"
          action={<Link href="/settings#trencher-mode">What is this? →</Link>}
        />
      );
    case "no-crypto":
      /**
       * The refusal nothing else in the product shows. See agent-status.ts:
       * the worker logs it at event level "ok" and the desk only renders
       * warn/err, so an owner can cause this from a dropdown and never find
       * out why nothing is happening.
       */
      return (
        <Row tone="warn" label="Trencher" value="on, but your asset mode is stocks only — no coins can be considered"
          action={<Link href="/settings#trencher-mode">Change it →</Link>}
        />
      );
    case "paper":
      return (
        <Row tone="quiet" label="Trencher" value="on, practice money only"
          action={<Link href="/settings#trencher-mode">Settings →</Link>}
        />
      );
    case "live":
      return (
        <Row tone="ok" label="Trencher" value="on, trading real money"
          action={<Link href="/settings#trencher-mode">Settings →</Link>}
        />
      );
  }
}

function Row({
  label,
  value,
  action,
  tone,
}: {
  label: string;
  value: string;
  action?: React.ReactNode;
  /** `warn` is amber, never red — red is reserved for a fault, and none of
      these are one. An owner once concluded the product was broken because a
      non-fault state wore the red box. */
  tone: "ok" | "warn" | "quiet";
}) {
  return (
    <div className={`agent-strip-row is-${tone}`}>
      <span className="agent-strip-label">{label}</span>
      <span className="agent-strip-value">{value}</span>
      {action ? <span className="agent-strip-action">{action}</span> : null}
    </div>
  );
}
