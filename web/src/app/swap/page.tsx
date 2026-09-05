"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatEther } from "viem";
import { LogoMark } from "@/components/Logo";

interface SwapQuote {
  ok: boolean;
  reason?: string;
  smartAccount?: string;
  deployed?: boolean;
  grantReady?: boolean;
  ethWei?: string;
  usdgRaw?: string;
  reserveWei?: string;
  surplusWei?: string;
  requestedWei?: string;
  amountWei?: string;
  capped?: boolean;
  quote?: {
    expectedOut: string;
    minOut: string;
    fee: number;
    source: "twap" | "spot";
    divergenceBps: number;
  } | null;
  slippageBps?: number;
  autoConvertEnabled?: boolean;
}

interface SwapStatus {
  state: "none" | "queued" | "running" | "done";
  id?: string;
  ok?: boolean;
  line?: string | null;
}

/** Decimal ETH string → wei bigint. Returns null when not a valid amount. */
function ethToWei(s: string): bigint | null {
  const t = s.trim();
  if (!/^\d+(\.\d{1,18})?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  try {
    return BigInt(whole) * 10n ** 18n + BigInt((frac + "0".repeat(18)).slice(0, 18));
  } catch {
    return null;
  }
}

function fmtUsdg(raw6: string): string {
  try {
    const v = BigInt(raw6);
    const whole = v / 1_000_000n;
    const frac = (v % 1_000_000n).toString().padStart(6, "0").slice(0, 2);
    return `${whole.toString()}.${frac}`;
  } catch {
    return "—";
  }
}

export default function SwapPage() {
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [trackId, setTrackId] = useState<string | null>(null);
  const [status, setStatus] = useState<SwapStatus | null>(null);
  const [history, setHistory] = useState<{ level: string; message: string }[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const wei = ethToWei(amount);
  const refreshQuote = useCallback(async (weiStr: string) => {
    if (!weiStr) {
      setQuote(null);
      return;
    }
    setQuoteLoading(true);
    try {
      const r = await fetch(`/api/swap/quote?wei=${weiStr}`);
      setQuote((await r.json()) as SwapQuote);
    } catch {
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  }, []);

  // Debounced preview as the amount is typed.
  useEffect(() => {
    if (wei === null || wei <= 0n) {
      setQuote(null);
      return;
    }
    const t = setTimeout(() => void refreshQuote(wei.toString()), 400);
    return () => clearTimeout(t);
  }, [amount, refreshQuote, wei]);

  // Recent convert activity, so the last auto-convert is visible here too —
  // the event feed is the worker's record of what actually fired.
  useEffect(() => {
    fetch("/api/feed")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const events = (d?.events ?? []) as { level: string; message: string }[];
        setHistory(
          events
            .filter((e) => /auto-convert ✓|manual-swap|auto-convert skipped/.test(e.message))
            .slice(0, 5),
        );
      })
      .catch(() => {});
  }, []);

  const stopPoll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };
  useEffect(() => stopPoll, []);

  const pollStatus = useCallback((id: string) => {
    stopPoll();
    const tick = async () => {
      try {
        const r = await fetch(`/api/swap/status?id=${id}`);
        const s = (await r.json()) as SwapStatus;
        setStatus(s);
        if (s.state === "done") stopPoll();
      } catch {
        /* keep polling */
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 5000);
    // Give up polling after ~6 minutes: the worker is likely stopped, and the
    // request itself is harmless sitting in settings until it runs.
    setTimeout(() => {
      stopPoll();
      setStatus((s) => (s?.state === "done" ? s : { state: "running", id }));
    }, 360_000);
  }, []);

  const submit = async () => {
    setSubmitError(null);
    setStatus(null);
    if (wei === null || wei <= 0n) {
      setSubmitError("Enter an amount of ETH first.");
      return;
    }
    const id = crypto.randomUUID();
    const res = await fetch("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ manualSwapWei: wei.toString(), manualSwapId: id }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; errors?: string[] };
    if (!res.ok || !body.ok) {
      setSubmitError(body.errors?.join("; ") ?? "Couldn't queue the swap.");
      return;
    }
    setTrackId(id);
    pollStatus(id);
  };

  const surplus = quote?.ok && quote.surplusWei ? BigInt(quote.surplusWei) : null;
  const grantReady = quote?.grantReady;
  const tracking = trackId && status && status.state !== "done";

  return (
    <main className="page">
      <header className="page-head">
        <Link href="/" className="brand">
          <LogoMark />
        </Link>
        <h1>Swap ETH → USDG</h1>
      </header>
      <p className="page-sub">
        A manual one-shot conversion for trading funds. The worker picks it up on its next tick, keeps the gas
        reserve, and reports back here. Same permission, same quote and same limits as auto-convert — and a manual
        swap counts as a fire, so auto-convert won&apos;t re-eat the leftover.
      </p>

      {quote && !quote.ok && (
        <div className="card">
          {quote.reason === "no-grant" && (
            <p>
              No grant on file. <Link href="/grant">Sign a grant</Link> first.
            </p>
          )}
          {quote.reason === "wrong-chain" && <p>This swap only runs on the live trading chain.</p>}
        </div>
      )}

      {quote?.ok && grantReady === false && (
        <div className="card warn">
          <p>
            This key was signed before the ETH→USDG permission existed. <Link href="/grant">Re-sign at /grant</Link>,
            then come back — submits until then are cancelled, never silently held.
          </p>
        </div>
      )}

      <div className="card">
        <label className="field">
          <span className="field-label">Amount (ETH)</span>
          <span className="field-input row">
            <input
              inputMode="decimal"
              placeholder="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={!!tracking}
            />
            <button
              type="button"
              className="btn-ghost"
              disabled={surplus === null || surplus <= 0n || !!tracking}
              onClick={() => surplus !== null && setAmount(formatEther(surplus))}
            >
              MAX
            </button>
          </span>
          <span className="field-hint">
            {quote?.ok ? (
              <>
                Balance {formatEther(BigInt(quote.ethWei ?? "0"))} ETH · reserve kept{" "}
                {formatEther(BigInt(quote.reserveWei ?? "0"))} ETH · convertible{" "}
                {formatEther(BigInt(quote.surplusWei ?? "0"))} ETH
              </>
            ) : (
              "Type an amount for a live quote."
            )}
          </span>
        </label>

        {quoteLoading && <p className="muted">Quoting…</p>}

        {quote?.ok && quote.amountWei && BigInt(quote.amountWei) > 0n && quote.quote && (
          <div className="quote">
            <div className="quote-row">
              <span>You get (est.)</span>
              <strong>~{fmtUsdg(quote.quote.expectedOut)} USDG</strong>
            </div>
            <div className="quote-row">
              <span>Minimum after slippage</span>
              <span>{fmtUsdg(quote.quote.minOut)} USDG</span>
            </div>
            <div className="quote-row">
              <span>Pool fee</span>
              <span>{(quote.quote.fee / 10_000).toFixed(2)}%</span>
            </div>
            <div className="quote-row">
              <span>Price source</span>
              <span>
                {quote.quote.source === "twap" ? "15-min average" : "live spot (fresh pool — no average yet)"}
              </span>
            </div>
            {quote.quote.divergenceBps > 500 && (
              <p className="warn-text">
                Heads up: the live price is {((quote.quote.divergenceBps / 100).toFixed(1))}% away from the average —
                the pool may be moving right now. The worker still applies your slippage guard.
              </p>
            )}
            {quote.capped && (
              <p className="warn-text">
                Capped to the convertible surplus — the rest stays as your gas reserve.
              </p>
            )}
          </div>
        )}

        {quote?.ok && quote.amountWei === "0" && wei !== null && wei > 0n && (
          <p className="warn-text">Nothing convertible at this balance — the whole amount is the gas reserve.</p>
        )}

        {submitError && <p className="error">{submitError}</p>}

        <button
          type="button"
          className="btn-primary"
          disabled={
            !!tracking ||
            wei === null ||
            wei <= 0n ||
            !quote?.ok ||
            grantReady !== true ||
            !quote.quote ||
            BigInt(quote.amountWei ?? "0") <= 0n
          }
          onClick={submit}
        >
          {tracking ? "Swap queued — waiting on the worker…" : "Swap"}
        </button>

        {status && status.state !== "done" && trackId && (
          <p className="muted">
            {status.state === "queued"
              ? "Queued — the worker picks it up on its next tick."
              : "Claimed — the worker is executing it."}
          </p>
        )}
        {status?.state === "done" && (
          <p className={status.ok ? "ok-text" : "error"}>{status.line ?? "Finished."}</p>
        )}
      </div>

      {history.length > 0 && (
        <div className="card">
          <h2>Recent conversions</h2>
          <ul className="history">
            {history.map((e, i) => (
              <li key={i} className={e.level}>
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="muted">
        <Link href="/settings">Settings</Link> · <Link href="/grant">Grant</Link>
        {quote?.autoConvertEnabled && " · auto-convert is on — it fires only on new deposits now."}
      </p>
    </main>
  );
}
