"use client";

/**
 * WHERE X SENDS AN OWNER BACK AFTER THEY APPROVE (OR DON'T) — the one
 * registered callback, `${MERRYMEN_PUBLIC_ORIGIN}/connect/x`.
 *
 * A PAGE, NOT AN API ROUTE, and that is forced: the middleware refuses a
 * cross-site request on /api/*, and the SameSite=Strict session cookie is not
 * sent on a navigation that started at x.com. A page loads anyway; its own
 * same-origin POST then carries the session, and the finish route checks that
 * session against the owner who started the connect.
 *
 * THE CODE LEAVES THE ADDRESS BAR FIRST. It is read once and the URL is
 * scrubbed with history.replaceState before anything else happens, so it is
 * not left in history, a bookmark or a screenshot; next.config.mjs sends this
 * path no-referrer and forbids framing, so it cannot leak through a Referer or
 * be clickjacked either.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: retry. The finish spends the pending
 * connect on its first arrival and X's code lives about thirty seconds, so a
 * second try can only fail; the owner is sent back to Settings to start again.
 *
 * IT SAYS POSTING IS ON ONLY WHEN THE FINISH SAYS SO. Connecting is not
 * consent, and the Settings switch, behind its warning, is the only way on —
 * but a reconnect of the SAME X account after X revoked it keeps the consent
 * the owner already gave that account, so posting resumes from the next pass.
 * The finish reads back `postingEnabled` after its write; when it is true the
 * page says posting is back on, and never "won't post anything yet".
 */
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { xHandleTag } from "@/lib/x-handle";
import { useT } from "@/lib/i18n";
import { BrandLockup } from "../BrandLockup";
import { readCallback } from "./callback";

type Phase =
  | { kind: "working" }
  | { kind: "handoff"; href: string }
  | { kind: "connected"; handle: string | null; postingEnabled: boolean }
  | { kind: "declined" }
  | { kind: "nothing" }
  | { kind: "failed"; message: string };

const SETTINGS = "/settings#x-posting";

// The finish helper runs outside the component, so failures arrive as
// sentinels; the route's own sentences (server-driven, never carrying what X
// said) pass through verbatim. Anything unrecognised stays as-is.
function xlate(t: ReturnType<typeof useT>, message: string): string {
  if (message === "X_UNREACHABLE") return t("connect.xUnreachable");
  if (message === "X_SIGNIN") return t("connect.xSignin");
  const status = /^X_STATUS:(\d+)$/.exec(message);
  if (status) return t("connect.xStatus", { status: status[1]! });
  return message;
}

async function finishConnect(code: string, state: string): Promise<Phase> {
  let res: Response;
  try {
    res = await fetch("/api/x/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "finish", code, state }),
      cache: "no-store",
      credentials: "same-origin",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { kind: "failed", message: "X_UNREACHABLE" };
  }
  const data = (await res.json().catch(() => null)) as
    | { ok?: unknown; username?: unknown; postingEnabled?: unknown; error?: unknown }
    | null;
  if (res.ok && data?.ok === true) {
    return {
      kind: "connected",
      handle: xHandleTag(typeof data.username === "string" ? data.username : null),
      // Only a plain true is "on"; an older server's answer without it is off.
      postingEnabled: data.postingEnabled === true,
    };
  }
  if (res.status === 401) {
    return { kind: "failed", message: "X_SIGNIN" };
  }
  // The route's sentences are written for owners and never carry what X said.
  if (typeof data?.error === "string" && data.error) return { kind: "failed", message: data.error };
  return { kind: "failed", message: `X_STATUS:${res.status}` };
}

export function XConnectClient() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>({ kind: "working" });
  // Once per page load, including under StrictMode's double effect: the URL
  // is scrubbed on the first run, and a second finish could only be refused.
  const began = useRef(false);

  useEffect(() => {
    if (began.current) return;
    began.current = true;
    const callback = readCallback(window.location.search);
    if (window.location.search || window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (callback.kind === "ios") {
      setPhase({ kind: "handoff", href: callback.href });
      window.location.replace(callback.href);
      return;
    }
    if (callback.kind === "declined" || callback.kind === "nothing") {
      setPhase({ kind: callback.kind });
      return;
    }
    if (callback.kind === "failed") {
      setPhase(callback);
      return;
    }
    // No cleanup that drops the answer: under StrictMode the effect's first
    // run is torn down and the second returns early above, so a "still
    // mounted?" flag here would leave the page on "Finishing…" for good. A
    // state update after a real unmount is a no-op.
    void finishConnect(callback.code, callback.state).then(setPhase);
  }, []);

  return (
    <div className="terminal-host partner-connect mcp-connect">
      <header className="connect-header">
        <BrandLockup />
        <span className="connect-header-label"><ShieldCheck size={14} aria-hidden /> {t("connect.xHeader")}</span>
      </header>
      <main className="connect-main">
        <div className="connect-context">
          <span className="connect-eyebrow">{t("connect.xEyebrow")}</span>
          <h1>{t("connect.xTitle")}</h1>
          <p>{t("connect.xIntro")}</p>
        </div>
        <section className="connect-panel" aria-busy={phase.kind === "working"} aria-live="polite">
          {phase.kind === "working" && (
            <div className="connect-wait" role="status"><span className="connect-spinner" aria-hidden />{t("connect.xWorking")}</div>
          )}
          {phase.kind === "handoff" && (
            <>
              <h2>{t("connect.xHandoff")}</h2>
              <p>{t("connect.xHandoffPre")}<a href={phase.href}>{t("connect.xHandoffLink")}</a>.</p>
            </>
          )}
          {phase.kind === "connected" && (
            <>
              <h2>{phase.handle ? t("connect.xConnectedAs", { handle: phase.handle }) : t("connect.xConnected")}</h2>
              {phase.postingEnabled ? (
                <p>
                  {t("connect.xBackOn", { handle: phase.handle ?? t("connect.xThisAccount") })}
                </p>
              ) : (
                <p>{t("connect.xOff")}</p>
              )}
              <a className="flow-primary" href={SETTINGS}><ArrowLeft size={16} aria-hidden /> {t("connect.xBackSettings")}</a>
            </>
          )}
          {phase.kind === "declined" && (
            <>
              <h2>{t("connect.xDeclined")}</h2>
              <p>{t("connect.xDeclinedNote")}</p>
              <a className="flow-primary" href={SETTINGS}><ArrowLeft size={16} aria-hidden /> {t("connect.xBackSettings")}</a>
            </>
          )}
          {phase.kind === "nothing" && (
            <>
              <h2>{t("connect.xNothing")}</h2>
              <p>{t("connect.xNothingNote")}</p>
              <a className="flow-primary" href={SETTINGS}><ArrowLeft size={16} aria-hidden /> {t("connect.xGoSettings")}</a>
            </>
          )}
          {phase.kind === "failed" && (
            <>
              <h2>{t("connect.xFailed")}</h2>
              <div className="connect-error" role="alert"><p>{xlate(t, phase.message)}</p></div>
              <a className="flow-primary" style={{ marginTop: 20 }} href={SETTINGS}><ArrowLeft size={16} aria-hidden /> {t("connect.xBackSettings")}</a>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
