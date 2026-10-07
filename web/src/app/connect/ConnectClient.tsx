"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Link2, ShieldCheck, Unplug } from "lucide-react";
import {
  FundingPanel,
  SignIn,
  requestJson,
  type AccountState,
} from "@/terminal/HostedControls";
import { CreateAgent } from "@/terminal/screens/CreateAgent";
import { fetchAccountForSession, readAccountForSession } from "@/terminal/account-session";
import { loadGrant, type Grant } from "@/lib/session";
import { useT } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages/en";

const TOKEN_STORAGE = "merrymen.partner-connect";

interface Connection {
  id: string;
  partner_name: string;
  name: string;
  scopes: string[];
  status: "pending" | "linked" | "revoked";
  signed_in: boolean;
  has_agent: boolean;
}

const ACCESS: Record<string, { title: MessageKey; detail: MessageKey }> = {
  "read:agents": { title: "connect.accessReadTitle", detail: "connect.accessReadDetail" },
  "chat:agents": { title: "connect.accessChatTitle", detail: "connect.accessChatDetail" },
};

async function connectRequest<T>(body: Record<string, string>): Promise<T> {
  const response = await fetch("/api/partner-connect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    signal: AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok) {
    const message = typeof data.error === "string" ? data.error : data.error?.message;
    throw new Error(message || `CONNECT_ERR:${response.status}`);
  }
  return data as T;
}

async function readAccount(): Promise<AccountState> {
  const result = await readAccountForSession(
    null,
    () => requestJson<AccountState["session"]>("/api/auth/session"),
    () => requestJson<AccountState["status"]>("/api/grants"),
  );
  if (result.kind === "ready") return result.account;
  if (result.kind === "changed") throw new Error("CONNECT_SIGN_CHANGED");
  throw result.error;
}

// A grant can already be on the server while its owner is still at the backup
// step. Reloading this page must not turn that into permission to skip backup.
function needsBackup(account: AccountState): boolean {
  const local = loadGrant();
  if (!local || local.smartAccount.toLowerCase() !== account.status.grant?.smartAccount.toLowerCase()) return false;
  return localStorage.getItem(`merrymen.backup.${local.smartAccount.toLowerCase()}`) !== "1";
}

// Module-level request helpers throw sentinels, not sentences: they have no
// hook, and a server refusal must pass through verbatim rather than be
// replaced. Anything unrecognised is a server message and stays as-is.
function xlate(t: ReturnType<typeof useT>, message: string): string {
  const req = /^CONNECT_ERR:(\d+)$/.exec(message);
  if (req) return t("connect.errRequest", { status: req[1]! });
  if (message === "CONNECT_SIGN_CHANGED") return t("connect.errSignChanged");
  if (message === "CONNECT_CONFIRM") return t("connect.errConfirm");
  if (message === "CONNECT_CHANGED") return t("connect.errChanged");
  return message;
}

