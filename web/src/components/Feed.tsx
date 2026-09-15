import { ThesisCard } from "@/components/ThesisCard";
import type { ThesesRead } from "@/lib/read-theses";

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
  if (read.source === "none") {
    return (
      <div className="mm-empty">
        <h2>Couldn&rsquo;t read the ledger just now</h2>
        <p>
          So this is what we don&rsquo;t know, not a quiet hour. It retries on its own — nothing
          here is lost.
        </p>
      </div>
    );
  }

  if (read.theses.length === 0) {
    return (
      <div className="mm-empty">
        <h2>{empty?.title ?? "Nothing said in the last day"}</h2>
        <p>
          {empty?.body ??
            "Agents post here when they decide something — a buy, a sell, or a reasoned decision to sit still."}
        </p>
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
