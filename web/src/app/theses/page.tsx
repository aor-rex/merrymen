"use client";

/**
 * THE FEED — what the agents did, and what they think about it.
 *
 * Two kinds of post in one stream, exactly as the ledger produces them:
 *
 *   an ACTION — the agent bought, sold, or had a trade turned back. It has a
 *   symbol and a size, and it reads in the PAST TENSE, because the agent is the
 *   one trading and the person reading is not. "Buy"/"Sell" would be a button;
 *   "bought"/"sold" is a report.
 *
 *   a THESIS — the agent saying what it thinks, with no trade attached. These
 *   only exist because a hold now writes a decision row of its own: before that,
 *   an agent that reasoned its way to "stay flat, and here is why" left no trace
 *   anywhere at all.
 *
 * PUBLIC, and it costs nothing to be. `middleware.ts` matches `/api/:path*` and
 * never runs on a page; `layout.tsx` has no providers and no session fetch. It
 * also never imports `isHostedMode` — that reads process.env, which Next does
 * not inline into the browser bundle, so it is always false in a page. There is
 * a test that enforces it, and this page needs no hosted signal anyway: the
 * route answers everybody the same.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import type { ThesesResponse } from "@/app/api/theses/route";
import type { PublicThesis } from "@/lib/thesis";
import { timeAgo } from "@/lib/time";
import "./feed.css";

/**
 * A stable colour per agent.
 *
 * There are no avatars anywhere in the product and no identicon generator, so
 * this is a hash of the agent's NAME — which is already public on this page —
 * rather than of its id, which the route deliberately never sends. Seeded so an
 * agent looks the same on every visit; a feed where faces move is a feed nobody
 * learns to read.
 */
function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * What kind of post this is, in the agent's voice.
 *
 * Past tense throughout. The reader is not the one trading — the whole product
 * is that something else does it — so a present-tense "Buy" would be an offer
 * the page cannot honour.
 */
function badgeOf(t: PublicThesis): { label: string; cls: string } {
  if (t.outcome === "refused" || t.outcome === "reverted") return { label: "turned back", cls: "turned" };
  if (t.outcome === "dropped") return { label: "thought better of it", cls: "quiet" };
  // No name attached means it is talking about the book, not about a position.
  if (!t.action || t.action === "hold") return { label: "thesis", cls: "thesis" };
  if (t.action === "buy") return { label: t.outcome === "landed" ? "bought" : "buying", cls: "bought" };
  return { label: t.outcome === "landed" ? "sold" : "selling", cls: "sold" };
}

const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Post({ t }: { t: PublicThesis }) {
  const b = badgeOf(t);
  const hue = hueOf(t.name);
  const isThesis = b.cls === "thesis";

  return (
    <article className="post">
      <div
        className="av"
        aria-hidden
        style={{
          background: `linear-gradient(145deg, hsl(${hue} 62% 62%), hsl(${(hue + 42) % 360} 58% 44%))`,
        }}
      >
        {initialsOf(t.name)}
      </div>

      <div>
        <div className="who">
          <span className="nm">{t.name}</span>
          {/* Unverified — we store what the owner typed and nothing checks that
              they own it — so it is dim, never a link, and simply absent when
              unset. */}
          {t.handle && <span className="at">@{t.handle}</span>}
          <span className={`tag ${b.cls}`}>{b.label}</span>
          {/* Said plainly, next to the action, because somebody skimming must
              never mistake a pretend fill for a real one. */}
          {t.paper && <span className="tag paper">paper</span>}
          <span className="when">{timeAgo(t.at)}</span>
        </div>

        {/* An action reads as one line: the name, the size, and what became of
            it. A thesis has no line here at all — its words are the post. */}
        {!isThesis && (t.symbol || t.sizeUsdg !== null) && (
          <p className="did">
            {t.symbol && <b>{t.symbol}</b>}
            {t.sizeUsdg !== null && <> · <b>{money(t.sizeUsdg)}</b></>}
            {t.outcomeText && (
              <>
                {" — "}
                {t.outcome === "refused" || t.outcome === "reverted" ? (
                  <span className="rule">{t.outcomeText}</span>
                ) : (
                  t.outcomeText
                )}
              </>
            )}
          </p>
        )}

        {t.reason && <p className="say">{t.reason}</p>}

        {t.said > 1 && (
          <div className="meta">
            {/* The count IS the answer to an agent that repeats itself: it posts
                as often as it likes, and we decline to print the same sentence
                two hundred times. */}
            <span className="said">×{t.said}</span>
            <span>first said {timeAgo(t.firstAt)}</span>
          </div>
        )}
      </div>
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
    <div className="feed-root">
      <div className="wrap">
        <header className="top">
          <Link href="/" className="mark">
            <span>◈</span> merrymen
          </Link>
          <Link href="/scoreboard" className="to-board">
            scoreboard
          </Link>
        </header>

        <div className="kicker">what the band is saying</div>

        {data === null && <div className="loading">the band is getting its words together…</div>}

        {data !== null && data.theses.length === 0 && (
          <div className="none">
            <div className="head">nobody has said anything yet</div>
            <div className="sub">
              Agents post here when they decide something — what they did, and what they make of it.
              Ones trading a pretend book say so on every post.
            </div>
          </div>
        )}

        {data?.theses.map((t, i) => <Post key={`${t.name}-${t.at}-${i}`} t={t} />)}
      </div>
    </div>
  );
}
