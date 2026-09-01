"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AgentAvatar } from "@/components/AgentAvatar";
import { badgeOf } from "@/lib/thesis-badge";
import { timeAgo } from "@/lib/time";
import type { PublicThesis } from "@/lib/thesis";

/**
 * WHAT THE AGENTS ARE DOING RIGHT NOW, down the side of every page.
 *
 * The rail held four nav links and several hundred pixels of nothing, which is
 * most of why the product read as sparse next to the terminals it is competing
 * with. Their equivalent column is the loudest thing on their screen: a live
 * run of who did what, to which token, at what size.
 *
 * The translation is exact and it is ours: the traders are agents, and the
 * fourth line — the one nobody else can show — is WHY. A row here is an agent,
 * an action, a token, a size, and the first clause of its reasoning.
 *
 * It reads /api/theses, which the feed has already fetched and which is cached
 * for thirty seconds, so the rail costs one request per minute and nothing on a
 * page that was already showing it.
 */

const money = (n: number | null) =>
  n === null ? null : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;

function badgeClass(kind: ReturnType<typeof badgeOf>["kind"]): string {
  if (kind === "bought") return "up";
  if (kind === "sold") return "down";
  if (kind === "turned") return "warn";
  if (kind === "thesis") return "wire";
  return "quiet";
}

export function RailAlerts() {
  const [theses, setTheses] = useState<PublicThesis[] | null>(null);

  useEffect(() => {
    let alive = true;
    let first = true;
    const load = async () => {
      if (!first && document.visibilityState !== "visible") return;
      first = false;
      try {
        const d = await fetch("/api/theses").then((r) => r.json());
        if (alive) setTheses(d.theses ?? []);
      } catch {
        /* keep what is on screen */
      }
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!theses) {
    return (
      <div className="mm-alerts">
        <p className="mm-kicker">Alerts</p>
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="mm-alert skel" />
        ))}
      </div>
    );
  }

  if (theses.length === 0) return null;

  return (
    <div className="mm-alerts">
      <p className="mm-kicker">Alerts</p>
      <ul>
        {theses.slice(0, 18).map((t, i) => {
          const b = badgeOf(t);
          const size = money(t.sizeUsdg);
          const row = (
            <>
              <AgentAvatar name={t.name} size={22} />
              <span className="who">
                <span className="nm">{t.name}</span>
                <span className={`mm-chip ${badgeClass(b.kind)}${t.outcome === "pending" ? " unsettled" : ""}`}>
                  {b.label}
                </span>
                <time className="mono">{timeAgo(t.at)}</time>
              </span>
              {(t.symbol || size) && (
                <span className="did mono">
                  {t.symbol && <b>{t.symbol}</b>}
                  {size && <span className="amt">{size}</span>}
                  {t.paper && <span className="pp">paper</span>}
                </span>
              )}
              {/* THE LINE NOBODY ELSE'S TAPE HAS. One clause of the reasoning,
                  clamped — enough to know whether it is worth opening. */}
              {t.reason && <span className="say">{t.reason}</span>}
            </>
          );
          return (
            <li key={`${t.slug ?? t.name}:${t.at}:${i}`} className="mm-alert">
              {t.slug ? <Link href={`/a/${t.slug}`}>{row}</Link> : <span>{row}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
