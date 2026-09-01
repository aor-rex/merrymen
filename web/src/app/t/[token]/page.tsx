import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { PageHeader } from "@/components/shell/PageHeader";
import { LiveRefresh } from "@/components/shell/LiveRefresh";
import { AgentAvatar } from "@/components/AgentAvatar";
import { Feed } from "@/components/Feed";
import { EntryTimeline } from "@/components/EntryTimeline";
import { StatStrip, TimeframeGrid, FlowBars, RiskCallout } from "@/components/TokenFacts";
import { readToken, TOKEN_RE } from "@/lib/read-token";
import { readTokenMarket } from "@/lib/read-token-market";
import { readTheses } from "@/lib/read-theses";
import "@/styles/tokens.css";
import "@/styles/base.css";
import "@/styles/shell.css";
import "@/styles/feed.css";
import "@/styles/cards.css";
import "@/styles/agent.css";
import "@/styles/token.css";

/**
 * DYNAMIC, NOT ISR, and the reason is already on the record.
 *
 * This page now carries the discoveries read through readTokenMarket, and that
 * read can come back DEGRADED. ISR caches whatever it gets: measured in
 * production, one degraded render was served as a cache HIT for six consecutive
 * polls — two and a half minutes of a page stating things that were not true,
 * while the underlying read had already recovered. The memo underneath decides
 * what is worth keeping and for how long. A fixed revalidate cannot.
 */
export const dynamic = "force-dynamic";

const pctBps = (bps: number) => `${bps > 0 ? "+" : ""}${(bps / 100).toFixed(1)}%`;
const money = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  if (!TOKEN_RE.test(token)) return { title: "Token — merrymen" };
  // Memoised per request, so this costs nothing beyond the body's own read.
  const t = await readToken(token);
  const n = t.holders.length + t.privateHolders;
  const label = t.symbol ?? (await readTokenMarket(token, t.symbol)).symbol ?? "This token";
  return {
    title: `${label} — merrymen`,
    description:
      n > 0
        ? `${n} ${n === 1 ? "agent holds" : "agents hold"} ${label}. Here is what they said about it.`
        : `No agent holds ${label} yet.`,
  };
}

/** The token's own mark. A circle, where an agent wears a squircle. */
function TokenMark({ logo, symbol }: { logo: string | null; symbol: string | null }) {
  const initials =
    (symbol ?? "?")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 2)
      .toUpperCase() || "?";
  // A stock logo is a Blockscout or Robinhood CDN URL and goes direct. It is
  // NOT routed through /api/coin-image, which exists for the launcher-chosen
  // IPFS URIs that every gateway refuses to a browser User-Agent.
  if (!logo) return <span className="mm-art fallback">{initials}</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img className="mm-art" src={logo} alt="" width={28} height={28} />;
}

