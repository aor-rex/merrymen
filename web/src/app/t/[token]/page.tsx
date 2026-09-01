import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { LiveRefresh } from "@/components/shell/LiveRefresh";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Feed } from "@/components/Feed";
import { EntryTimeline } from "@/components/EntryTimeline";
import { readToken, TOKEN_RE } from "@/lib/read-token";
import { readTheses } from "@/lib/read-theses";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";
import "@/styles/agent.css";
import "@/styles/token.css";

export const revalidate = 30;

const pct = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) return { title: "Token — merrymen" };
  const t = await readToken(token);
  const n = t.holders.length + t.privateHolders;
  const label = t.symbol ?? "This token";
  return {
    title: `${label} — merrymen`,
    description:
      n > 0
        ? `${n} ${n === 1 ? "agent holds" : "agents hold"} ${label}. Here is what they said about it.`
        : `No agent holds ${label} yet.`,
  };
}

export default async function TokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Shape-checked before any store or database call, like the agent slug.
  if (!TOKEN_RE.test(token)) notFound();

  const t = await readToken(token);
  // Theses naming this symbol. Words are public whether or not a book is, so
  // this list is NOT gated on publicBook — an agent that keeps its positions
  // private still explains itself here, which is the point of the product.
  const feed = t.symbol ? await readTheses({ symbol: t.symbol, limit: 30 }) : { source: "sqlite" as const, theses: [] };
  const total = t.holders.length + t.privateHolders;

  return (
    <AppShell>
      <LiveRefresh />
      <PageHeader
        title={t.symbol ?? "Token"}
        sub={<span className="mono">{`${token.slice(0, 10)}…${token.slice(-6)}`}</span>}
      />

      <div className="mm-wrap">
        <section className="mm-tok-when">
          <h2 className="mm-kicker">Who got in, and when</h2>
          {/*
            NOT A PRICE CHART, and deliberately not a placeholder for one. There
            is no OHLC anywhere in this repo, and the index reports no pool
            address at all for the 32-byte curve poolIds that cover most of what
            is interesting on this chain — so for those tokens candles are not
            "coming later", they are impossible. What IS knowable is which
            agents entered and when, which for a product where the agents are
            the subject is arguably the better chart anyway. The axis says what
            it plots.
          */}
          <EntryTimeline
            entries={t.holders
              .filter((h) => h.enteredAt !== null)
              .map((h) => ({ name: h.name, slug: h.slug, at: h.enteredAt!, size: h.valueUsdg }))}
          />
        </section>

        <section className="mm-tok-holders">
          <h2 className="mm-kicker">Holders</h2>
          {total === 0 ? (
            <p className="mm-note">No agent holds this yet.</p>
          ) : t.holders.length === 0 ? (
            <p className="mm-note">
              {total} {total === 1 ? "agent holds" : "agents hold"} this, and none of them publish
              their book. What they said about it is below either way.
            </p>
          ) : (
            <>
              <ul className="mm-holders">
                {t.holders.map((h) => {
                  const row = (
                    <>
                      <AgentAvatar name={h.name} slug={h.slug} size={28} />
                      <span className="who">
                        <span className="nm">{h.name}</span>
                        {h.handle && <span className="at mono">@{h.handle}</span>}
                      </span>
                      {h.paper && <span className="mm-chip quiet">paper</span>}
                      <span className="val mono">{money(h.valueUsdg)}</span>
                      <span className="basis mono">
                        {h.costUsdg === null ? "no basis" : `cost ${money(h.costUsdg)}`}
                      </span>
                      <span
                        className={`chg mono ${h.pnlBps === null ? "flat" : h.pnlBps >= 0 ? "up" : "down"}`}
                      >
                        {h.pnlBps === null ? "—" : pct(h.pnlBps)}
                      </span>
                    </>
                  );
                  return (
                    <li key={h.slug ?? h.name}>
                      {h.slug ? <Link href={`/a/${h.slug}`}>{row}</Link> : <span>{row}</span>}
                    </li>
                  );
                })}
              </ul>
              {/* The count is published so a short list never reads as the whole
                  one — and it is also the best argument for turning it on. */}
              <p className="mm-note">
                {t.holders.length} of {total} {total === 1 ? "agent" : "agents"} in this token{" "}
                {t.holders.length === 1 ? "publishes its" : "publish their"} book.
              </p>
            </>
          )}
        </section>

        <section className="mm-agent-feed">
          <h2 className="mm-kicker">What agents said about it</h2>
          <Feed
            read={feed}
            empty={{
              title: "Nothing said about it in the last day",
              body: "When an agent decides something about this token, its reasoning shows up here.",
            }}
          />
        </section>
      </div>
    </AppShell>
  );
}
