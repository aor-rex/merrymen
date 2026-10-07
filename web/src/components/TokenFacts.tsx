"use client";

import { GECKO_WINDOWS } from "../../../worker/src/venues/geckoterminal";
import { compactUsd, coinPrice, count, pct, usd } from "@/lib/format";
import { timeAgo } from "@/lib/time";
import type { TokenMarket } from "@/lib/read-token-market";
import { useT } from "@/lib/i18n";

/**
 * WHAT THE MARKET SAYS, above what the agents said.
 *
 * Server-rendered, because none of it is interactive and all of it comes from
 * reads the page has already made.
 *
 * TWO SHAPES, NOT ONE. A stock token and a coin overlap on two fields, and
 * those two arrive from different providers; everything else exists for exactly
 * one of them. Forcing a shared strip is what manufactures a fabricated cell —
 * so the two are written out separately and each cell names its own source.
 *
 * NO MARKET CAP, EITHER KIND. The index substitutes fully-diluted value for
 * market cap whenever it lacks a circulating supply, so the label here would be
 * FDV wearing a word that makes a token look bigger and safer than it is. A
 * stock token has no circulating supply to compute one from either.
 */

/** A figure and its label. Four of these make a strip. */
function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mm-tok-cell">
      <dt>{label}</dt>
      <dd className="mono">{children}</dd>
    </div>
  );
}

export function StatStrip({ market }: { market: TokenMarket }) {
  const t = useT();
  // Unreadable is checked BEFORE absent — the order the launchpad panel is
  // already pinned to. Four dashes in a monospace grid read as four zeros, so a
  // refused read gets a sentence rather than a strip.
  if (market.read === "unread") {
    return (
      <div className="mm-readfail">
        {t("common.factsUnreadBody")}
      </div>
    );
  }

  if (market.read === "absent") {
    return (
      <p className="mm-note">
        {/* About the FEEDS, never about the index. What we hold is page one of
            three of them — roughly the top of the chain, not everything the
            index knows — so &quot;not indexed&quot; is a claim we cannot make. */}
        {t("common.factsAbsentBody")}
      </p>
    );
  }

  const coin = market.coin;
  const stock = market.stock;

  if (coin) {
    return (
      <dl className="mm-tok-strip">
        <Cell label={t("common.cellPrice")}>{coinPrice(coin.priceUsd)}</Cell>
        <Cell label="FDV">{compactUsd(coin.fdvUsd)}</Cell>
        <Cell label={t("common.cellVol")}>{compactUsd(coin.buckets.h24.volumeUsd)}</Cell>
        <Cell label={t("common.cellDepth")}>
          {/* A coin on its bonding curve reports a reserve that is mostly the
              VIRTUAL SEED — about $4,100 it does not hold — so it is never
              shown here as money you could sell into. */}
          {coin.onCurve ? <span className="soft">{t("common.preGraduation")}</span> : compactUsd(coin.reserveUsd)}
        </Cell>
      </dl>
    );
  }

  if (!stock) return null;

  const noFeed = stock.priceUsd === null && stock.priceUpdatedAt === null;
  const stale = stock.priceUpdatedAt !== null && Date.now() / 1000 - stock.priceUpdatedAt > 3600;
  const acting = stock.uiMultiplier !== null && stock.uiMultiplier !== 1;

  return (
    <>
      {/* Conditions, not figures, so they sit above the cells rather than
          spending one. Both render only when TRUE: `paused` is null when the
          chain refused the read, and a halt is the last thing to guess at. */}
      {(stock.paused === true || acting) && (
        <div className="mm-tok-flags">
          {stock.paused === true && <span className="mm-chip warn">{t("common.halted")}</span>}
          {acting && (
            <span
              className="mm-chip quiet"
              title={t("common.corpActionTitle")}
            >
              {t("common.corpAction")}
            </span>
          )}
        </div>
      )}
      <dl className="mm-tok-strip">
        <Cell label={t("common.cellPrice")}>
          {/* A token with no Chainlink feed has no price BY CONSTRUCTION. That
              is a fact about the token rather than an outage, and it must not
              render as the same dash a failed multicall leg produces. */}
          {noFeed ? <span className="soft">{t("common.noFeed")}</span> : usd(stock.priceUsd)}
        </Cell>
        <Cell label={t("common.cellFeed")}>
          {stock.priceUpdatedAt === null ? (
            "—"
          ) : (
            <>
              {timeAgo(stock.priceUpdatedAt)}
              {stale && (
                <span className="mm-chip quiet" title={t("common.staleTitle")}>
                  {t("common.stale")}
                </span>
              )}
            </>
          )}
        </Cell>
        <Cell label={t("common.cellVol")}>{compactUsd(stock.volume24hUsd)}</Cell>
        <Cell label={t("common.cellHolders")}>{count(stock.holders)}</Cell>
      </dl>
    </>
  );
}

