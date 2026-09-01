import { AgentAvatar } from "@/components/AgentAvatar";

/**
 * WHO GOT IN, AND WHEN.
 *
 * The reference product plots trader avatars on a price line. This plots them
 * on a TIME line, and the difference is not a compromise — it is what the data
 * actually supports and, for a product whose subject is the agents, arguably
 * the better chart.
 *
 * There is no OHLC anywhere in this repo, and the index reports a null pool
 * address for the 32-byte curve poolIds that cover most of what is interesting
 * on this chain — so for those tokens candles are not "coming later", they are
 * impossible. Drawing an empty chart box that promises one would be the exact
 * failure mode this codebase keeps refusing.
 *
 * The axis is labelled with what it plots. Nothing here implies a price.
 */
export interface Entry {
  name: string;
  /** The public id, so the pin wears the same face as everywhere else. */
  slug?: string | null;
  /** Unix seconds. */
  at: number;
  /** Position value, used only to order overlaps — never drawn as a y value. */
  size: number;
}

export function EntryTimeline({ entries }: { entries: Entry[] }) {
  if (entries.length === 0) {
    return (
      <p className="mm-note">
        No entry times on record for the agents holding this. That is missing data, not an empty
        book — the position is real, the trade that opened it is older than what the ledger keeps.
      </p>
    );
  }

  const times = entries.map((e) => e.at);
  const min = Math.min(...times);
  const max = Math.max(...times);
  // A single entry, or several in the same second, would divide by zero and
  // stack on the left edge. Centre them instead.
  const span = max - min || 1;
  const single = max === min;

  const sorted = [...entries].sort((a, b) => a.at - b.at);

  return (
    <div className="mm-timeline">
      <div className="track">
        <div className="line" />
        {sorted.map((e, i) => {
          const x = single ? 50 : ((e.at - min) / span) * 100;
          return (
            <span
              key={`${e.name}:${e.at}:${i}`}
              className="pin"
              style={{ left: `${x}%`, zIndex: sorted.length - i }}
              title={`${e.name} — ${new Date(e.at * 1000).toLocaleString()}`}
            >
              <AgentAvatar name={e.name} slug={e.slug ?? null} size={26} />
            </span>
          );
        })}
      </div>
      <div className="axis mono">
        <span>{single ? "all at once" : rel(min)}</span>
        <span className="mid">entry time — not price</span>
        <span>{single ? "" : rel(max)}</span>
      </div>
    </div>
  );
}

function rel(at: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
