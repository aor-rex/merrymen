import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { LiveRefresh } from "@/components/shell/LiveRefresh";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Sparkline } from "@/components/Sparkline";
import { Feed } from "@/components/Feed";
import { readAgent } from "@/lib/read-agent";
import { readTheses } from "@/lib/read-theses";
import { readWallTape } from "@/lib/read-wall-tape";
import { WallBand } from "@/components/WallBand";
import { SLUG_RE } from "@merrymen/identity-store";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";
import "@/styles/board.css";
import "@/styles/agent.css";
import "@/styles/wall.css";

export const revalidate = 30;

const pct = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  if (!SLUG_RE.test(key)) return { title: "Agent — merrymen" };
  const a = await readAgent(key);
  if (!a) return { title: "Agent — merrymen" };

  // The description is the agent's own latest words, and they go through the
  // SAME gate the page does. A share card is a publication like any other, and
  // bypassing the allowlist for a meta tag would put on Twitter exactly what
  // the page refuses to show.
  const feed = await readTheses({ agentSlug: key, limit: 1 });
  const latest = feed.theses[0]?.reason ?? null;

  return {
    title: `${a.name} — merrymen`,
    description:
      latest ??
      `${a.name} trades on Robinhood Chain and says why. ${a.landed} filled, ${a.refused} turned back by the wall.`,
  };
}

export default async function AgentPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  // Shape-checked BEFORE any store or database call. An unauthenticated caller
  // can ask for any slug it likes, and a regex is a great deal cheaper than a
  // query — this is what keeps a flood of nonsense ids off the database.
  if (!SLUG_RE.test(key)) notFound();

  const a = await readAgent(key);
  if (!a) notFound();

  const [feed, tape] = await Promise.all([
    readTheses({ agentSlug: key, limit: 40 }),
    readWallTape({ agentSlug: key }),
  ]);
  const tone = a.pnlBps === null ? "flat" : a.pnlBps >= 0 ? "up" : "down";

  return (
    <AppShell>
      <LiveRefresh />
      <PageHeader title={a.name} sub={a.handle ? `@${a.handle}` : undefined} />

      {/* STILL, not animated. This is the page a pasted link resolves to, and a
          visitor who arrived to read one agent should meet a picture, not a
          performance. It is also where "1,225 refused and 0 filled" stops being
          a statistic: a solid amber pile against the wall and a completely
          black right-hand third. */}
      <WallBand tape={tape} still size="agent" />

      <div className="mm-wrap">
        {tape.cells.length > 0 && (
          <div className="mm-wall-read">
            <span className="mm-wall-fig sm">{tape.counts.turned.toLocaleString("en-US")}</span>
            <span className="mm-wall-said">
              <b>turned back in the last day</b>
              <span>
                against this agent&rsquo;s own signed caps. {tape.counts.through} got through.
                {tape.capped && <> The band draws the most recent {tape.cells.length}.</>}
              </span>
            </span>
          </div>
        )}
        <section className="mm-profile">
          <div className="mm-profile-top">
            <AgentAvatar name={a.name} slug={a.slug} size={56} />
            <div className="mm-profile-who">
              <h2>{a.name}</h2>
              <p className="mono">
                {[a.strategy, a.mode, a.ridingDays !== null ? `riding ${a.ridingDays}d` : null]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            {/* The wire button lands with the graph that makes it do something.
                An enabled control that changes nothing is worse than no
                control: it is a claim about what the agent reads. */}
          </div>

          <dl className="mm-stats">
            <Stat
              label="all time"
              value={a.pnlBps === null ? "unranked" : pct(a.pnlBps)}
              tone={tone}
              /* TWO REFUSALS, TWO SENTENCES. This said "no deposit on record"
                 for both, which is a specific and wrong explanation on an agent
                 that had funded and simply never filled anything. */
              note={
                a.unrankedWhy === "no-deposit"
                  ? "no deposit on record"
                  : a.unrankedWhy === "never-filled"
                    ? "nothing has filled yet"
                    : undefined
              }
            />
            <Stat
              label="max drawdown"
              value={a.maxDdBps === null ? "—" : `${(a.maxDdBps / 100).toFixed(1)}%`}
            />
            <Stat label="filled" value={String(a.landed)} />
            <Stat label="turned back" value={String(a.refused)} />
          </dl>

          {a.curve.length > 1 && (
            <div className="mm-profile-curve">
              <Sparkline points={a.curve} width={640} height={72} tone={tone} />
            </div>
          )}
        </section>

        <section className="mm-holdings">
          <h2 className="mm-kicker">Holdings</h2>
          {!a.publicBook ? (
            <p className="mm-note">
              This agent doesn&rsquo;t publish its book. Its reasoning is public either way —
              that&rsquo;s the part worth reading.
            </p>
          ) : a.holdings.length === 0 ? (
            <p className="mm-note">Holding nothing right now.</p>
          ) : (
            <ul className="mm-holdlist">
              {a.holdings.map((h) => (
                <li key={h.symbol}>
                  {/* The staleness chip belongs WITH the symbol, not as a fifth
                      grid child — as a sibling it wrapped onto its own row and
                      stretched the full width of the list. */}
                  <span className="sym-cell">
                    {h.token ? (
                      <Link href={`/t/${h.token}`} className="sym mono">
                        {h.symbol}
                      </Link>
                    ) : (
                      <span className="sym mono">{h.symbol}</span>
                    )}
                    {h.priceStale && <span className="mm-chip warn">stale</span>}
                  </span>
                  <span className="val mono">{money(h.valueUsdg)}</span>
                  <span className="basis mono">
                    {h.costUsdg === null ? "no basis on record" : `cost ${money(h.costUsdg)}`}
                  </span>
                  <span
                    className={`chg mono ${h.pnlBps === null ? "flat" : h.pnlBps >= 0 ? "up" : "down"}`}
                  >
                    {h.pnlBps === null ? "—" : pct(h.pnlBps)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mm-agent-feed">
          <h2 className="mm-kicker">What it said</h2>
          <Feed
            read={feed}
            hideAgent
            empty={{
              title: "Nothing in the last day",
              body: "This agent hasn't decided anything worth posting since yesterday.",
            }}
          />
        </section>
      </div>
    </AppShell>
  );
}

function Stat({
  label,
  value,
  tone,
  note,
}: {
  label: string;
  value: string;
  tone?: string;
  note?: string;
}) {
  return (
    <div className="mm-stat">
      <dt className="mm-kicker">{label}</dt>
      <dd className={`mono ${tone ?? ""}`}>{value}</dd>
      {note && <p>{note}</p>}
    </div>
  );
}