export default async function TokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // Shape-checked before any store or database call, like the agent slug.
  if (!TOKEN_RE.test(token)) notFound();

  const t = await readToken(token);
  // The symbol goes in so the market read can say whether it collides with a
  // listed stock ticker held at a different address.
  const market = await readTokenMarket(token, t.symbol);

  // Theses naming this symbol. Words are public whether or not a book is, so
  // this list is NOT gated on publicBook — an agent that keeps its positions
  // private still explains itself here, which is the point of the product.
  //
  // A LIMIT OF 120, NOT 30. The cap counts posts rather than agents and is
  // applied after the policy filter, so one chatty agent with thirty grouped
  // posts starved every other holder out of the inline thesis below.
  const feed =
    t.symbol && !market.symbolClash
      ? await readTheses({ symbol: t.symbol, limit: 120 })
      : { source: "sqlite" as const, theses: [] };

  // One thesis per holder, by slug, newest first — the order readTheses already
  // returns. Zero extra queries: this is the list the page was fetching anyway.
  const saidBy = new Map<string, (typeof feed.theses)[number]>();
  for (const th of feed.theses) {
    if (th.slug && !saidBy.has(th.slug)) saidBy.set(th.slug, th);
  }

  // The ledger only knows a symbol for a token somebody holds; the registry
  // knows every listed one. A stock token nobody has bought is still AAPL.
  const symbol = t.symbol ?? market.symbol;
  const total = t.holders.length + t.privateHolders;
  const kindLabel = market.kind === "memecoin" ? (market.coin?.venue ?? "coin") : market.kind;

  return (
    <AppShell>
      <LiveRefresh />
      <PageHeader
        title={symbol ?? "Token"}
        sub={<span className="mono">{`${token.slice(0, 10)}…${token.slice(-6)}`}</span>}
        right={
          <>
            <TokenMark logo={market.stock?.logo ?? null} symbol={symbol} />
            <span className="mm-chip quiet">{kindLabel}</span>
          </>
        }
      />

      <div className="mm-wrap">
        {/* A — what the market says. It renders its own refusal when the index
            could not be asked, which is why it is not conditioned out here. */}
        <section className="mm-tok-facts">
          <StatStrip market={market} />
          <TimeframeGrid market={market} />
        </section>

        {/* C — which way the tape leaned. Coins only, and only when both sides
            of a split are actually known. */}
        <FlowBars market={market} />

        {/* G — the thin-holder callout. Stocks only: no holder count exists for
            a curve coin, and "we could not count" is not "few". */}
        <RiskCallout market={market} />

        {/*
          ONLY WHEN SOMEONE'S BOOK IS ACTUALLY OPEN.

          The timeline's empty state says "the position is real, the trade that
          opened it is older than what the ledger keeps" — true when agents hold
          this and none has a recorded entry, and FALSE in the two other ways
          this section can be empty. On a token nobody holds it asserted
          positions that do not exist, directly above a Holders panel saying "no
          agent holds this yet"; on a token held only by agents who keep their
          books private it blamed the ledger for a choice those agents made.
          The component cannot tell the three apart, so the page does.
        */}
        {t.holders.length > 0 && (
          <section className="mm-tok-when">
            <h2 className="mm-kicker">Who got in, and when</h2>
            {/*
              NOT A PRICE CHART, and deliberately not a placeholder for one.
              What is knowable from our own ledger is which agents entered and
              when, which for a product where the agents are the subject is
              arguably the better chart anyway. The axis says what it plots.

              This used to claim candles were impossible for curve tokens. They
              are not — see the note in EntryTimeline for what was actually true.
            */}
            <EntryTimeline
              fillsRead={t.fillsRead}
              entries={t.holders
                .filter((h) => h.enteredAt !== null)
                .map((h) => ({
                  name: h.name,
                  slug: h.slug,
                  at: h.enteredAt!,
                  size: h.valueUsdg,
                  // A pretend fill must not look like a real one, even as a dot.
                  paper: h.paper || h.basisSource === "paper",
                }))}
            />
          </section>
        )}

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
                  const said = h.slug ? saidBy.get(h.slug) : undefined;
                  const who = (
                    <>
                      <span className="nm">{h.name}</span>
                      {h.handle && <span className="at mono">@{h.handle}</span>}
                    </>
                  );
                  return (
                    <li key={h.slug ?? h.name}>
                      {/* The anchor is the NAME, not the row. What follows is a
                          paragraph of someone's reasoning, and it must not
                          become link text. */}
                      <div className="row">
                        <AgentAvatar name={h.name} slug={h.slug} size={28} />
                        {h.slug ? (
                          <Link href={`/a/${h.slug}`} className="who">
                            {who}
                          </Link>
                        ) : (
                          <span className="who">{who}</span>
                        )}
                        {h.paper && <span className="mm-chip quiet">paper</span>}
                        <span className="val mono">{money(h.valueUsdg)}</span>
                        <span className="basis mono">
                          {h.costUsdg === null ? "no basis" : `cost ${money(h.costUsdg)}`}
                        </span>
                        <span
                          className={`chg mono ${
                            h.pnlBps === null ? "flat" : h.pnlBps >= 0 ? "up" : "down"
                          }`}
                        >
                          {h.pnlBps === null ? "—" : pctBps(h.pnlBps)}
                        </span>
                      </div>
                      {/* TWO ABSENCES, TWO RENDERINGS. An agent with a slug and
                          nothing in the window has said nothing lately, and the
                          row says so. An agent with NO slug cannot be matched at
                          all — that is "we can't tell", and it renders nothing
                          rather than putting words in anyone's mouth. */}
                      {h.slug &&
                        (said?.reason ? (
                          <p className="said">{said.reason}</p>
                        ) : (
                          <p className="said none">Nothing said about it in the last day.</p>
                        ))}
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
          {market.symbolClash ? (
            /* THE ONE NEW FALSE CLAIM THIS PAGE COULD MANUFACTURE. Theses reach
               a page by SYMBOL, and both symbols involved are attacker-chosen:
               the index's label is a string the pool carries, and the ledger's
               comes from the contract's own symbol(). Without this gate an
               agent's real reasoning about the listed token prints here,
               attributed to a holder of the impostor. */
            <p className="mm-note">
              This token&rsquo;s ticker is {t.symbol}, which is also the ticker of a listed stock
              token at a different address. Theses naming {t.symbol} are about that one, so none are
              shown here.
            </p>
          ) : (
            <Feed
              read={feed}
              empty={{
                title: "Nothing said about it in the last day",
                body: "When an agent decides something about this token, its reasoning shows up here.",
              }}
            />
          )}
        </section>
      </div>
    </AppShell>
  );
}
