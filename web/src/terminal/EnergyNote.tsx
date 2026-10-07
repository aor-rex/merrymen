"use client";

import { useState } from "react";
import { ENERGY } from "@merrymen/core";
import { count, usd } from "@/lib/format";
import { meterBar, type EnergyRemedies, type EnergyView } from "./energy-view";
import { useT } from "@/lib/i18n";

/**
 * THE AGENT'S ENERGY, ON THE DESK — drawn from the worker's own report.
 *
 * WHY IT IS NOT THE NOTICE SLOT. The worker also writes one dated warn event
 * the first time a day's allowance runs out, and that is what iOS and Android
 * show. But a standing condition cannot be carried by a log line: the event
 * ages out of the feed's forty-row window, and a newer warn covers it. So the
 * desk renders the CONDITION from AgentStatus.energy (the agents row), true on
 * first paint, and the screen drops the same sentence from the notice slot
 * while this says it (Agent.tsx, ENERGY_NOTICE_PREFIX).
 *
 * THREE VOLUMES, because they are three different amounts of news:
 *   - low and not yet spent: one quiet line. Most agents without $MERRYMEN
 *     sit here permanently; it must never hide anything more important.
 *   - unread: the same quiet line, saying it is OUR read that failed — never
 *     that they hold nothing.
 *   - spent: the full panel, with every remedy and "or change nothing".
 *
 * WHAT IT MUST NEVER SAY. Nothing about the token's price, where it is going,
 * or returns: $MERRYMEN here is capacity and nothing else (token.ts STANCE).
 * No fee or tax percentage either — the token's own tax is set by its owner
 * and can change without a line of our code changing.
 *
 * THE ADDRESS IS PRINTED IN FULL, next to a copy button — never shortened,
 * never retyped by the model. One wrong character and the tokens are gone.
 * And it is offered only when tokens sent there would count (energyRemedies).
 *
 * "ASK ME" ONLY FILLS THE COMPOSER. It puts a request in the owner's own box
 * and sends nothing: the agent then proposes `get-energy`, the owner reads the
 * card with the amount on it, and only their click places anything.
 */
export function EnergyNote({
  view,
  remedies,
  account,
  estimateUsdg,
  onDeposit,
  onAsk,
  onResign,
}: {
  view: EnergyView;
  remedies: EnergyRemedies;
  /** The agent's account, in full — grant.smartAccount. */
  account: string | null;
  /** The worker's estimate of the USDG that would buy today's shortfall; null = unknown. */
  estimateUsdg: number | null;
  onDeposit: () => void;
  /** Fill the composer with a request. Must never send or propose anything itself. */
  onAsk: () => void;
  onResign: () => void;
}) {
  const t = useT();
  const [copy, setCopy] = useState<"idle" | "copied" | "error">("idle");
  if (view.kind === "none") return null;
  const full = count(ENERGY.fullTokens);

  if (!view.spent) {
    if (view.kind === "unread") {
      return (
        <section className="desk-energy" role="status">
          <p>{t("common.energyUnread")}</p>
        </section>
      );
    }
    const reviews = view.reviews;
    const entries = view.entries;
    const used = [
      reviews ? t("common.energyReviewsUsed", { used: count(reviews.used), allowed: count(reviews.allowed) }) : null,
      entries ? t("common.energyEntriesUsed", { used: count(entries.used), allowed: count(entries.allowed) }) : null,
    ].filter(Boolean);
    const bars = [
      { label: t("common.energyReviewsLabel"), bar: meterBar(reviews) },
      { label: t("common.energyEntriesLabel"), bar: meterBar(entries) },
    ].filter((b) => b.bar !== null);
    return (
      <section className="desk-energy" role="status">
        <p>
          {t("common.energyLow", { full, used: used.length > 0 ? t("common.energyUsedToday", { list: used.join(t("wallet.listAnd")) }) : "" })}
        </p>
        {/* NO BAR AGAINST AN ALLOWANCE NOBODY READ — the You screen's rule. */}
        {bars.map((b) => (
          <progress key={b.label} aria-label={b.label} value={b.bar!.used} max={b.bar!.allowed} />
        ))}
        <button type="button" onClick={onDeposit}>
          {t("common.topUpHow")}
        </button>
      </section>
    );
  }

  const copyAddress = async () => {
    if (!account) return;
    try {
      await navigator.clipboard.writeText(account);
      setCopy("copied");
    } catch {
      setCopy("error");
    }
  };

  return (
    <section className="desk-energy spent" role="status">
      <strong>{t("common.energySpentTitle")}</strong>
      <p>{t("common.energySpentBody", { full })}</p>
      {view.kind === "unread" ? (
        <p>{t("common.energyUnreadShort")}</p>
      ) : view.total !== null ? (
        <p>
          {t("common.energyHoldLine", { who: view.noWallet ? t("common.energyHoldMine") : t("common.energyHoldOurs"), total: count(view.total), short: count(view.short) })}
        </p>
      ) : null}
      {remedies.sendToAgent && account ? (
        <>
          <p>{t("common.energySendHere")}</p>
          <code className="funding-address">{account}</code>
          <button type="button" onClick={() => void copyAddress()}>
            {copy === "copied" ? t("common.addressCopied") : t("common.copyAddress")}
          </button>
          {copy === "error" && <p role="alert">{t("common.copyFailedSelect")}</p>}
          {remedies.usdg === "ready" && (
            <>
              <p>
                {t("common.energyUsdgReady", { estimate: estimateUsdg !== null ? t("common.energyEstimate", { amount: usd(estimateUsdg) }) : "" })}
              </p>
              <button type="button" onClick={onAsk}>
                {t("common.energyAskMe")}
              </button>
            </>
          )}
          {remedies.usdg === "paper" && (
            <p>
              {t("common.energyPaper")}
            </p>
          )}
          {remedies.usdg === "resign" && (
            <>
              <p>{t("common.energyResign")}</p>
              <button type="button" onClick={onResign}>
                {t("common.resignPermission")}
              </button>
            </>
          )}
        </>
      ) : remedies.usdg === "not-mainnet" ? (
        <p>
          {t("common.energyOtherNetwork", { full })}
        </p>
      ) : (
        <p>{t("common.energyKeepOwn")}</p>
      )}
      <p>{t("common.energyChangeNothingDesk")}</p>
    </section>
  );
}
