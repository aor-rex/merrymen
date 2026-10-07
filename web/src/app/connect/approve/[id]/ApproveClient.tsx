"use client";

/**
 * The owner's approval screen for something an AI assistant prepared: a trade,
 * a settings change, an agent setup or a group-chat post. It shows exactly what
 * will happen (the stored binding the server will check), who asked for it,
 * and — for a trade — a fresh quote and whether it is real money or practice.
 * Approve or Decline posts the binding's hash back, so the server acts only on
 * what this page displayed.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRight, Check, ShieldCheck, X } from "lucide-react";
import { fullDateTime } from "@/lib/format";
import { SignIn } from "@/terminal/HostedControls";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages/en";
import { BrandLockup } from "../../BrandLockup";

import { TERMINAL, approvable, bookBox, headline, resumeDecision, short, text, usdg, type SettingsCheck, type View } from "./approve-view";
export { approvable, bookBox, headline, outcomeBook, resumeDecision } from "./approve-view";

/** What the owner reads when their session ended mid-decision: never a bare status word. */
export const SESSION_ENDED = "Your session ended; sign in to finish.";

const isSignedOut = (e: unknown) => (e as { signedOut?: boolean } | null)?.signedOut === true;

export async function call<T>(id: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`/api/mcp/approvals/${encodeURIComponent(id)}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw Object.assign(new Error(SESSION_ENDED), { signedOut: true });
  if (!res.ok) throw new Error(typeof data.error_description === "string" ? data.error_description : res.status === 404 ? "There is no such request for this account. Check you are signed in as the agent's owner." : `Request failed (${res.status}).`);
  return data as T;
}


/**
 * Settings changes and drafts, as the owner decides them: each setting as it
 * is NOW (read live, not when the assistant asked) and as it would become.
 * A setting that moved since the proposal is flagged, and the server refuses
 * the approval until a fresh proposal.
 */
function SettingsRows({ c }: { c: SettingsCheck }) {
  const t = useT();
  return <>
    {c.changed_since.length > 0 && <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p><b>{t("connect.approveSettingsChangedTitle")}</b> {t("connect.approveSettingsChangedBody")}</p></div>}
    <ul className="mcp-checks">{c.rows.map((d) => <li key={d.key}><label><span>
      <strong>{d.label}: {d.current === d.proposed ? <>{d.current} {t("connect.approveNoChange")}</> : <>{d.current} → {d.proposed}</>}</strong>
      <span>{d.changed ? `${t("connect.approveWasWhen", { when: d.when_proposed })} ` : ""}{d.help}</span>
    </span></label></li>)}</ul>
  </>;
}

function Details({ v }: { v: View }) {
  const t = useT();
  const b = v.binding;
  const s = v.summary;
  if (v.kind === "trade") {
    const box = bookBox(v);
    const limits = (b.limits as Record<string, unknown>) ?? {};
    const ceiling = limits.chat_ceiling_usdg;
    return <>
      {box.warn
        ? <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p>{box.text}</p></div>
        : <div className="connect-boundary"><ShieldCheck size={18} aria-hidden /><p>{box.text}</p></div>}
      <ul className="mcp-checks">
        <li><label><span><strong>{text(s.action)}</strong><span>{t("connect.approveTokenLine", { token: short(b.token), symbol: text(b.symbol), chain: text(b.chain_id) })}</span></span></label></li>
        <li><label><span><strong>{t("connect.approveQuoted")}</strong><span>{text(s.expected_out)} / {text(s.min_out)} {b.side === "buy" ? String(b.symbol) : "USDG"} · {t("connect.approveSlippage", { pct: Number(b.slippage_bps) / 100 })}</span></span></label></li>
        {v.fresh_quote && <li><label><span><strong>{t("connect.approvePriceNow")}</strong><span>{v.fresh_quote.quoted ? `expect ${text(v.fresh_quote.expected_out?.human)} · impact ${v.fresh_quote.price_impact_bps ?? "unknown"} bps${v.fresh_quote.impact_verdict.ok ? "" : ` · ${v.fresh_quote.impact_verdict.detail}`}` : `no quote: ${v.fresh_quote.why_not}`}</span></span></label></li>}
        <li><label><span><strong>{t("connect.approveLimitsTitle")}</strong><span>{t("connect.approveLimits", { perTrade: usdg(limits.per_trade_usdg), ceiling: ceiling === 0 ? t("connect.approveNoCeiling") : usdg(ceiling), daily: usdg(limits.daily_usdg) })}</span></span></label></li>
      </ul>
      <p className="mcp-note">
        {t("connect.approveChecksIntro")} {b.side === "buy" ? t("connect.approveChecksBuy") : t("connect.approveChecksSell")} {t("connect.approveChecksAfter")}
      </p>
    </>;
  }
  if (v.kind === "settings") {
    if (v.settings_check) return <><SettingsRows c={v.settings_check} /><p className="mcp-note">{t("connect.approveSettingsApply")}</p></>;
    const diff = (s.diff as Array<{ label: string; current: string; proposed: string; help: string }>) ?? [];
    return <ul className="mcp-checks">{diff.map((d) => <li key={d.label}><label><span><strong>{d.label}: {d.current} → {d.proposed}</strong><span>{d.help}</span></span></label></li>)}</ul>;
  }
  if (v.kind === "agent_draft") {
    const c = v.settings_check;
    if (!c) {
      const settings = (b.settings as Record<string, unknown>) ?? {};
      return <>
        <ul className="mcp-checks">{Object.entries(settings).map(([k, val]) => <li key={k}><label><span><strong>{k}</strong><span>{text(val)}</span></span></label></li>)}</ul>
        {v.status === "awaiting_approval" && <p className="mcp-note">{t("connect.approveSettingsUnread")}</p>}
      </>;
    }
    return <>
      {c.applies_to_running_agent && <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p><b>{t("connect.approveRunningTitle")}</b> {t("connect.approveRunningBody")}</p></div>}
      <SettingsRows c={c} />
      {c.left_out.length > 0 && <p className="mcp-note">{t("connect.approveLeftOut", { list: c.left_out.join(", ") })}</p>}
      {!c.applies_to_running_agent && <p className="mcp-note">{t("connect.approveSaveOnly")}</p>}
    </>;
  }
  return <div className="connect-boundary"><p>“{text(b.text)}”</p></div>;
}

const NOUN_KEY: Record<View["kind"], MessageKey> = {
  trade: "connect.approveNounTrade",
  settings: "connect.approveNounSettings",
  agent_draft: "connect.approveNounDraft",
  post: "connect.approveNounPost",
};

const TITLE_KEY: Record<View["kind"], MessageKey> = {
  trade: "connect.approveTitleTrade",
  settings: "connect.approveTitleSettings",
  agent_draft: "connect.approveTitleDraft",
  post: "connect.approveTitlePost",
};

export function ApproveClient({ id }: { id: string }) {
  const t = useT();
  const [v, setV] = useState<View | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A decision pressed after the session had ended: finished once the owner signs in again (resumeDecision). */
  const pending = useRef<{ decision: "approve" | "reject"; hash: string } | null>(null);
  const [resuming, setResuming] = useState<"approve" | "reject" | null>(null);

  const load = useCallback(async (): Promise<View | null> => {
    setError("");
    try {
      const next = await call<View>(id);
      setV(next);
      setSignedOut(false);
      if (!TERMINAL.has(next.status) && next.status !== "awaiting_approval") poll.current = setTimeout(() => void load(), 5000);
      return next;
    } catch (e) {
      if (isSignedOut(e)) setSignedOut(true);
      else setError(e instanceof Error ? e.message : t("connect.consentLoadReq"));
      return null;
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => { void load(); return () => { if (poll.current) clearTimeout(poll.current); }; }, [load]);

  async function decide(decision: "approve" | "reject", on: View | null = v) {
    if (!on || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await call<View>(id, { decision, hash: on.binding_hash });
      setV(next);
      if (!TERMINAL.has(next.status)) poll.current = setTimeout(() => void load(), 5000);
    } catch (e) {
      if (isSignedOut(e)) {
        // Nothing was decided. Keep what was pressed, take the buttons away,
        // and finish it once the owner has signed in again.
        pending.current = { decision, hash: on.binding_hash };
        setResuming(decision);
        setSignedOut(true);
      } else {
        setError(e instanceof Error ? e.message : t("connect.approveDecideFail"));
        void load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function afterSignIn() {
    const p = pending.current;
    pending.current = null;
    setResuming(null);
    const next = await load();
    const decision = resumeDecision(p, next, Date.now());
    if (decision && next) await decide(decision, next);
    else if (p && next) setError(t("connect.approveNotSent", { what: t(p.decision === "approve" ? "connect.approveNounApproval" : "connect.approveNounDecline") }));
  }

  const expired = v ? v.expires_at * 1000 < Date.now() : false;
  const deciding = v?.status === "awaiting_approval";
  const noun: MessageKey = v ? (NOUN_KEY[v.kind] ?? "connect.approveNounRequest") : "connect.approveNounRequest";
  const title = v && !deciding ? `${t(noun)}: ${headline(v).toLowerCase()}` : v ? t(TITLE_KEY[v.kind] ?? "connect.approveTitleGeneric") : t("connect.approveTitleGeneric");

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> {t("connect.approveHeader")}</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">{t("connect.preparedEyebrow")}</span>
          <h1>{v && v.status !== "awaiting_approval" ? headline(v) : <>{t("connect.approveYouDecide")}</>}</h1>
          <p>{t("connect.approveIntro")}{v?.kind === "trade" ? t("connect.approveIntroTrade") : ""}.</p>
          {v && <div className="connect-app"><div><strong>{t("connect.approveRequestedBy", { who: v.requested_by ?? t("connect.approveAiFallback") })}</strong><span>{fullDateTime(v.created_at * 1000)} · {v.status === "awaiting_approval" ? t("connect.approveExpires", { when: fullDateTime(v.expires_at * 1000) }) : headline(v)}</span></div></div>}
        </div>
        <section className="connect-panel" aria-busy={loading || busy}>
          {loading && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />{t("connect.loading")}</div>}
          {!loading && signedOut && <>
            <h2>{resuming ? t(resuming === "approve" ? "connect.approveResumeApprove" : "connect.approveResumeDecline") : t("connect.signinOwner")}</h2>
            {resuming && <p className="mcp-note">{t("connect.approveResumeNote", { what: t(resuming === "approve" ? "connect.approveWasApproved" : "connect.approveWasDeclined") })}</p>}
            <SignIn onDone={() => void afterSignIn()} />
          </>}
          {!loading && v && <>
            <span className="connect-step-label">{v.kind.replace("_", " ").toUpperCase()}</span>
            <h2>{title}</h2>
            {typeof v.summary.assistant_note === "string" && <p className="mcp-note">{t("connect.approveAssistantNote", { note: v.summary.assistant_note })}</p>}
            {v.status === "cancelled" && v.result?.requester_withdrawn === true && typeof v.result.why === "string" && <div className="connect-boundary mcp-warn"><AlertTriangle size={18} aria-hidden /><p>{t("connect.approveCancelled", { why: v.result.why })}</p></div>}
            <Details v={v} />
            {v.result && <details open={TERMINAL.has(v.status)}><summary>{t("connect.approveResult")}</summary><pre className="mcp-activity">{JSON.stringify(v.result, null, 2)}</pre></details>}
            {/* No decision is offered while signed out: pressing it could not be sent. */}
            {v.status === "awaiting_approval" && !expired && !signedOut && <>
              {/* A settings change whose "before" moved, or a trade whose book moved, is refused by the server; no button offers it. */}
              {approvable(v) && <button className="flow-primary" disabled={busy} onClick={() => void decide("approve")}>{busy ? t("connect.approveWorking") : t("connect.approveApprove")} {!busy && <ArrowRight size={16} aria-hidden />}</button>}
              <button className="connect-cancel" disabled={busy} onClick={() => void decide("reject")}><X size={15} aria-hidden /> {t("connect.decline")}</button>
            </>}
            {v.status === "awaiting_approval" && expired && <p className="mcp-note">{t("connect.approveExpired")}</p>}
            {v.status === "confirmed" && <div className="connect-success-icon"><Check size={25} aria-hidden /></div>}
          </>}
          {error && <div className="connect-error" role="alert"><p>{error}</p><button onClick={() => void load()}>{t("connect.reload")}</button></div>}
        </section>
      </main>
      <footer className="connect-footer">{t("connect.manageFooterPre")} <a href="/connect/apps">{t("connect.appsLink")}</a>.</footer>
    </div>
  );
}
