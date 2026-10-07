import { useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { createPortal } from "react-dom";

type CardState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "image"; url: string };

/** Kept in memory, never cached or stored alongside the wallet. */
export function PnlCardDialog({ tradeId, symbol, onClose }: {
  tradeId: number;
  symbol: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const noteId = useId();
  const t = useT();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<CardState>({ kind: "loading" });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement;
    node.showModal();
    return () => {
      node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    let timedOut = false;
    let objectUrl: string | undefined;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    setState({ kind: "loading" });
    setLoaded(false);
    void (async () => {
      try {
        const response = await fetch(`/api/pnl?trade=${tradeId}`, {
          credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(response.status === 401 || response.status === 403 || response.status === 404
            ? t("common.pnlGone")
            : response.status === 409
              ? t("common.pnlNoImage")
              : t("common.pnlGenFailed"));
        }
        if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "image/png") {
          throw new Error(t("common.pnlLoadFailed"));
        }
        const blob = await response.blob();
        if (disposed) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ kind: "image", url: objectUrl });
      } catch (error) {
        if (disposed) return;
        setState({ kind: "error", message: timedOut
          ? t("common.pnlTooLong")
          : error instanceof Error && error.name !== "TypeError" ? error.message : t("common.pnlConnFailed") });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [tradeId, attempt]);

  const filename = `${symbol.replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || "trade"}-${tradeId}-pnl.png`;
  return createPortal(
    <div className="terminal-host pnl-card-layer">
      <dialog ref={dialog} className="pnl-card-dialog" aria-labelledby={titleId} aria-describedby={noteId}
        onCancel={(event) => { event.preventDefault(); onClose(); }}>
        <header className="pnl-card-toolbar">
          <h2 id={titleId}>{t("common.pnlTitle", { symbol })}</h2>
          <button type="button" onClick={onClose}>{t("common.pnlClose")}</button>
        </header>
        <p id={noteId} className="pnl-card-note">{t("common.pnlNote")}</p>
        {state.kind === "loading" && <p className="pnl-card-status" role="status">{t("common.pnlCreating")}</p>}
        {state.kind === "error" && <div className="pnl-card-status" role="alert">
          <p>{state.message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("common.tryAgain")}</button>
        </div>}
        {state.kind === "image" && <>
          {/* The renderer returns authenticated PNG bytes, not a public image URL. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="pnl-card-image" src={state.url} width={1280} height={853}
            alt={t("common.pnlAlt", { symbol })}
            onLoad={() => setLoaded(true)}
            onError={() => setState({ kind: "error", message: t("common.pnlDisplayFailed") })} />
          <div className="pnl-card-actions">
            {loaded ? <a href={state.url} download={filename}>{t("common.pnlDownload")}</a> : <span role="status">{t("common.pnlPreview")}</span>}
            <button type="button" disabled={!loaded} onClick={() => window.print()}>{t("common.pnlPrint")}</button>
          </div>
        </>}
      </dialog>
    </div>, document.body,
  );
}
