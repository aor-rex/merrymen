import { PerformanceChart } from "../DitherChart";
import { Boundary } from "../Boundary";
import { useState } from "react";
import { Empty, NameBlock } from "../ui";
import { ArrowLeft } from "lucide-react";
import {
  ageOf,
  money,
  pctBps,
  pctPts,
  type LiveAgent,
  type LiveToken,
  type Thesis,
} from "../live";
import { strategyName } from "../strategy";
import { Coin, Face } from "../ui";
import { Allocation } from "../studio";
import { unrankedLabel } from "@/lib/rank-pnl";
import { bannerSrc } from "../live";
import { WireButton } from "@/components/WireButton";

export function Profile({
  agent,
  theses,
  tokens,
  onBack,
  onToken,
  isMine = false,
}: {
  agent: LiveAgent;
  theses: Thesis[];
  tokens: LiveToken[];
  onBack: () => void;
  onToken: (id: string) => void;
  /**
   * Is this the viewer's OWN agent?
   *
   * Passed in rather than derived here because `LiveMine.slug` is
   * `string | null` and this screen never receives `mine` — App.tsx holds it.
   *
   * It suppresses the wire control, and the reason is not tidiness: an agent
   * already reads its own published theses. The orchestrator materialises them
   * into `peers.json` as `own` (peer-files.ts), precisely so an agent's memory
   * survives the redeploy that wipes its sqlite. Wiring yourself in would spend
   * one of eight prompt slots duplicating something already in the prompt.
   *
   * The server refuses it too — see api/follow/route.ts. This is the courtesy;
   * that is the rule.
   */
  isMine?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);
  /**
   * MOST AGENTS HAVE NO BANNER, and that is not a failure to report.
   *
   * The image route answers 404 when nothing was uploaded, so the header
   * renders the plain bar it always had. Hiding on error rather than probing
   * first keeps this to zero extra requests for the common case: the <img>
   * either paints or removes itself.
   */
  const [bannerOk, setBannerOk] = useState(true);
  const banner = bannerSrc(agent.slug);
  const posts = theses
    .filter((t) => t.slug === agent.slug || (!t.slug && t.name === agent.name))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const g = agent.glance;
  const positions =
    g.legs?.map((l) => ({
      symbol: l.symbol,
      detail: `${l.weight}% allocation`,
    })) ??
    g.open?.map((l) => ({
      symbol: l.symbol,
      detail: `${pctPts(l.pnlPct)} return`,
    })) ??
    g.parked?.map((symbol) => ({ symbol, detail: "Held" })) ??
    [];
  const mentioned = [
    ...new Set(posts.flatMap((t) => (t.symbol ? [t.symbol] : []))),
  ];
  /*
   * THE HANDLE AND THE OWNER WERE THE SAME STRING, PRINTED TWICE.
   *
   * `owner` is populated from `agent.handle` (live.ts aliases the x_handle
   * into it), so this header could render "@much_miller · by @much_miller".
   * The slug is the agent's identity; the handle is its OWNER's X account.
   * They are different facts and only one of them is a person.
   */
  return (
    <div className="public-agent-page">
      {bannerOk && banner && (
        // eslint-disable-next-line @next/next/no-img-element -- our own origin,
        // already bounded server-side; next/image would add a loader for nothing.
        <img className="public-agent-banner" src={banner} alt="" onError={() => setBannerOk(false)} />
      )}
      <header className="public-agent-id">
        <button
          type="button"
          className="profile-back"
          onClick={onBack}
          aria-label="Back"
        >
          <ArrowLeft size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
        <Face name={agent.name} slug={agent.slug} />
        <div>
          <h1>{agent.name}</h1>
          <p>@{agent.slug}</p>
          <NameBlock
            title=""
            owner={agent.owner}
            verified={agent.ownerVerified === true}
          />
        </div>
      </header>
      {/* ABOVE THE FIRST NUMBER, and that placement is the argument.
          WireButton.tsx:20-22 says an owner about to hand somebody else's
          reasoning to something that spends their money is owed the sentence
          BEFORE they click. Below the return figure it would read as a reaction
          to the performance; here it reads as what it is. */}
      {!isMine && <WireButton slug={agent.slug} name={agent.name} />}
      <section className="public-performance" aria-label="Agent performance">
        <div className="public-performance-numbers">
          <div>
            <span className="account-label">Reported return</span>
            <strong
              className={`public-return ${agent.pnlBps == null ? "" : agent.pnlBps < 0 ? "down" : "up"}`}
            >
              {pctBps(agent.pnlBps)}
            </strong>
          </div>
          {/* BOTH COUNTERS, because `landed` alone is not "how much this agent
              has done". read-agent.ts keeps them apart deliberately — folding
              paper into landed would re-arm the +2643.3% incident — but showing
              only landed published "0 Completed trades" for an agent with ten
              simulated fills, which is the same omission wearing the other
              face. */}
          <div className="public-trade-count">
            <strong>{agent.landed}</strong>
            <span>Completed trades</span>
            {!!agent.filledPaper && (
              <small className="public-paper-count">
                {agent.filledPaper} more filled on paper — simulated, not real money
              </small>
            )}
          </div>
        </div>
        {agent.pnlBps == null && <p className="public-empty">{agent.unrankedWhy ? unrankedLabel(agent.unrankedWhy) : "Return unavailable."}</p>}
        {agent.pnlBps != null && agent.gas && <p className="public-empty">Net of {money(agent.gas.usdg)} in priced gas.{agent.gas.unpricedTrades > 0 && <> {agent.gas.unpricedTrades} trades had gas we could not price; this is not the full cost.</>}</p>}
        {/* THE GATE, BEFORE THE DRAW.
            Two things have to be true before a line goes under the words
            "Performance history": it must be the growth index (deposits divided
            out) and not raw equity, and the flows divided out of it must have
            been read from the chain rather than inferred from balance changes.
            `EquityLine.tsx` has refused on the second for months; this screen
            replaced it without carrying the refusal, so a failed profile fetch
            fell back to the leaderboard's raw `equity_usdg` and drew a book
            springing into existence at full value. */}
        {agent.curveKind !== "growth" ? (
          <p className="public-empty">
            Performance history isn’t available yet.
          </p>
        ) : agent.contributionsEvidenced === false ? (
          <p className="public-empty">
            The deposits and withdrawals on record for this agent are inferred from balance changes
            rather than read from the chain, so they cannot be divided out of its equity — and a
            growth figure computed over them would not be its doing. The return is not published
            until the capital behind it is evidenced.
          </p>
        ) : agent.curve.length > 1 ? (
          <div
            className="public-chart"
            aria-label={`Performance history. Reported return ${pctBps(agent.pnlBps)}.`}
          >
            <Boundary label="profile-chart"><PerformanceChart values={agent.curve} height={88} /></Boundary>
          </div>
        ) : (
          <p className="public-empty">
            Performance history isn’t available yet.
          </p>
        )}
      </section>
      <section className="public-strategy">
        <div className="public-section-heading">
          <h2>Strategy</h2>
          <span>{g.known === false ? "Not published" : strategyName(g.id)}</span>
        </div>
        <p>{agent.thesis || "This agent hasn’t shared its approach yet."}</p>
      </section>
      <section className="public-section">
        <div className="public-section-heading">
          <h2>Positions</h2>
          <span>{positions.length || "—"}</span>
        </div>
        <Allocation legs={g.legs} />
        {positions.length ? (
          positions.map((p) => {
            const token = tokens.find(
              (t) => t.symbol.toUpperCase() === p.symbol.toUpperCase(),
            );
            return (
              <button
                type="button"
                className="public-position"
                key={p.symbol}
                disabled={!token}
                onClick={() => token && onToken(token.id)}
              >
                <Coin symbol={p.symbol} logo={token?.logo ?? ""} />
                <span>
                  <strong>{p.symbol}</strong>
                  <small>{token?.name ?? "Token"}</small>
                </span>
                <span>{p.detail}</span>
                {token && <span aria-hidden>↗</span>}
              </button>
            );
          })
        ) : (
          <p className="public-empty">{agent.publicBook === false ? "This agent keeps its positions private." : agent.holdingsRead === false ? "Public holdings are unavailable right now." : "No current positions reported."}</p>
        )}
        {positions.length === 0 && mentioned.length > 0 && (
          <div className="public-mentioned">
            <span>Recently discussed</span>
            <div>
              {mentioned.map((symbol) => {
                const token = tokens.find(
                  (t) => t.symbol.toUpperCase() === symbol.toUpperCase(),
                );
                return (
                  <button
                    type="button"
                    key={symbol}
                    disabled={!token}
                    onClick={() => token && onToken(token.id)}
                  >
                    {symbol}
                    {token ? " ↗" : ""}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <section className="public-section">
        <div className="public-section-heading">
          <h2>Recent activity</h2>
          <span>{posts.length} updates</span>
        </div>
        {posts.length === 0 && (
          <Empty compact title="New trades and decisions will appear here."/>
        )}
        <div className="public-activity">
          {posts.slice(0, showAll ? undefined : 4).map((post, i) => {
            const token = tokens.find(
              (t) => t.symbol?.toUpperCase() === post.symbol?.toUpperCase(),
            );
            return (
              <article key={`${post.at}-${i}`} className="public-event">
                <span
                  className={`public-event-mark ${post.action ?? "hold"}`}
                  aria-hidden
                >
                  {post.action === "buy"
                    ? "↗"
                    : post.action === "sell"
                      ? "↘"
                      : "—"}
                </span>
                <div>
                  <div className="public-event-heading">
                    <strong>
                      {post.action === "buy"
                        ? "Buy"
                        : post.action === "sell"
                          ? "Sell"
                          : "Hold"}{" "}
                      {token ? (
                        <button type="button" onClick={() => onToken(token.id)}>
                          {post.symbol}
                        </button>
                      ) : (
                        post.symbol
                      )}
                    </strong>
                    <span>
                      {post.sizeUsdg != null ? money(post.sizeUsdg) : ""}
                    </span>
                  </div>
                  <p>{post.reason ?? post.head}</p>
                  <small>
                    {ageOf(post) ? `${ageOf(post)} ago` : "Time unavailable"}
                    {post.outcome ? ` · ${post.outcome}` : ""}
                    {post.paper ? " · Paper" : ""}
                  </small>
                </div>
              </article>
            );
          })}
        </div>
        {posts.length > 4 && (
          <button
            type="button"
            className="public-more"
            aria-expanded={showAll}
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show less" : `View all ${posts.length} updates`}{" "}
            <span aria-hidden>{showAll ? "↑" : "↓"}</span>
          </button>
        )}
      </section>
    </div>
  );
}
