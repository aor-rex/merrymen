import React from "react";
import { count, fullDateTime, timeOnly } from "@/lib/format";
import type { PoolEvidence } from '../../../worker/src/venues/pool-evidence';
import type { DiscoveryRow } from '@/lib/read-discoveries';
import { coinPrice, compactUsd, money } from './live';
import { useT } from "@/lib/i18n";

export function TokenActivity({ coin, evidence, loading }: { coin: DiscoveryRow | null; evidence: PoolEvidence | null; loading: boolean }) {
  const t = useT();
  if (loading) return <section className="token-activity" aria-busy="true"><h3>{t("home.marketActivity")}</h3><p>{t("common.poolLoading")}</p></section>;
  if (!coin) return <section className="token-activity"><h3>{t("home.marketActivity")}</h3><p>{t("common.poolUnavailable")}</p></section>;
  const trades = evidence?.trades;
  const stale = !trades?.observedAt || Date.now() - trades.observedAt > 120000;
  return <section className="token-activity">
    <header><h3>{t("home.marketActivity")}</h3><span>{t("common.activitySource", { venue: coin.venue })}</span></header>
    <div className="activity-facts">
      <div><span>{t("common.vol24")}</span><strong>{compactUsd(coin.volume24hUsd)}</strong></div>
      <div><span>{coin.onCurve ? t("common.reserveCurve") : t("common.reservePool")}</span><strong>{compactUsd(coin.reserveUsd)}</strong></div>
      <div><span>{t("common.buyers24")}</span><strong>{coin.buyers24h === undefined ? '—' : count(coin.buyers24h)}</strong></div>
    </div>
    <p className="activity-note">{coin.onCurve ? t("common.curveNote") : t("common.liquidityNote")}</p>
    <div className="activity-scroll"><table className="activity-windows"><caption>{t("common.reportedWindows")}</caption><thead><tr><th scope="col">{t("common.colWindow")}</th><th scope="col">{t("common.colVolume")}</th><th scope="col">{t("common.colBuys")}</th><th scope="col">{t("common.colSells")}</th></tr></thead><tbody>
      {(['m5', 'h1', 'h6', 'h24'] as const).map((w, i) => <tr key={w}><th scope="row">{['5m', '1h', '6h', '24h'][i]}</th><td>{compactUsd(coin.buckets[w].volumeUsd)}</td><td>{coin.buckets[w].buys === undefined ? '—' : count(coin.buckets[w].buys)}</td><td>{coin.buckets[w].sells === undefined ? '—' : count(coin.buckets[w].sells)}</td></tr>)}
    </tbody></table></div>
    <h4>{t("common.recentPool")}</h4>
    <p className="activity-note">{t("common.publicTrades")}</p>
    {!trades || trades.failed ? <p role="status">{t("common.recentUnavailable")}</p> : <>
      <p className="activity-note">{stale ? t("common.snapshotOld") : t("common.snapshotNow")} · {trades.observedAt ? fullDateTime(trades.observedAt) : t("profile.timeUnknown")}</p>
      {trades.data.length === 0 ? <p>{t("common.noSampleTrades")}</p> : <div className="activity-scroll"><table><thead><tr><th scope="col">{t("common.colSide")}</th><th scope="col">{t("common.colValue")}</th><th scope="col">{t("token.tokenPrice")}</th><th scope="col">{t("common.colTimeTx")}</th></tr></thead><tbody>
        {trades.data.slice(0, 12).map(trade => <tr key={trade.id}><td className={trade.side === 'buy' ? 'activity-buy' : 'activity-sell'}>{trade.side === 'buy' ? t("profile.buy") : t("profile.sell")}</td><td>{trade.usd === null ? "—" : money(trade.usd)}</td><td>{coinPrice(trade.priceUsd)}</td><td><a href={`https://robinhoodchain.blockscout.com/tx/${trade.tx}`} target="_blank" rel="noreferrer" aria-label={`View ${trade.side} transaction ${trade.tx}`}>{timeOnly(trade.time * 1000)} ↗</a></td></tr>)}
      </tbody></table></div>}
    </>}
  </section>;
}