const TF_LABEL: Record<(typeof GECKO_WINDOWS)[number], string> = {
  m5: "5m",
  h1: "1h",
  h6: "6h",
  h24: "24h",
};

/**
 * 5M / 1H / 6H / 24H.
 *
 * NOT the reference product's 5M / 1H / 4H / 1D. This index publishes no
 * four-hour bucket, and relabelling the six-hour one "4H" would be a
 * fabrication nothing downstream could detect.
 */
export function TimeframeGrid({ market }: { market: TokenMarket }) {
  const coin = market.read === "found" ? market.coin : null;
  if (!coin) return null;
  // Every window null means the index published no tape at all, which is a
  // different thing from a flat market and is not worth four dashes.
  if (GECKO_WINDOWS.every((w) => coin.buckets[w].changePct === null)) return null;

  return (
    <dl className="mm-tok-tf">
      {GECKO_WINDOWS.map((w) => {
        const v = coin.buckets[w].changePct;
        const tone = v === null || v === 0 ? "flat" : v > 0 ? "up" : "down";
        return (
          <div key={w} className="mm-tok-cell">
            <dt>{TF_LABEL[w]}</dt>
            <dd className={`mono ${tone}`}>{pct(v)}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** One green/red split. Never rendered without both of its numbers. */
function Bar({
  label,
  lo,
  hi,
  loWord,
  hiWord,
}: {
  label: string;
  lo: number | null;
  hi: number | null;
  loWord: string;
  hiWord: string;
}) {
  // EITHER SIDE MISSING AND THERE IS NO BAR. A half-filled track is a claim
  // about a proportion we do not have.
  if (lo === null || hi === null) return null;

  const total = lo + hi;
  // THE NAMED ZERO GUARD. lo / (lo + hi) is NaN when nothing traded, and the
  // obvious fallback paints half the track green — asserting an even split
  // about a window in which there were no trades to split.
  const nothingTraded = total === 0;
  const loPct = nothingTraded ? 0 : (lo / total) * 100;

  return (
    <div className="mm-tok-bar">
      <span className="lab">{label}</span>
      <span className="lo mono">
        {count(lo)} {loWord}
      </span>
      <span className="t" aria-hidden>
        {!nothingTraded && (
          <>
            <u style={{ width: `${loPct}%` }} />
            <s style={{ width: `${100 - loPct}%` }} />
          </>
        )}
      </span>
      <span className="hi mono">
        {count(hi)} {hiWord}
      </span>
    </div>
  );
}

/**
 * Which way the tape leaned over a day.
 *
 * TWO BARS AND NOT THREE. The reference product shows a third split — dollars
 * bought against dollars sold — and this index does not publish one: volume
 * arrives as a single scalar per window with no side attached, and no other
 * source here has one either. That bar is refused permanently rather than
 * approximated, so nobody goes looking for it again.
 */
export function FlowBars({ market }: { market: TokenMarket }) {
  const t = useT();
  const coin = market.read === "found" ? market.coin : null;
  if (!coin) return null;
  const d = coin.buckets.h24;
  if (d.buys === null && d.buyers === null) return null;

  return (
    <div className="mm-tok-flowbars">
      <Bar label={t("common.flowTrades")} lo={d.buys} hi={d.sells} loWord={t("common.flowBuys")} hiWord={t("common.flowSells")} />
      <Bar label={t("common.flowTraders")} lo={d.buyers} hi={d.sellers} loWord={t("common.flowBuyers")} hiWord={t("common.flowSellers")} />
    </div>
  );
}

/** Below this, a holder base is thin enough that size moves it. */
const THIN = 50;

/**
 * The one place data availability runs the other way.
 *
 * The reference product warns about a thin holder base on its coins; here it is
 * the STOCK tokens that have a holder count, because Blockscout indexes them
 * and nothing equivalent exists for a curve coin.
 *
 * Not --mm-warn, which means the wall said no and nothing else. And when the
 * count is null this does not render at all: "we could not count" is not "few".
 */
export function RiskCallout({ market }: { market: TokenMarket }) {
  const t = useT();
  const n = market.read === "found" ? (market.stock?.holders ?? null) : null;
  if (n === null || n >= THIN) return null;
  return (
    <p className="mm-tok-risk">
      {t("common.riskThin", { n: count(n) })}
    </p>
  );
}
