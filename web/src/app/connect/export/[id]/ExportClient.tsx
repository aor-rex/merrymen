"use client";

/**
 * Where an export's download link lands. The file itself is served by
 * /api/mcp/exports/<id>, which refuses cross-site requests and only answers the
 * owner's own session — so a link clicked inside an AI assistant (a cross-site
 * navigation, which also never carries the SameSite=Strict session cookie)
 * cannot fetch it directly. This page is an ordinary navigation target: it
 * loads, asks the API about the file same-origin, and offers a Download button
 * whose same-origin request carries the owner's session.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, FileText, ShieldCheck } from "lucide-react";
import { count, fullDateTime } from "@/lib/format";
import { SignIn } from "@/terminal/HostedControls";
import { useT } from "@/lib/i18n";
import { BrandLockup } from "../../BrandLockup";

interface Info {
  id: string;
  kind: string;
  format: string;
  filename: string;
  bytes: number;
  created_at: number;
  expires_at: number;
}

type State =
  | { phase: "loading" }
  | { phase: "signed-out" }
  | { phase: "missing" }
  | { phase: "expired" }
  | { phase: "error"; message: string }
  | { phase: "ready"; info: Info };

export function ExportClient({ id }: { id: string }) {
  const t = useT();
  const [state, setState] = useState<State>({ phase: "loading" });
  const href = `/api/mcp/exports/${encodeURIComponent(id)}`;

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await fetch(`${href}?info=1`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(30_000) });
      if (res.status === 401) return setState({ phase: "signed-out" });
      if (res.status === 404) return setState({ phase: "missing" });
      if (res.status === 410) return setState({ phase: "expired" });
      // The API's own sentence passes through verbatim; only the fallback is keyed.
      if (!res.ok) return setState({ phase: "error", message: t("connect.exportReadFail", { status: res.status }) });
      setState({ phase: "ready", info: await res.json() as Info });
    } catch {
      setState({ phase: "error", message: t("connect.consentSlow") });
    }
  }, [href, t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> {t("connect.exportHeader")}</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">{t("connect.preparedEyebrow")}</span>
          <h1>{t("connect.exportTitle")}</h1>
          <p>{t("connect.exportIntro")}</p>
        </div>
        <section className="connect-panel" aria-busy={state.phase === "loading"}>
          {state.phase === "loading" && <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />{t("connect.loading")}</div>}
          {state.phase === "signed-out" && <><h2>{t("connect.signinOwner")}</h2><SignIn onDone={() => void load()} /></>}
          {state.phase === "missing" && <><h2>{t("connect.exportMissing")}</h2><p className="mcp-note">{t("connect.exportMissingNote")}</p></>}
          {state.phase === "expired" && <><h2>{t("connect.exportExpired")}</h2><p className="mcp-note">{t("connect.exportExpiredNote")}</p></>}
          {state.phase === "error" && <div className="connect-error" role="alert"><p>{state.message}</p><button onClick={() => void load()}>{t("connect.tryAgain")}</button></div>}
          {state.phase === "ready" && <>
            <span className="connect-step-label">{state.info.kind.toUpperCase()} · {state.info.format.toUpperCase()}</span>
            <h2>{state.info.filename}</h2>
            <ul className="mcp-checks">
              <li><label><FileText size={16} aria-hidden /><span><strong>{t("connect.exportBytes", { n: count(state.info.bytes) })}</strong><span>{t("connect.exportMade", { made: fullDateTime(state.info.created_at * 1000), expires: fullDateTime(state.info.expires_at * 1000) })}</span></span></label></li>
            </ul>
            <a className="flow-primary" href={href} download={state.info.filename}>{t("connect.exportDownload")} <Download size={16} aria-hidden /></a>
          </>}
        </section>
      </main>
      <footer className="connect-footer">{t("connect.manageFooterPre")} <a href="/connect/apps">{t("connect.appsLink")}</a>.</footer>
    </div>
  );
}