export function ConnectClient() {
  const t = useT();
  const [token, setToken] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [showFunding, setShowFunding] = useState(false);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const requestVersion = useRef(0);
  const accountReadVersion = useRef(0);

  useEffect(() => {
    // Fragments are not sent to the server. Keep the credential in this tab
    // through sign-in, and immediately remove it from the address/history bar.
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const supplied = fragment.get("token");
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    let value = supplied;
    try {
      if (supplied !== null) sessionStorage.setItem(TOKEN_STORAGE, supplied);
      else value = sessionStorage.getItem(TOKEN_STORAGE);
    } catch {
      // The current page can still finish when tab storage is unavailable.
    }
    if (!value || value.length > 4096) {
      setToken("");
      setLoading(false);
      setError(t("connect.errNoLink"));
      return;
    }
    setToken(value);
  }, []);

  const refresh = useCallback(async (finishSetup = false) => {
    if (!token) return;
    const version = ++requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const next = await connectRequest<Connection>({ action: "inspect", token });
      const nextAccount = next.signed_in ? await readAccount() : null;
      if (version !== requestVersion.current) return;
      setConnection(next);
      setAccount(nextAccount);
      if (next.status === "pending" && nextAccount) {
        const backupPending = needsBackup(nextAccount);
        if (backupPending) setShowSetup(true);
        else if (finishSetup && next.has_agent) setShowSetup(false);
      }
    } catch (cause) {
      if (version === requestVersion.current) {
        setConnection(null);
        setAccount(null);
        setError(cause instanceof Error ? xlate(t, cause.message) : t("connect.errLoad"));
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }, [token, t]);

  useEffect(() => {
    if (token) void refresh();
    return () => { requestVersion.current += 1; };
  }, [token, refresh]);

  const refreshAccount = useCallback(() => {
    const version = ++accountReadVersion.current;
    void readAccount().then((next) => {
      if (version === accountReadVersion.current) setAccount(next);
    }).catch(() => {
      if (version === accountReadVersion.current) {
        setAccount(null);
        setError(t("connect.errRefresh"));
      }
    });
  }, []);

  const onSignedIn = () => {
    // A prior signed-out/no-agent read is no longer this session's answer. An
    // older account request must not put it back while inspect runs again.
    accountReadVersion.current += 1;
    setAccount(null);
    void refresh();
  };

  async function allowAccess() {
    if (!token || !connection || busy || loading) return;
    setBusy(true);
    setError("");
    try {
      if (!account?.session.hosted || !account.session.address) throw new Error("CONNECT_CONFIRM");
      const confirmed = await fetchAccountForSession(account.session);
      if (confirmed.kind !== "ready" || !confirmed.account.status.exists || !confirmed.account.session.address) {
        setAccount(null);
        throw new Error("CONNECT_CHANGED");
      }
      await connectRequest<{ connected: true; id: string }>({ action: "connect", token, expectedTenant: confirmed.account.session.address });
      setConnection({ ...connection, status: "linked" });
    } catch (cause) {
      setError(cause instanceof Error ? xlate(t, cause.message) : t("connect.errConnect"));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (!connection || busy) return;
    setBusy(true);
    setError("");
    try {
      await connectRequest({ action: "disconnect", id: connection.id });
      setConnection({ ...connection, status: "revoked" });
      setRemoveConfirm(false);
      try { sessionStorage.removeItem(TOKEN_STORAGE); } catch { /* Optional tab storage. */ }
    } catch (cause) {
      setError(cause instanceof Error ? xlate(t, cause.message) : t("connect.errDisconnect"));
    } finally {
      setBusy(false);
    }
  }

  function openFunding(grant: Grant) {
    setAccount(current => current ? { ...current, status: { ...current.status, exists: true, grant } } : current);
    setShowFunding(true);
  }

  function finishSetup() {
    setShowFunding(false);
    void refresh(true);
  }

  const appName = connection?.partner_name || t("connect.appFallbackPartner");
  const pending = connection?.status === "pending";
  const needsRenewal = pending && connection.signed_in && !connection.has_agent && account?.status.exists;
  const setup = pending && connection.signed_in && showSetup && !needsRenewal;
  const step = connection?.status === "linked" ? 3 : !connection?.signed_in ? 0 : !connection.has_agent || showSetup ? 1 : 2;

  return (
    <div className="terminal-host partner-connect">
      <header className="connect-header">
        <a href="/" className="connect-brand" aria-label="Merrymen home">merrymen<span aria-hidden>↗</span></a>
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> {t("connect.headerLabel")}</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">{t("connect.eyebrow")}</span>
          <h1>{connection?.status === "linked" ? t("connect.linkedTitle") : connection?.status === "revoked" ? t("connect.revokedTitle") : <>{t("connect.pendingTitleA")}<br />{t("connect.pendingTitleB")}</>}</h1>
          <p>{connection?.status === "linked"
            ? t("connect.linkedBody", { app: appName })
            : connection?.status === "revoked"
              ? t("connect.revokedBody", { app: appName })
              : connection
                ? t("connect.pendingBody", { app: appName })
                : t("connect.noConnBody")}</p>
          {connection && connection.status !== "revoked" && (
            <ol className="connect-progress" aria-label="Connection progress">
              {[t("connect.stepSignIn"), t("connect.stepAgent"), t("connect.stepAllow")].map((label, index) => (
                <li key={label} className={step >= index ? "active" : ""} aria-current={step === index ? "step" : undefined}>
                  <span>{step > index ? <Check size={13} aria-hidden /> : index + 1}</span>{label}
                </li>
              ))}
            </ol>
          )}
          {connection && <div className="connect-app"><span className="connect-app-icon"><Link2 size={20} aria-hidden /></span><div><strong>{appName}</strong><span>{connection.name || t("connect.appFallback")}</span></div></div>}
        </div>

        <section className={`connect-panel${setup ? " connect-panel-setup" : ""}`} aria-label="Connect your agent" aria-busy={loading || busy}>
          {!connection && loading && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />{t("connect.checking")}</div>}
          {!connection && !loading && <><h2>{t("connect.startTitle")}</h2><p>{t("connect.startBody")}</p></>}

          {pending && !connection.signed_in && <>
            <span className="connect-step-label">{t("connect.s1")}</span>
            <h2>{t("connect.signinTitle")}</h2>
            <p>{t("connect.signinBody", { app: appName })}</p>
            <SignIn onDone={onSignedIn} />
          </>}

          {needsRenewal && <>
            <span className="connect-step-label">{t("connect.s2")}</span>
            <h2>{t("connect.renewTitle")}</h2>
            <p>{t("connect.renewBody")}</p>
            <a className="flow-primary" href="/grant">{t("connect.reviewPerms")} <ArrowRight size={16} aria-hidden /></a>
            <button className="connect-cancel" disabled={loading} onClick={() => void refresh(true)}>{t("connect.updated")}</button>
          </>}

          {pending && connection.signed_in && !connection.has_agent && !showSetup && !needsRenewal && <>
            <span className="connect-step-label">{t("connect.s2")}</span>
            <h2>{t("connect.homeTitle")}</h2>
            <p>{t("connect.homeBody", { app: appName })}</p>
            <button className="flow-primary" disabled={loading} onClick={() => setShowSetup(true)}>{t("connect.setupBtn")} <ArrowRight size={16} aria-hidden /></button>
          </>}

          {setup && (showFunding && account
            ? <><FundingPanel mode="deposit" account={account} onClose={finishSetup} /><button className="flow-primary" disabled={loading} onClick={finishSetup}>{t("connect.continueBtn")} <ArrowRight size={16} aria-hidden /></button></>
            : <><div className="connect-setup-note">{t("connect.setupNote", { app: appName })}</div><CreateAgent account={account} onRefresh={refreshAccount} onSignedIn={onSignedIn} onBack={() => setShowSetup(false)} onDone={finishSetup} onFund={openFunding} /></>)}

          {pending && connection.signed_in && connection.has_agent && !showSetup && <>
            <span className="connect-step-label">{t("connect.s3")}</span>
            <h2>{t("connect.allowTitle", { app: appName })}</h2>
            <p>{t("connect.allowBody")}</p>
            <ul className="connect-permissions">{connection.scopes.map(scope => <li key={scope}><Check size={17} aria-hidden /><div><strong>{ACCESS[scope] ? t(ACCESS[scope]!.title) : scope}</strong><span>{ACCESS[scope] ? t(ACCESS[scope]!.detail) : t("connect.accessFallback")}</span></div></li>)}</ul>
            <div className="connect-boundary"><ShieldCheck size={19} aria-hidden /><p>{t("connect.boundary")}</p></div>
            <button className="flow-primary" disabled={busy || loading} onClick={() => void allowAccess()}>{busy ? t("connect.connecting") : t("connect.allowBtn", { app: appName })} {!busy && <ArrowRight size={16} aria-hidden />}</button>
            <a className="connect-cancel" href="/">{t("connect.cancel")}</a>
          </>}

          {connection?.status === "linked" && <>
            <div className="connect-success-icon"><Check size={25} aria-hidden /></div>
            <h2>{t("connect.backTitle", { app: appName })}</h2>
            <p>{connection.scopes.includes("chat:agents") ? t("connect.backChat") : t("connect.backStatus")}</p>
            <p className="connect-subtle">{t("connect.subtle")}</p>
            <a className="flow-primary" href="/agent">{t("connect.viewAgent")} <ArrowRight size={16} aria-hidden /></a>
            <div className="connect-disconnect">
              {removeConfirm ? <><p>{t("connect.removeQ", { app: appName })}</p><div><button className="connect-danger" disabled={busy} onClick={() => void disconnect()}>{busy ? t("connect.disconnecting") : t("connect.disconnectBtn")}</button><button className="connect-cancel" disabled={busy} onClick={() => setRemoveConfirm(false)}>{t("connect.keep")}</button></div></>
                : <button className="connect-cancel" onClick={() => setRemoveConfirm(true)}><Unplug size={15} aria-hidden /> {t("connect.disconnectBtn")}</button>}
            </div>
          </>}

          {connection?.status === "revoked" && <><Unplug className="connect-revoked-icon" size={30} aria-hidden /><h2>{t("connect.controlTitle")}</h2><p>{t("connect.controlBody", { app: appName })}</p><a className="flow-primary" href="/agent">{t("connect.goAgent")} <ArrowRight size={16} aria-hidden /></a></>}

          {error && <div className="connect-error" role="alert"><p>{error}</p>{token && <button disabled={loading || busy} onClick={() => void refresh()}>{t("connect.tryAgain")}</button>}</div>}
        </section>
      </main>
      <footer className="connect-footer">{t("connect.footer")}</footer>
    </div>
  );
}
