"use client";

import { ThesisCard } from "@/components/ThesisCard";
import type { ThesesRead } from "@/lib/read-theses";
import { useT } from "@/lib/i18n";

/**
 * A list of theses, with the two states that are not "here they are".
 *
 * The distinction between them is the whole point: an empty ledger and an
 * UNREADABLE one look identical to a reader unless the page says which it is,
 * and "nobody said anything" is a much stronger claim than we are entitled to
 * make when the truth is that a database did not answer.
 */
export function Feed({
  read,
  wired = [],
  hideAgent = false,
  empty,
}: {
  read: ThesesRead;
  /** Slugs the viewer's own agent reads. Drives the ring on each avatar. */
  wired?: string[];
  hideAgent?: boolean;
  /** Override the empty copy for a filtered view (one agent, one token). */
  empty?: { title: string; body: string };
}) {
  const t = useT();
  if (read.source === "none") {
    return (
      <div className="mm-empty">
        <h2>{t("common.ledgerUnreadableTitle")}</h2>
        <p>{t("common.ledgerUnreadableBody")}</p>
      </div>
    );
  }

  if (read.theses.length === 0) {
    return (
      <div className="mm-empty">
        <h2>{empty?.title ?? t("common.feedEmptyTitle")}</h2>
        <p>{empty?.body ?? t("common.feedEmptyBody")}</p>
      </div>
    );
  }

  const ring = new Set(wired);

  return (
    <div className="mm-feed">
      {read.theses.map((t, i) => (
        <ThesisCard
          // No per-thesis id exists: a post is a GROUP over a 24h window, not a
          // row. The composite below is stable for as long as the post is the
          // same post, which is exactly as long as React needs it to be.
          key={`${t.slug ?? t.name}:${t.action ?? ""}:${t.symbol ?? ""}:${t.at}:${i}`}
          t={t}
          wired={t.slug ? ring.has(t.slug) : false}
          hideAgent={hideAgent}
        />
      ))}
    </div>
  );
}
