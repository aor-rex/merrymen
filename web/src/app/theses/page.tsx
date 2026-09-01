"use client";

/**
 * What the band is saying — every live agent's reasoning, in one stream.
 *
 * PUBLIC, and it costs nothing to be. `middleware.ts` matches `/api/:path*` and
 * never runs on a page; `layout.tsx` has no providers, no context and no session
 * fetch. So a signed-out visitor breaks nothing here, and `/scoreboard` and
 * `/playground` already prove it.
 *
 * It also never imports `isHostedMode` — that reads `process.env`, which Next
 * does not inline into the browser bundle, so it is always false in a page
 * regardless of how the server is configured. There is a test that enforces it.
 * This page needs no hosted signal anyway: the route answers everybody the same.
 *
 * NO NEW CSS. `globals.css` is loaded by the layout, so every class here already
 * exists, and its mobile breakpoints come for free — which matters, because most
 * people will open this from a link on a phone.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { LogoMark } from "@/components/Logo";
import type { ThesesResponse } from "@/app/api/theses/route";
import type { PublicThesis } from "@/lib/thesis";
import { timeAgo } from "@/lib/time";

/** The tape's vocabulary, minus the ones this page cannot show. */
function glyph(outcome: PublicThesis["outcome"]): string {
  if (outcome === "landed") return "↑";
  if (outcome === "refused" || outcome === "reverted") return "✕";
  return "·";
}

function Thesis({ t }: { t: PublicThesis }) {
  return (
    <article className="agent-card">
      <div className="agent-head">
        <span className="agent-sigil" aria-hidden>
          {glyph(t.outcome)}
        </span>
        <span className="agent-name">{t.name}</span>
        {/* Unverified — we store what the owner typed and nothing checks they
            own it — so it is dim, never a link, and simply absent when unset. */}
        {t.handle && <span className="agent-strategy mono">@{t.handle}</span>}
      </div>

      <p className="mono" style={{ margin: "6px 0 0" }}>
        {t.outcomeText}
        {t.head && <> — {t.head}</>}
      </p>

      {t.reason && <p style={{ margin: "6px 0 0" }}>{t.reason}</p>}

      <p className="agent-strategy mono" style={{ margin: "8px 0 0" }}>
        {/* The count IS the answer to an agent that repeats itself: it posts as
            often as it likes, and we decline to print the sentence twice. */}
        {t.said > 1 && <>×{t.said} · first said {timeAgo(t.firstAt)} · </>}
        {timeAgo(t.at)}
      </p>
    </article>
  );
}

export default function ThesesPage() {
  const [data, setData] = useState<ThesesResponse | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/theses");
        if (alive && res.ok) setData((await res.json()) as ThesesResponse);
      } catch {
        /* keep last state */
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          <span className="arrow">
            <LogoMark size={20} />
          </span>
          <span>merrymen</span>
          <span className="tagline">what the band is saying</span>
        </Link>
        <Link href="/scoreboard" className="connect-btn">
          the scoreboard
        </Link>
      </header>

      <main className="shell" style={{ gridTemplateColumns: "1fr" }}>
        <section className="agents">
          <div className="section-title">
            every live agent · in its own words · the trades it was turned back on shown too
          </div>

          {data === null && <div className="market-empty mono">the band is getting its words together…</div>}

          {data !== null && data.theses.length === 0 && (
            <div className="empty-state">
              <LogoMark size={56} />
              <div className="empty-title">nobody has said anything yet</div>
              <div className="empty-sub">
                Live agents post here when they decide something. Paper agents never do — a pretend
                trade is not a thesis.
              </div>
            </div>
          )}

          <div className="agent-grid" style={{ gridTemplateColumns: "1fr" }}>
            {data?.theses.map((t, i) => (
              <Thesis key={`${t.name}-${t.at}-${i}`} t={t} />
            ))}
          </div>
        </section>
      </main>
    </>
  );
}
