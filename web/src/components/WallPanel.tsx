"use client";

import { useEffect, useState } from "react";
import { useT, useRichT } from "@/lib/i18n";
import type { WallInfo } from "@/app/api/wall/route";
import type { WallCase } from "@merrymen/wall-battery";

/**
 * The trust layer, made first-class: the grant's caps and addresses with
 * explorer links ("don't trust us — verify it"), plus a "prove the wall"
 * button that fires malicious intents through the worker's own policy code
 * and shows each one bouncing. Hidden until a grant exists.
 */
export function WallPanel() {
  const t = useT();
  const rt = useRichT();
  const [info, setInfo] = useState<WallInfo | null>(null);
  const [cases, setCases] = useState<WallCase[] | null>(null);
  const [proving, setProving] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch("/api/wall");
        if (alive && r.ok) setInfo((await r.json()) as WallInfo);
      } catch {
        /* keep last */
      }
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!info?.armed || !info.caps || !info.addresses) return null;

  const addr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const link = (a: string) => `${info.explorer}/address/${a}`;
  const daysLeft = Math.max(0, Math.ceil((info.expiresAt! - Date.now() / 1000) / 86_400));

  async function prove() {
    setProving(true);
    try {
      const r = await fetch("/api/wall", { method: "POST" });
      if (r.ok) setCases(((await r.json()) as { cases: WallCase[] }).cases);
    } catch {
      /* leave as-is; button re-enables */
    }
    setProving(false);
  }

  return (
    <div className="panel wall-panel">
      <div className="section-title">{t("common.wallTitle")}</div>
      <p className="wall-sub">
        {rt("common.wallSub", {
          chain: info.chainName ?? "",
          id: String(info.chainId),
          onchain: t("common.wallOnchain"),
        })}
      </p>

      {/*
        Two of these five were never on-chain, and a third stopped being so on
        2026-08-30: ops/day rested on ZeroDev's rate-limit policy, whose contract
        has no code on this chain (eth_getCode, mainnet and testnet both). Listing
        all five under "these caps live in your account contract" was the strongest
        claim on the page and it was wrong about the majority of the row.

        The split is marked per chip rather than explained underneath, because a
        caveat in a following paragraph is not read by someone scanning a row of
        numbers — which is what this row is for.
      */}
      <div className="wall-caps mono">
        <span className="cap"><b>{t("common.wallPerTrade", { caps: String(info.caps.perTradeUsdg) })}</b> <i>{t("common.wallMarkOnchain")}</i></span>
        <span className="cap"><b>{t("common.wallKeyDies", { days: daysLeft })}</b> <i>{t("common.wallMarkOnchain")}</i></span>
        <span className="cap"><b>{t("common.wallPerDay", { caps: String(info.caps.dailyUsdg) })}</b> <i>{t("common.wallMarkSoft")}</i></span>
        <span className="cap"><b>{t("common.wallOps", { n: info.caps.maxOpsPerDay })}</b> <i>{t("common.wallMarkSoft")}</i></span>
        <span className="cap"><b>{t("common.wallBreaker", { n: info.caps.maxDrawdownPct })}</b> <i>{t("common.wallMarkSoft")}</i></span>
      </div>

      <div className="wall-addrs mono">
        <a href={link(info.addresses.smartAccount)} target="_blank" rel="noreferrer">
          {t("common.wallAccount", { addr: addr(info.addresses.smartAccount) })}
        </a>
        <a href={link(info.addresses.sessionKey)} target="_blank" rel="noreferrer">
          {t("common.wallSession", { addr: addr(info.addresses.sessionKey) })}
        </a>
        <a href={link(info.addresses.owner)} target="_blank" rel="noreferrer">
          {t("common.wallOwner", { addr: addr(info.addresses.owner) })}
        </a>
      </div>

      <button className="wall-prove" onClick={() => void prove()} disabled={proving}>
        {proving ? t("common.wallProving") : cases ? t("common.wallProveAgain") : t("common.wallProve")}
      </button>

      {cases && (
        <div className="wall-cases">
          {cases.map((c) => (
            <div key={c.attempt} className={`wall-case ${c.held ? "held" : "breach"}`}>
              <span className={`wall-verdict mono ${c.ok ? "ok" : "no"}`}>
                {c.held ? (c.ok ? t("common.wallApproved") : `✗ ${c.rule}`) : t("common.wallBreach")}
              </span>
              <span className="wall-attempt">{c.attempt}</span>
            </div>
          ))}
          <p className="wall-note">
            {t("common.wallNote")}
          </p>
        </div>
      )}
    </div>
  );
}
