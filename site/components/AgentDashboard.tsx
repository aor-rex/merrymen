"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EXPLORER,
  fetchGas,
  fetchHoldings,
  formatAmount,
  formatUsd,
  isAddress,
  isDeployed,
  type Portfolio,
} from "@/lib/chain";

/**
 * What a merryman is holding, read from the chain in the visitor's own browser.
 *
 * WHY THIS ISN'T "LOG IN AND SEE YOUR AGENT". There is no hosted merrymen API —
 * the dashboard that ships with the software is single-tenant, unauthenticated
 * and bound to your own machine, and putting a copy of it on the internet is
 * exactly the change this project keeps refusing to make. So the public version
 * reads the only source that is genuinely public: the chain. No account, no
 * server of ours, nothing to trust. Paste an address and every number here can
 * be checked against the explorer link next to it.
 *
 * The cost of that choice, stated plainly rather than hidden: this shows what
 * the account HOLDS, not what your agent DECIDED. Rejections, the reasoning
 * behind a trade and the caps themselves live off-chain in your own install, and
 * no amount of chain-reading recovers them. The local dashboard remains the
 * place to see those.
 */

/** A pasted address is remembered so a refresh doesn't mean typing it again. */
const STORE_KEY = "merrymen.watch.address";

/**
 * Rendering thousands of rows would lock the page, and an agent account holds a
 * handful of tokens. The tail is airdrop spam — shown as a count, not hidden.
 */
const MAX_ROWS = 40;

type State = "idle" | "loading" | "ready" | "error";

interface Snapshot {
  portfolio: Portfolio;
  gasWei: bigint;
  deployed: boolean;
  at: number;
}

export function AgentDashboard() {
  const [address, setAddress] = useState("");
  const [showing, setShowing] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [state, setState] = useState<State>("idle");
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && isAddress(saved)) setAddress(saved);
    } catch {
      /* private mode — not worth telling anyone about */
    }
  }, []);

  const load = useCallback(async (addr: string) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setState("loading");
    setError(null);
    try {
      // Three independent reads. Promise.all so a slow one doesn't serialise
      // behind the others, and so a failure names itself rather than leaving a
      // half-drawn page.
      const [portfolio, gasWei, deployed] = await Promise.all([
        fetchHoldings(addr, ac.signal),
        fetchGas(addr, ac.signal),
        isDeployed(addr, ac.signal),
      ]);
      if (ac.signal.aborted) return;
      setSnap({ portfolio, gasWei, deployed, at: Date.now() });
      setState("ready");
    } catch (e) {
      if (ac.signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setError(
        msg.includes("timed out") || msg.includes("abort")
          ? "The explorer didn't answer in time. That happens on accounts holding thousands of airdropped tokens — try again, or check it on the explorer directly."
          : `Couldn't read the chain — ${msg}`,
      );
      setState("error");
    }
  }, []);

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const addr = address.trim();
      if (!isAddress(addr)) {
        setError("That isn't a valid address — it should be 0x followed by 40 hex characters.");
        setState("error");
        return;
      }
      try {
        localStorage.setItem(STORE_KEY, addr);
      } catch {
        /* ignore */
      }
      setShowing(addr);
      void load(addr);
    },
    [address, load],
  );

  useEffect(() => () => abort.current?.abort(), []);

  const p = snap?.portfolio;
  const rows = p?.holdings.slice(0, MAX_ROWS) ?? [];
  const hidden = Math.max(0, (p?.holdings.length ?? 0) - rows.length);
  const gasEth = snap ? Number(snap.gasWei) / 1e18 : 0;

  return (
    <div className="dash">
      <form className="dash-form" onSubmit={submit}>
        <label className="sr-only" htmlFor="agent-address">
          Smart-account address
        </label>
        <input
          id="agent-address"
          className="beta-input"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            if (state === "error") setState("idle");
          }}
          placeholder="0x… your merryman's smart-account address"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={state === "error"}
        />
        <button className="btn btn-primary has-box" type="submit" disabled={state === "loading"}>
          {state === "loading" ? "Reading…" : "Show me"}
        </button>
      </form>

      {state === "error" && error && (
        <p className="dash-error" role="alert">
          {error}
        </p>
      )}

      {showing && state !== "error" && (
        <p className="dash-sub">
          Reading{" "}
          <a className="link" href={`${EXPLORER}/address/${showing}`} target="_blank" rel="noreferrer">
            {showing.slice(0, 10)}…{showing.slice(-8)}
          </a>{" "}
          straight from Robinhood Chain. Nothing here passes through a server of ours.
        </p>
      )}

      {snap && state === "ready" && (
        <>
          <div className="dash-top">
            <div className="dash-figure">
              <div className="dash-label">holding</div>
              <div className="dash-big">
                {formatUsd(p!.pricedUsd)} <span className="dash-unit">USD</span>
              </div>
              {/* An unpriced token is not a worthless one, and folding it in at
                  zero would report a smaller portfolio than the account has. */}
              {p!.unpricedCount > 0 && (
                <div className="dash-note">
                  plus {p!.unpricedCount} token{p!.unpricedCount === 1 ? "" : "s"} the explorer has no
                  price for — not counted above, not worth nothing
                </div>
              )}
            </div>

            <div className="dash-chips">
              <span className={`dash-chip ${snap.deployed ? "" : "dash-chip-warn"}`}>
                {snap.deployed ? "account deployed" : "not deployed yet"}
              </span>
              <span className={`dash-chip ${gasEth === 0 ? "dash-chip-warn" : ""}`}>
                {gasEth.toFixed(6)} ETH for gas
              </span>
            </div>
          </div>

          {/* Deployment and gas are the two states that look like "broken agent"
              and are actually "hasn't started" and "can't pay". Worth naming. */}
          {!snap.deployed && (
            <p className="dash-hint">
              This address has no contract code yet. For a smart account that means it has never
              executed an operation — normal before the first trade. It also looks identical to an
              ordinary wallet address, so if you expected activity here, check you copied the{" "}
              <strong>smart account</strong> rather than the owner address.
            </p>
          )}
          {snap.deployed && gasEth === 0 && (
            <p className="dash-hint">
              No ETH here. A smart account pays for its own transactions, so it cannot trade — or be
              swept — until someone sends it a little gas.
            </p>
          )}

          <div className="dash-table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>token</th>
                  <th className="num">amount</th>
                  <th className="num">value</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={3} className="dash-empty">
                      No tokens in this account.
                    </td>
                  </tr>
                )}
                {rows.map((h) => (
                  <tr key={h.token}>
                    <td>
                      <a
                        className="link"
                        href={`${EXPLORER}/token/${h.token}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {h.symbol}
                      </a>
                    </td>
                    <td className="num">{formatAmount(h.amount, h.decimals)}</td>
                    <td className="num">{h.usd === null ? <span className="dash-dim">no price</span> : formatUsd(h.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hidden > 0 && (
            <p className="dash-note">
              {hidden} smaller holding{hidden === 1 ? "" : "s"} not shown — almost always airdropped
              spam. All of them are on{" "}
              <a className="link" href={`${EXPLORER}/address/${showing}`} target="_blank" rel="noreferrer">
                the explorer
              </a>
              .
            </p>
          )}

          <p className="dash-note">
            Prices come from the explorer, not from us, and a thin token&apos;s quoted rate can be far
            from what it would actually sell for. This is what the account holds — for what your
            agent <em>decided</em>, including the trades its caps refused, open your own dashboard.
          </p>
        </>
      )}
    </div>
  );
}
