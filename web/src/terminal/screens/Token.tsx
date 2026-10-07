import { TokenActivity } from "../TokenActivity";
import { ChartArea, RotateCcw, ArrowDown } from "lucide-react";
import { DitherChart } from "../DitherChart";
import { Boundary } from "../Boundary";
import { useEffect, useMemo, useState } from "react";
import {
  loadBars,
  type BarsRead,
  type Bar,
  type ChartKind,
  type Seat,
  type WindowId,
  entryCaveat,
} from "../bars";
import {
  coinPrice,
  quoteTitle,
  compactUsd,
  money,
  pctBps,
  pctPts,
  type LiveAgent,
  type LiveToken,
  type Thesis,
  deltaClass,
} from "../live";
import { TvChart } from "../tv";
import { Coin, Face, Empty, MovingFigure } from "../ui";
import { SkeletonRows } from "../Skeleton";
import { holdersFigure, holdersList } from "../token-holders";
import { useWatchlist } from "../watchlist";
import { useTokenPage } from "../token-page-read";
import { shortDateTime } from "@/lib/format";
import { useT } from "@/lib/i18n";

const WINDOWS: WindowId[] = ["1H", "4H", "1D", "5D", "1M", "ALL"];

export function Token({
  token,
  theses,
  agents,
  onBack,
  onProfile,
}: {
  token: LiveToken;
  theses: Thesis[];
  agents: LiveAgent[];
  onBack: () => void;
  onProfile: (slug: string) => void;
}) {
  const t = useT();
  const [span, setSpan] = useState<WindowId>("1D");
  const [kind, setKind] = useState<ChartKind>("candle");
  const [bars, setBars] = useState<Bar[]>([]);
  /** WHY the chart is empty, when it is. See bars.ts BarsRead. */
  const [chart, setChart] = useState<{ state: BarsRead["state"]; reason: BarsRead["reason"]; stale: boolean }>({ state: "ok", reason: null, stale: false });
  const [loading, setLoading] = useState(true);
  const watchlist = useWatchlist();
  const starred = watchlist.ids.includes(token.id);
  const [copied, setCopied] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [chartRevision, setChartRevision] = useState(0);
  const [sortBy, setSortBy] = useState<"position" | "return">("position");
  const [sortDescending, setSortDescending] = useState(true);
  /** Bumped by Try again, which re-runs the holders read — a failure was final until the page remounted. */
  const [holdersAttempt,setHoldersAttempt]=useState(0);
  // KEYED ON THE TOKEN ALONE — see token-page-read.ts. The feed is read every
  // ten seconds, and the posts are joined to the holders after the read, with
  // the clash gate the read itself reported, so a feed read changes a thesis
  // and re-reads nothing.
  const { holdersRead, holderError, coverage: holderCoverage, symbolClash, activity, seats } = useTokenPage(token.id, token.symbol, theses, holdersAttempt);
  const orderedSeats = useMemo(
    () =>
      [...seats].sort(
        (a, b) =>
          (sortDescending ? -1 : 1) *
          ((sortBy === "position" ? a.position : (a.pnlBps ?? -Infinity)) -
            (sortBy === "position" ? b.position : (b.pnlBps ?? -Infinity))),
      ),
    [seats, sortBy, sortDescending],
  );
  const holders = holdersList(holdersRead, seats.length);
  const sortHolders = (next: "position" | "return") => {
    if (sortBy === next) setSortDescending((value) => !value);
    else {
      setSortBy(next);
      setSortDescending(true);
    }
  };
  const chartPoints = useMemo(
    () =>
      bars.map((bar) => ({
        value: bar.close,
        label: shortDateTime(bar.time * 1000),
      })),
    [bars],
  );
  const first = bars[0];
  const last = bars[bars.length - 1];
  const winPct =
    first && last && first.open > 0
      ? ((last.close - first.open) / first.open) * 100
      : null;
  const winDol = first && last ? last.close - first.open : null;
  // `down` still drives the chart’s own colour, where a null has to pick one.
  const down = (winPct ?? 0) < 0;

  useEffect(() => {
    let alive = true;
    setBars([]);
    setLoading(true);
    void loadBars(token, span).then((next) => {
      if (alive) {
        setBars(next.bars);
        setChart({ state: next.state, reason: next.reason, stale: next.stale });
        setLoading(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [token.id, token.symbol, token.kind, token.uiMultiplier, span]);

  const copyId = () => {
    void navigator.clipboard.writeText(token.id).then(() => {
      setCopied(true);
      globalThis.setTimeout(() => setCopied(false), 1200);
    }).catch(() => setActionMessage(t("token.copyFailed")));
  };

  const share = () => {
    const url = location.href;
    if (navigator.share) {
      void navigator.share({ title: token.symbol, text: token.name, url }).catch((error) => { if(error.name !== "AbortError") setActionMessage(t("token.shareFailed")); });
      return;
    }
    void navigator.clipboard.writeText(url).then(()=>setActionMessage(t("token.linkCopied"))).catch(()=>setActionMessage(t("token.linkFailed")));
  };

  return (
    <div className="token">
      <header className="token-top">
        <button
          type="button"
          className="back"
          onClick={onBack}
          aria-label="Back"
        >
          ←
        </button>
        <div className="token-who">
          <Coin symbol={token.symbol} logo={token.logo} />
          <div>
            <h1>
              {token.symbol}
              {token.kind !== "memecoin" && <i className="verified" aria-label="Registered tokenized asset" />}
            </h1>
            <p className="token-sub">
              <span>{token.name}</span>
              <button type="button" onClick={copyId}>
                {copied ? t("token.copied") : shortId(token.id)}
              </button>
            </p>
          </div>
        </div>
        <div className="token-acts">
          <button
            type="button"
            className={starred ? "on" : ""}
            aria-label="Watch"
            aria-pressed={starred}
            onClick={() => {try {watchlist.toggle(token.id);} catch {setActionMessage(t("token.watchlistFailed"));}}}
          >
            <StarIcon on={starred} />
          </button>
          <button type="button" aria-label="Share" onClick={share}>
            <ShareIcon />
          </button>
        </div>
      </header>
      {actionMessage && <p role="status">{actionMessage}</p>}

      <div className="token-hero">
        <div>
          <div className="price" title={quoteTitle(token)}>
            {/* Flips when a newer read moves it — the market read lands every
                thirty seconds now, and a price that changes in place with no
                sign of it reads as a price that never changes. */}
            <MovingFigure value={token.priceUsd} text={coinPrice(token.priceUsd)} />
          </div>
          {winPct != null && (
            <strong className={down ? "down" : "up"}>
              {down ? "▼" : "▲"} {winDol != null ? money(Math.abs(winDol)) : ""}{" "}
              {pctPts(winPct)} {span}
            </strong>
          )}
        </div>
        {token.fdvUsd != null && (
          <div className="token-mc">
            <b>{compactUsd(token.fdvUsd)}</b>
            <span>{t("token.fdv")}</span>
          </div>
        )}
      </div>

      <div className="token-market-strip">
        <div>
          <span>
            {token.priceUsd == null
              ? t("token.chartClose")
              : token.priceSource === "robinhood"
                ? t("token.quoteMid")
                : t("token.tokenPrice")}
          </span>
          <strong title={quoteTitle(token)}>
            {/* The desktop's copy of the price above, which is hidden there.
                It moves with the LIVE price only: the chart close it falls
                back to is another measurement, and a price arriving in its
                place is not the market moving. */}
            <MovingFigure value={token.priceUsd} text={coinPrice(token.priceUsd ?? last?.close ?? null)} />
          </strong>
        </div>
        <div>
          <span>{t("token.changeWindow", { span })}</span>
          {/* The TEXT of the change gets the third colour. `down` above is a
              boolean the chart needs; a percentage nobody measured is neither
              up nor down, and printing "—" in green is the bug live.ts documents
              at deltaClass. */}
          <strong className={deltaClass(winPct)}>{pctPts(winPct)}</strong>
        </div>
        <div>
          <span>{t("token.highWindow", { span })}</span>
          <strong>
            {coinPrice(
              bars.length ? Math.max(...bars.map((b) => b.high)) : null,
            )}
          </strong>
        </div>
        <div>
          <span>{t("token.lowWindow", { span })}</span>
          <strong>
            {coinPrice(
              bars.length ? Math.min(...bars.map((b) => b.low)) : null,
            )}
          </strong>
        </div>
        <div>
          <span>{t("token.agentsHolding")}</span>
          {/* Every agent holding it, the private ones included — not only the public rows below. */}
          <strong>{holdersFigure(holdersRead, holderCoverage)}</strong>
        </div>
      </div>
        <div className="token-plot">
          {bars.length === 0 ? (
            <p className="meta" role="status">
              {loading
                ? t("token.loadingChart")
                : /**
                   * ONE SENTENCE PER STATE. This was a single line for all four
                   * — "Price history unavailable. Try another timeframe." — and
                   * that advice is true only for `none` on a short window,
                   * while for `refused` it blamed the token for our outage.
                   * read-candles.ts keeps the states apart precisely so this
                   * screen can say the right one.
                   */
                  chart.state === "refused"
                  ? chart.reason === "rate-limited"
                    ? t("token.rateLimited")
                    : chart.reason === "unreadable"
                      ? t("token.unreadableIndex")
                      : t("token.indexDown")
                  : chart.state === "mismatch"
                    ? t("token.mismatch", { symbol: token.symbol })
                    : span === "1H" || span === "4H"
                      ? t("token.emptyWindow")
                      : t("token.noHistory")}
            </p>
          ) : (
            <>
              {chart.stale && (
                /* SERVING AN OLD SERIES MUST NEVER BE SILENT. Keeping the last
                   good bars through a refusal is right — a blank chart over one
                   429 is worse — but unsaid it trades an honest blank for a
                   quiet lie about the price. */
                <p className="meta" role="status">
                  {t("token.staleChart")}
                </p>
              )}
              {kind === "line" ? (
            <Boundary label="token-chart"><DitherChart
              key={`${token.id}-${span}-${chartRevision}`}
              riders={seats.filter(seat=>seat.time >= bars[0]!.time && seat.time <= bars[bars.length-1]!.time && seat.price>0).map((seat) => ({
                name: seat.name,
                slug: seat.slug,
                index: bars.reduce(
                  (best, bar, index) =>
                    Math.abs(bar.time - seat.time) <
                    Math.abs(bars[best]!.time - seat.time)
                      ? index
                      : best,
                  0,
                ),
              }))}
              onRider={onProfile}
              points={chartPoints}
              label={`${token.symbol} price history`}
              format={coinPrice}
              height={250}
            /></Boundary>
          ) : (
            <Boundary label="token-chart"><TvChart
              key={chartRevision}
              bars={bars}
              seats={seats.filter(s=>s.time>0 && s.price>0)}
              kind={kind}
              down={down}
              onAgent={onProfile}
            /></Boundary>
              )}
            </>
          )}
          <div className="tv-tools">
            <div className="tv-windows">
              {WINDOWS.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={span === id ? "on" : ""}
                  onClick={() => setSpan(id)}
                >
                  {id}
                </button>
              ))}
            </div>
            <div className="tv-kinds">
              <button
                type="button"
                className="chart-reset"
                aria-label={t("token.resetView")}
                title={t("token.resetView")}
                onClick={() => setChartRevision((value) => value + 1)}
              >
                <RotateCcw size={15} />
              </button>
              <button
                type="button"
                className={kind === "candle" ? "on" : ""}
                aria-label="Candles"
                onClick={() => setKind("candle")}
              >
                <CandleIcon />
              </button>
              <button
                type="button"
                className={kind === "line" ? "on" : ""}
                aria-label="Dither area"
                onClick={() => setKind("line")}
              >
                <ChartArea size={18} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>

      {token.kind === "memecoin" && <TokenActivity {...activity} />}

      <section className="held-sec">
        {holderError && <p role="status">{holderError}</p>}
        {holdersRead === "failed" && <button type="button" onClick={()=>setHoldersAttempt(n=>n+1)}>{t("token.tryAgain")}</button>}
        <h3>{seats.length ? t("token.holdersCount", { count: seats.length }) : t("token.holders")}</h3>
        {holderCoverage && <p className="meta">{t("token.coverage", { published: holderCoverage.published, total: holderCoverage.total })}</p>}
        {symbolClash && <p className="meta">{t("token.clash")}</p>}
        {seats.length > 0 && (
          <div className="holder-table-wrap">
            <table className="holder-table">
              <thead>
                <tr>
                  <th>{t("token.colAgent")}</th>
                  <th
                    aria-sort={
                      sortBy === "position"
                        ? sortDescending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    <button onClick={() => sortHolders("position")}>
                      {t("token.colPosition")}{" "}
                      {sortBy === "position" && (
                        <ArrowDown
                          size={12}
                          style={{
                            transform: sortDescending
                              ? undefined
                              : "rotate(180deg)",
                          }}
                        />
                      )}
                    </button>
                  </th>
                  <th
                    aria-sort={
                      sortBy === "return"
                        ? sortDescending
                          ? "descending"
                          : "ascending"
                        : "none"
                    }
                  >
                    <button onClick={() => sortHolders("return")}>
                      {t("token.colReturn")}{" "}
                      {sortBy === "return" && (
                        <ArrowDown
                          size={12}
                          style={{
                            transform: sortDescending
                              ? undefined
                              : "rotate(180deg)",
                          }}
                        />
                      )}
                    </button>
                  </th>
                  <th>{t("token.colAvg")}</th>
                  <th>{t("token.colThesis")}</th>
                </tr>
              </thead>
              <tbody>
                {orderedSeats.map((seat) => (
                  <tr key={seat.slug}>
                    <td>
                      <button
                        className="holder-agent"
                        onClick={() => onProfile(seat.slug)}
                      >
                        <Face name={seat.name} slug={seat.slug} />
                        <span>
                          <strong>{seat.name}{entryCaveat(seat) && <i className="tag unsettled">{seat.paper ? "paper" : "estimate"}</i>}</strong>
                          <small>{seat.strategy}</small>
                        </span>
                      </button>
                    </td>
                    <td>{money(seat.position)}</td>
                    <td className={deltaClass(seat.pnlBps)}>
                      {pctBps(seat.pnlBps)}
                    </td>
                    <td>{coinPrice(seat.avgEntry || null)}</td>
                    <td className="holder-thesis">
                      <p>{seat.thesis || "—"}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {seats.length === 0 ? (
          holders === "loading" ? <SkeletonRows rows={2} label={t("token.loadingHolders")}/>
            : holders === "empty" && <Empty compact kind="positions" title={t("token.noHoldings")}/>
        ) : (
          <div className="helds">
            {seats.map((s) => (
              <Held key={s.slug} seat={s} onProfile={onProfile} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Held({
  seat,
  onProfile,
}: {
  seat: Seat;
  onProfile: (slug: string) => void;
}) {
  const t = useT();
  return (
    <button type="button" className="held" onClick={() => onProfile(seat.slug)}>
      <Face name={seat.name} slug={seat.slug} />
      <div className="held-who">
        <div className="held-top">
          <div className="held-id">
            <strong>{seat.name}</strong>
            {seat.strategy ? <i className="tag">{seat.strategy}</i> : null}
          </div>
          {seat.position > 0 ? <b>{money(seat.position)}</b> : null}
        </div>
        <div className="held-sub">
          {seat.avgEntry > 0 ? (
            <span>{t("token.avgEntry", { price: coinPrice(seat.avgEntry || null) })}</span>
          ) : (
            <span />
          )}
          <em
            className={
              seat.pnlBps == null ? "" : seat.pnlBps >= 0 ? "up" : "down"
            }
          >
            {pctBps(seat.pnlBps)}
          </em>
        </div>
        {seat.thesis ? <p>{seat.thesis}</p> : null}
      </div>
    </button>
  );
}

function shortId(id: string): string {
  if (id.length < 12) return id;
  return `${id.slice(0, 4)}…${id.slice(-4)}`;
}

function StarIcon({ on }: { on: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill={on ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M12 3.6 14.6 9l5.9.5-4.5 3.9 1.4 5.7L12 16.4 6.6 19.1l1.4-5.7L3.5 9.5 9.4 9Z" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="18" cy="5" r="2.2" />
      <circle cx="6" cy="12" r="2.2" />
      <circle cx="18" cy="19" r="2.2" />
      <path d="M8 11.1 16 6.2M8 12.9 16 17.8" />
    </svg>
  );
}

function CandleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
      <path d="M7 4h2v3H7zM7 17h2v3H7zM6 8h4v8H6zM15 3h2v5h-2zM15 16h2v5h-2zM14 9h4v6h-4z" />
    </svg>
  );
}
