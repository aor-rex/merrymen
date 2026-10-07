import { PerformanceChart } from "../DitherChart";
import { Boundary } from "../Boundary";
import { useEffect, useState } from "react";
import { Empty, NameBlock } from "../ui";
import { ArrowLeft } from "lucide-react";
import {
  ageOf,
  money,
  pctBps,
  pctPts,
  type LiveToken,
  type Thesis,
} from "../live";
import { strategyName } from "../strategy";
import { Coin, Face, Switch } from "../ui";
import { Allocation } from "../studio";
import { unrankedLabel } from "@/lib/rank-pnl";
import { useAgentImageSrc } from "../agent-image-state";
import { WireButton } from "@/components/WireButton";
import { fullDateTime } from "@/lib/format";
import { useNow } from "../clock";
import {
  chartWindows,
  defaultWindow,
  fetchOwnBook,
  growthWindow,
  saveBook,
  statsParts,
  topTradeFigures,
  type ChartWindow,
  type OwnBookView,
  type ProfileAgent,
} from "../profile-view";
import { SwapsTable } from "../SwapsTable";
import { swapRowsOfProfile } from "../swaps";
import { useT } from "@/lib/i18n";

export function Profile({
  agent,
  theses,
  tokens,
  onBack,
  onToken,
  isMine = false,
  activityError = "",
  onBookChanged,
}: {
  agent: ProfileAgent;
  theses: Thesis[];
  tokens: LiveToken[];
  onBack: () => void;
  onToken: (id: string) => void;
  /**
   * Re-read the profile after the owner publishes or closes the book, so the
   * page shows the dollars (or stops showing them) now rather than at the next
   * thirty-second refresh.
   */
  onBookChanged?: () => void;
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
  activityError?: string;
}) {
  const t = useT();
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
  const banner = useAgentImageSrc(agent.slug, "banner");
  useEffect(() => setBannerOk(true), [banner]);
  const posts = theses
    .filter((t) => t.slug === agent.slug || (!t.slug && t.name === agent.name))
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  const g = agent.glance;
  const displayPnl = agent.mode === "paper" ? agent.paperPnlBps ?? null : agent.pnlBps;
  const positions =
    g.legs?.map((l) => ({
      symbol: l.symbol,
      detail: t("profile.allocation", { weight: l.weight }),
    })) ??
    g.open?.map((l) => ({
      symbol: l.symbol,
      detail: t("profile.returnDetail", { value: pctPts(l.pnlPct) }),
    })) ??
    g.parked?.map((symbol) => ({ symbol, detail: t("profile.held") })) ??
    [];
  const mentioned = [
    ...new Set(posts.flatMap((t) => (t.symbol ? [t.symbol] : []))),
  ];
  /**
   * THE OWNER'S OWN FIGURES, on the owner's own page of a private book.
   *
   * The public read withholds a private book's money from everyone, so the
   * owner's own sizes and dollars come from their session-checked read
   * (profile-view.ts fetchOwnBook). Asked for only here, and the server decides
   * whether this session owns the slug. Re-read whenever the public read is.
   */
  const own = useOwnBook(isMine && agent.publicBook === false ? agent.slug : null, agent.recentTrades);
  const recentTrades = own?.recentTrades ?? agent.recentTrades;
  const topTrades = own?.topTrades ?? agent.topTrades;
  /**
   * DOLLARS ON THIS PAGE: a published book, or the owner's own view — the
   * spec's rule. One rule for every figure on it, TOP TRADES and Buys & sells
   * alike, so neither leans on the server alone. On the owner's view the money
   * comes only from the owner's read; the public lists carry none.
   */
  const showMoney = agent.publicBook === true || own !== null;
  const stats = statsParts({
    tradeCount: agent.tradeCount,
    tradeCountFloor: agent.tradeCountFloor,
    avgHoldSec: agent.avgHoldSec,
    joinedAt: agent.joinedAt,
    paper: agent.mode === "paper",
    gasless: agent.gasless,
  });
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
          {/* Each term only when it was read — statsParts leaves out the rest
              rather than print a stand-in for it. */}
          {stats.length > 0 && <p className="profile-stats">{stats.join(" · ")}</p>}
        </div>
      </header>
      {/* THE OWNER'S OWN CALL, on the owner's own page, and only once we know
          which way it stands: a switch drawn "off" for a profile that has not
          loaded would be a claim about a setting nobody read. */}
      {isMine && typeof agent.publicBook === "boolean" && (
        <BookSwitch on={agent.publicBook} onChanged={onBookChanged} />
      )}
      {/* ABOVE THE FIRST NUMBER, and that placement is the argument.
          WireButton.tsx:20-22 says an owner about to hand somebody else's
          reasoning to something that spends their money is owed the sentence
          BEFORE they click. Below the return figure it would read as a reaction
          to the performance; here it reads as what it is. */}
      {!isMine && <WireButton slug={agent.slug} name={agent.name} />}
      <section className="public-performance" aria-label="Agent performance">
        <div className="public-performance-numbers">
          <div>
            <span className="account-label">{agent.mode === "paper" ? t("profile.paperReturn") : t("profile.netReturn")}</span>
            <strong
              className={`public-return ${displayPnl == null ? "" : displayPnl < 0 ? "down" : "up"}`}
            >
              {pctBps(displayPnl)}
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
            <span>{t("profile.completedOps")}</span>
            {!!agent.filledPaper && (
              <small className="public-paper-count">
                {t("profile.paperCount", { count: agent.filledPaper })}
              </small>
            )}
          </div>
        </div>
        {displayPnl == null && <p className="public-empty">{agent.mode === "paper" ? t("profile.paperUnavailable") : agent.unrankedWhy ? unrankedLabel(agent.unrankedWhy) : t("profile.returnUnavailable")}</p>}
        {agent.mode === "paper" && displayPnl != null && <p className="public-empty">{t("profile.paperNote")}</p>}
        {/* "Net of $0.00 in priced gas" under a sponsored agent's return was true
            and read like a rounding error. When every landed operation was
            sponsored — measured, never assumed (gasless.ts) — the sentence says
            who paid instead. */}
        {agent.mode !== "paper" && displayPnl != null && agent.gas && (agent.gasless === true
          ? <p className="public-empty">{t("profile.gasSponsored")}</p>
          : <p className="public-empty">{t("profile.gasNet", { amount: money(agent.gas.usdg) })}{agent.gas.unpricedTrades > 0 && <> {t("profile.gasUnpriced", { count: agent.gas.unpricedTrades })}</>}</p>)}
        {/* THE GATE, BEFORE THE DRAW.
            Two things have to be true before a line goes under the words
            "Performance history": it must be the growth index (deposits divided
            out) and not raw equity, and the flows divided out of it must have
            been read from the chain rather than inferred from balance changes.
            `EquityLine.tsx` has refused on the second for months; this screen
            replaced it without carrying the refusal, so a failed profile fetch
            fell back to the leaderboard's raw `equity_usdg` and drew a book
            springing into existence at full value. */}
        {agent.mode === "paper" ? null : agent.curveKind !== "growth" ? (
          <p className="public-empty">
            {t("profile.noHistory")}
          </p>
        ) : agent.contributionsEvidenced === false ? (
          <p className="public-empty">
            {t("profile.inferredFlows")}
          </p>
        ) : agent.curve.length > 1 ? (
          <ProfileChart agent={agent} displayPnl={displayPnl} />
        ) : (
          <p className="public-empty">
            {t("profile.noHistory")}
          </p>
        )}
      </section>
      <section className="public-strategy">
        <div className="public-section-heading">
          <h2>{t("profile.strategy")}</h2>
          <span>{g.known === false ? t("profile.notPublished") : strategyName(g.id)}</span>
        </div>
        <p>{agent.thesis || t("profile.noThesis")}</p>
      </section>
      {/* TOP TRADES, by return and never by dollars — a dollar ranking ranks
          position size and would leak the sizes a private book hides. Absent
          entirely on the leaderboard fallback, which never read them. */}
      {topTrades !== undefined && (
        <section className="public-section" aria-label="Top trades">
          <div className="public-section-heading"><h2>{t("profile.topTrades")}</h2><span>{agent.mode === "paper" ? t("profile.paperSells") : t("profile.closedSells")}</span></div>
          {/* UNREAD covers a list whose costs could not be checked, too — a
              coin traded more often than one replay reads (profile-trades.ts
              readTopTrades) — which a retry does not cure, so this promises none. */}
          {!own?.topTrades && agent.topTradesRead === false ? (
            <p role="status" className="public-empty">{t("profile.topFailed")}</p>
          ) : topTrades.length === 0 ? (
            <Empty compact title={t("profile.noClosed")} />
          ) : (
            <ol className="profile-top-trades">
              {topTrades.map((trade, i) => {
                const token = trade.symbol ? tokens.find((k) => k.symbol.toUpperCase() === trade.symbol!.toUpperCase()) : undefined;
                const f = topTradeFigures(trade, showMoney);
                return (
                  <li key={trade.id} className="profile-top-trade">
                    <span className="profile-top-rank">#{i + 1}</span>
                    <Coin symbol={trade.symbol ?? "?"} logo={token?.logo ?? ""} />
                    <span className="profile-top-name" title={fullDateTime(trade.at * 1000)}>
                      <strong>{trade.symbol ?? t("profile.noLabel")}</strong>
                      {(trade.displayName ?? token?.name) && <small>{trade.displayName ?? token?.name}</small>}
                    </span>
                    <span className={`profile-top-figure ${f.tone}`}>
                      {f.pct}
                      {f.usd && <small> ({f.usd})</small>}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}
      <section className="public-section" aria-label="Trade history">
        <div className="public-section-heading"><h2>{t("profile.buysSells")}</h2><span>{t("profile.latestFills")}</span></div>
        {/* THE SAME TABLE THE OWNER'S DESK USES (SwapsTable.tsx, rules in
            swaps.ts). It replaced a four-line article per fill that printed a
            full date, "Not realized on a buy" under every buy and no coin.
            Dollars only on a published book or the owner's own view: the
            server withholds a private book's sizes, and the table refuses to
            print one it was handed. */}
        {!own?.recentTrades && agent.activityRead === false ? <p role="status" className="public-empty">{t("profile.historyFailed")}</p> : recentTrades === undefined ? <p className="public-empty">{t("profile.loadingHistory")}</p> : <>
          <SwapsTable
            rows={swapRowsOfProfile(recentTrades)}
            tokens={tokens}
            showMoney={showMoney}
            emptyTitle={t("profile.emptySwaps")}
            onToken={onToken}
          />
          {recentTrades.length > 0 && agent.publicBook === false && (own?.recentTrades
            ? <p className="public-empty">{t("profile.ownerMoney")}</p>
            : <p className="public-empty">{t("profile.sizesPrivate")}</p>)}
          {recentTrades.length > 0 && <p className="public-empty">{t("profile.swapsNote")}</p>}
          {recentTrades.length > 0 && <p className="public-empty">{t("profile.saleNote")}</p>}
          {/* A SELL LISTED WITH NO RETURN IS NOT SILENT. Its cost was an
              estimate, or could not be checked at all (profile-trades.ts): the
              row stays, its figure does not, and this says which kind of
              absence it is — not a zero, not a list that forgot. */}
          {recentTrades.some((t) => t.action === "sell" && t.realizedPnlBps === null) && (
            <p className="public-empty">{t("profile.saleNoReturn")}</p>
          )}
        </>}
      </section>
      <section className="public-section">
        <div className="public-section-heading">
          <h2>{t("profile.positions")}</h2>
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
                  <small>{token?.name ?? t("profile.tokenFallback")}</small>
                </span>
                <span>{p.detail}</span>
                {token && <span aria-hidden>↗</span>}
              </button>
            );
          })
        ) : (
          <p className="public-empty">{agent.publicBook === false ? t("profile.positionsPrivate") : agent.holdingsRead === false ? t("profile.holdingsDown") : t("profile.noPositions")}</p>
        )}
        {positions.length === 0 && mentioned.length > 0 && (
          <div className="public-mentioned">
            <span>{t("profile.discussed")}</span>
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
          <h2>{t("profile.decisions")}</h2>
          <span>{t("profile.updates", { count: posts.length })}</span>
        </div>
        {activityError && <p role="status" className="public-empty">{activityError}</p>}
        {!activityError && posts.length === 0 && (
          <Empty compact title={t("profile.noDecisions")}/>
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
                        ? t("profile.buy")
                        : post.action === "sell"
                          ? t("profile.sell")
                          : t("profile.hold")}{" "}
                      {token ? (
                        <button type="button" onClick={() => onToken(token.id)}>
                          {post.symbol}
                        </button>
                      ) : (
                        post.symbol
                      )}
                    </strong>
                    <span>
                      {(post.action === "buy" || post.action === "sell") && post.sizeUsdg != null && post.sizeUsdg > 0 ? money(post.sizeUsdg) : ""}
                    </span>
                  </div>
                  <p>{post.reason ?? post.head}</p>
                  <small>
                    {ageOf(post) ? t("profile.ago", { age: ageOf(post) }) : t("profile.timeUnknown")}
                    {post.outcomeText ? ` · ${post.outcomeText}` : post.outcome ? ` · ${post.outcome}` : ""}
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
            {showAll ? t("profile.showLess") : t("profile.viewAll", { count: posts.length })}{" "}
            <span aria-hidden>{showAll ? "↑" : "↓"}</span>
          </button>
        )}
      </section>
    </div>
  );
}

/**
 * THE CHART, IN THE WINDOWS ITS HISTORY CAN BACK.
 *
 * read-agent sends one close an hour over the whole period; this slices it.
 * ALL is the default whenever the read reached the period's first reading,
 * because ALL is the span the headline above measures — the old chart covered
 * the newest two to eight hours and printed "0.00%" under "+21.5%". A window
 * the history does not reach is disabled rather than drawn short under a
 * longer name. See profile-view.ts, where each of those rules is tested.
 */
function ProfileChart({ agent, displayPnl }: { agent: ProfileAgent; displayPnl: number | null }) {
  const t = useT();
  const nowSec = Math.floor(useNow(60_000) / 1000);
  const [picked, setPicked] = useState<ChartWindow | null>(null);
  const points = agent.growthPoints;
  if (!points) {
    // A server from before the windows: draw what it sent, and say only what
    // is known about it.
    return (
      <div className="public-chart" aria-label={`Performance history. Reported return ${pctBps(displayPnl)}.`}>
        <Boundary label="profile-chart"><PerformanceChart values={agent.curve} height={88} /></Boundary>
        <p className="public-empty">{t("profile.chartLegacy")}</p>
      </div>
    );
  }
  const windows = chartWindows(points, agent.growthComplete, nowSec);
  const active = picked ?? defaultWindow(points, agent.growthComplete, nowSec);
  const slice = growthWindow(points, active, nowSec, agent.growthComplete);
  const words = windows.find((w) => w.id === active)!.words;
  return (
    <div className="public-chart" aria-label={`Performance history. Reported return ${pctBps(displayPnl)}.`}>
      <div className="profile-chart-windows" role="group" aria-label="Chart period">
        {windows.map((w) => (
          <button
            key={w.id}
            type="button"
            aria-pressed={w.id === active}
            disabled={!w.available}
            title={w.available ? undefined : w.id === "ALL" ? t("profile.partialPeriod") : t("profile.historyGap", { period: w.words.replace("the last ", "") })}
            onClick={() => setPicked(w.id)}
          >
            {w.id}
          </button>
        ))}
      </div>
      {slice.state === "ok" ? (
        <>
          <Boundary label="profile-chart"><PerformanceChart values={slice.values} height={88} /></Boundary>
          <p className="public-empty">
            {t("profile.chartWindow", { period: words })}{active === "ALL" ? t("profile.chartSamePeriod") : ""}
          </p>
        </>
      ) : (
        <p className="public-empty">
          {slice.state === "empty" ? t("profile.noReadings", { period: words }) : slice.state === "partial" ? t("profile.partialPeriod") : t("profile.shortHistory", { period: words.replace("the last ", "") })}
        </p>
      )}
    </div>
  );
}

/**
 * The owner's own view of their private book, or null.
 *
 * Asked for only while `slug` is set — the page sets it on the owner's own page
 * of a private book — and again whenever `refreshKey` changes, which is the
 * public read refreshing. Null on any failure: the page then shows the public
 * figures, which carry no money. Never another slug's answer.
 */
function useOwnBook(slug: string | null, refreshKey: unknown): OwnBookView | null {
  const [own, setOwn] = useState<{ slug: string; view: OwnBookView } | null>(null);
  useEffect(() => {
    if (!slug) {
      setOwn(null);
      return;
    }
    let alive = true;
    void fetchOwnBook(slug).then((view) => {
      if (alive) setOwn(view ? { slug, view } : null);
    });
    return () => {
      alive = false;
    };
  }, [slug, refreshKey]);
  return own && own.slug === slug ? own.view : null;
}

/**
 * THE OWNER'S SWITCH FOR THE PUBLIC BOOK.
 *
 * THIS IS THE CONSENT, so it names everything the flag publishes — every
 * reader of `publicBook`, not only this page's figures: trade sizes and dollar
 * P&L (this page, and the feed), what the agent holds and how much (this page's
 * Positions), and its name as a holder on the page of every token it holds
 * (read-token.ts). It used to say only "trade sizes and dollar P&L" and that
 * "percentages are public either way", which undersold the holdings on the one
 * control that decides them.
 *
 * Off by default and off until the owner says otherwise. What it shows is what
 * the SERVER last read, moved only after a save the server confirmed; a save
 * that failed, or that an older server silently dropped, says so here instead
 * of leaving a switch that moved over a page that did not.
 */
function BookSwitch({ on, onChanged }: { on: boolean; onChanged?: () => void }) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<boolean | null>(null);
  // Once the page's own read agrees with the save, the read is the truth again.
  useEffect(() => { if (saved === on) setSaved(null); }, [on, saved]);
  const shown = saved ?? on;
  const change = async (next: boolean) => {
    if (saving) return;
    setSaving(true);
    setError("");
    const r = await saveBook(next);
    setSaving(false);
    if (!r.ok) { setError(r.message); return; }
    setSaved(next);
    onChanged?.();
  };
  return (
    <section className="profile-book" aria-label="Public book">
      <div>
        <strong>{t("profile.bookTitle")}</strong>
        <small>
          {shown
            ? t("profile.bookOn")
            : t("profile.bookOff")}
        </small>
        {error && <small role="alert" className="profile-book-error">{error}</small>}
      </div>
      <Switch
        on={shown}
        onChange={saving ? () => {} : (next) => void change(next)}
        label="Publish this agent's book: its trade sizes and dollar P&L, what it holds and how much, and its name as a holder on token pages"
      />
    </section>
  );
}
