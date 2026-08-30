"use client";

/**
 * The Sherwood Console — the sleek all-in-one /app, wired to real data.
 *
 * One surface: the agent home (equity + drawn sparkline + cash/vault/positions),
 * the wall (the on-chain caps as visible chips), the decision tape (landed AND
 * refused trades — the trust signature), positions, and a first-party chat.
 *
 * Data is live from /api/feed (ledger) + /api/grants (grant caps + on-chain
 * balances). The chat answers /status, /positions, /pnl and last-reasoning from
 * the fetched ledger for now; the LLM free-form path + wall-checked orders land
 * next (a real /api/chat).
 */
import { useEffect, useRef, useState, type ReactElement } from "react";
import Link from "next/link";
import type { FeedResponse, TradeRecord } from "@/app/api/feed/route";
import type { AgentStatus } from "@/app/api/grants/route";
import Onboarding, { type OnboardStep } from "./Onboarding";
import { LogoMark } from "@/components/Logo";

const usd = (n: number) =>
  n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const short = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

type ChatMsg = { role: "me" | "them"; html: string };

type Session = { hosted: boolean; address: string | null };

type DiscoveryRow = {
  token: string;
  name: string;
  venue: string;
  priceUsd: number | null;
  reserveUsd: number | null;
  fdvUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  buyers24h: number | null;
  ageDays: number | null;
  graduated: boolean;
  onCurve: boolean;
};
type FreshRow = {
  token: string;
  curve: string;
  trades: number;
  traders: number;
  description: string;
  twitter: string;
  telegram: string;
  website: string;
  bare: boolean;
};
type DiscoveriesPayload = {
  fetchedAt: number;
  scanned: number;
  rows: DiscoveryRow[];
  graduated: number;
  fresh: FreshRow[];
};

export default function Console() {
  const [feed, setFeed] = useState<FeedResponse | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Sticky "the fund step is done" — set when the account first shows gas, or
  // when the owner explicitly skips it. Keeps the soft step from re-nagging on a
  // momentary balance blip. The hard steps (connect, create) never read this.
  const [onboarded, setOnboarded] = useState(false);

  useEffect(() => {
    try {
      setOnboarded(localStorage.getItem("mm_onboarded") === "1");
    } catch {
      /* private mode — the real-state gating still works without the flag */
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const pull = async () => {
      try {
        const [f, s, se] = await Promise.all([
          fetch("/api/feed", { cache: "no-store" }).then((r) => r.json() as Promise<FeedResponse>),
          fetch("/api/grants", { cache: "no-store" }).then((r) => r.json() as Promise<AgentStatus>),
          fetch("/api/auth/session", { cache: "no-store" }).then((r) => r.json() as Promise<Session>),
        ]);
        if (!alive) return;
        setFeed(f);
        setStatus(s);
        setSession(se);
      } catch {
        /* transient — keep the last good numbers */
      } finally {
        if (alive) setLoaded(true);
      }
    };
    pull();
    const id = setInterval(pull, 10_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const markOnboarded = () => {
    try {
      localStorage.setItem("mm_onboarded", "1");
    } catch {
      /* best effort */
    }
    setOnboarded(true);
  };

  // Once the account actually holds gas, remember it — so reaching camp is
  // one-way and a later read blip can't drag them back to the fund step.
  useEffect(() => {
    if (loaded && !onboarded && hasGas(status?.balances?.ethWei)) markOnboarded();
  }, [loaded, onboarded, status]);

  if (!loaded) {
    return (
      <div className="sc-root">
        <div className="loading">reading the ledger…</div>
      </div>
    );
  }

  const hosted = !!session?.hosted;
  const address = session?.address ?? null;
  const connected = !hosted || !!address; // self-hosted's perimeter is localhost
  const exists = !!status?.exists;
  const funded = hasGas(status?.balances?.ethWei);
  const chainId = status?.grant?.chainId ?? 46630;

  // The guided first run — ONE step on screen, derived from real state. Connect
  // and create are hard gates; fund is soft (skippable and remembered). When
  // there's no incomplete step, the console loads.
  const step: OnboardStep | null = !connected
    ? "connect"
    : !exists
      ? "create"
      : !funded && !onboarded
        ? "fund"
        : null;

  if (step) {
    return (
      <Onboarding
        hosted={hosted}
        address={address}
        step={step}
        smartAccount={status?.grant?.smartAccount ?? null}
        testnet={chainId === 46630}
        onSkipFund={markOnboarded}
      />
    );
  }

  return <Loaded feed={feed} status={status!} />;
}

/** True when the agent's smart account holds any gas — the thing that actually
 *  gates trading. ethWei is a wei string; unreadable or zero reads as unfunded. */
function hasGas(wei?: string): boolean {
  if (!wei) return false;
  try {
    return BigInt(wei) > 0n;
  } catch {
    return Number(wei) > 0;
  }
}

function Loaded({ feed, status }: { feed: FeedResponse | null; status: AgentStatus }) {
  // One focus at a time. The rail used to be dead links over a wall of panels;
  // now it switches the main view — Home (the overview), Chat, or Positions — so
  // the console is calm and scannable instead of everything at once.
  const [view, setView] = useState<"home" | "chat" | "positions" | "sherwood">("home");
  // Fetched from /api/discoveries, which reads the index server-side rather
  // than the ledger — see that route for why a DB-backed panel would render
  // empty on the hosted deploy.
  const [disc, setDisc] = useState<DiscoveriesPayload | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/discoveries")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive) setDisc(d); })
        .catch(() => {});
    load();
    // Slower than the feed: the upstream API is keyless and rate-limited, and
    // a coin trending this minute is still trending in two.
    const t = setInterval(load, 120_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const grant = status.grant;
  const caps = grant?.caps;
  const chainId = grant?.chainId ?? null;
  const testnet = chainId === 46630;
  const mode = status.mode ?? "idle";

  // ── derive the numbers ──
  const equityPts = feed?.equity ?? [];
  const lastEq = equityPts.length ? equityPts[equityPts.length - 1] : null;
  // Prefer the ledger's last equity snapshot for the cash/vault split (it's the
  // valuation the agent acted on and needs no live RPC); fall back to the
  // on-chain balances read when there's no ledger yet.
  const balCash = lastEq ? lastEq.cash_usdg : status.balances ? Number(status.balances.cashUsdg) / 1e6 : 0;
  const balVault = lastEq ? lastEq.vault_usdg : status.balances ? Number(status.balances.vaultUsdg) / 1e6 : 0;
  const posSum = (feed?.positions ?? []).reduce((s, p) => s + (p.value_usdg || 0), 0);
  const eqNow = equityPts.length ? equityPts[equityPts.length - 1].equity_usdg : balCash + balVault + posSum;

  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const firstToday = equityPts.find((p) => new Date(String(p.at).replace(" ", "T") + "Z") >= midnight);
  const todayDelta = firstToday ? eqNow - firstToday.equity_usdg : null;

  const contributed = feed?.netContributionsUsdg ?? null;
  const gas = feed?.gasUsdg ?? 0;
  const allTime = contributed !== null && contributed > 0 ? ((eqNow - contributed - gas) / contributed) * 100 : null;

  const split = { cash: balCash, vault: balVault, positions: posSum };
  const total = Math.max(1, split.cash + split.vault + split.positions);

  const daysLeft = grant ? Math.max(0, Math.floor((grant.expiresAt - Date.now() / 1000) / 86400)) : null;
  const refusedToday = (feed?.trades ?? []).filter(
    (t) => t.status === "rejected" && new Date(String(t.created_at).replace(" ", "T") + "Z") >= midnight,
  ).length;

  const agentName = feed?.agent?.name || "your merryman";
  const strategy = feed?.agent?.strategy || grant?.grantFeatures?.[0] || "steady-basket";

  return (
    <div className="sc-root">
      <Embers />
      <div className="app">
        {/* rail */}
        <aside className="rail">
          <div className="brand">
            <span className="mark"><LogoMark size={18} /></span>
            <span>
              <b>merrymen</b>
              <br />
              <span className="dev">/app</span>
            </span>
          </div>
          <nav className="nav">
            <button type="button" className={`navlink ${view === "home" ? "on" : ""}`} onClick={() => setView("home")}>
              <Ic d="home" /> Home
            </button>
            <button type="button" className={`navlink ${view === "chat" ? "on" : ""}`} onClick={() => setView("chat")}>
              <Ic d="chat" /> Chat
            </button>
            <button type="button" className={`navlink ${view === "positions" ? "on" : ""}`} onClick={() => setView("positions")}>
              <Ic d="chart" /> Positions <span className="tally">{feed?.positions?.length ?? 0}</span>
            </button>
            <button type="button" className={`navlink ${view === "sherwood" ? "on" : ""}`} onClick={() => setView("sherwood")}>
              <Ic d="spark" /> Sherwood {disc && <span className="tally">{disc.rows.length}</span>}
            </button>
            <Link className="navlink" href="/grant">
              <Ic d="wallet" /> Wallet
            </Link>
            <Link className="navlink" href="/settings">
              <Ic d="gear" /> Settings
            </Link>
          </nav>
          <div className="rail-foot">
            <div className="wallet">
              <span className="av" />
              <span className="who">
                <span className="addr">{short(grant?.owner)}</span>
                <br />
                <span className="net">owner key · on this device</span>
              </span>
              <span className="disc" title="connected" />
            </div>
          </div>
        </aside>

        {/* main */}
        <main className="main">
          <div className="topbar">
            <div className="agentchip">
              <span className="glyph"><LogoMark size={19} /></span>
              <span>
                <span className="nm">{agentName}</span>
                <br />
                <span className="sub">
                  <b>{strategy}</b>
                  {daysLeft !== null && (
                    <>
                      {" "}
                      · session key expires in <b>{daysLeft}d</b>
                    </>
                  )}
                </span>
              </span>
            </div>
            <span className={`live ${mode !== "live" ? "paper" : ""}`} style={{ marginLeft: 18 }}>
              <span className="beat" /> {mode === "live" ? "LIVE" : mode === "paper" ? "PAPER" : "IDLE"}
            </span>
            <span className={`chainpill ${testnet ? "" : "mainnet"}`}>
              <span className="d" /> Robinhood · {testnet ? "testnet 46630" : `mainnet ${chainId ?? ""}`}
            </span>
          </div>

          {/* ── HOME: the overview — equity, the split, the wall, recent tape ── */}
          {view === "home" && (
            <>
              <section className="hero">
                <div className="equity">
                  <div className="kick">Total equity</div>
                  <div className="big">
                    <span className="num">{usd(eqNow)}</span>
                    <span className="unit">USDG</span>
                  </div>
                  <div className="row2">
                    {todayDelta !== null ? (
                      <span className={`delta ${todayDelta >= 0 ? "up" : "down"}`}>
                        {todayDelta >= 0 ? "▲ +" : "▼ "}
                        {usd(Math.abs(todayDelta))} today
                      </span>
                    ) : (
                      <span className="delta up" style={{ color: "var(--faint)" }}>
                        — building today
                      </span>
                    )}
                    <span className="sep">·</span>
                    <span className="putin">
                      {contributed !== null ? (
                        <>
                          you put in <b>{usd(contributed)}</b>
                          {allTime !== null && (
                            <>
                              {" · "}
                              <span className={`g ${allTime < 0 ? "down" : ""}`}>
                                {allTime >= 0 ? "+" : ""}
                                {allTime.toFixed(1)}%
                              </span>{" "}
                              all-time, net of gas
                            </>
                          )}
                        </>
                      ) : (
                        "no deposit on record yet"
                      )}
                    </span>
                  </div>
                </div>
                <div className="spark">
                  <Spark points={equityPts.map((p) => p.equity_usdg)} />
                </div>
              </section>

              <section className="split">
                <Tile label="Cash" v={split.cash} pct={(split.cash / total) * 100} color="var(--mint)" />
                <Tile label="Vault" v={split.vault} pct={(split.vault / total) * 100} color="var(--gold)" />
                <Tile label="Positions" v={split.positions} pct={(split.positions / total) * 100} color="var(--lime)" />
              </section>

              <section className="wall">
                <div className="wall-head">
                  <span className="kick">The wall</span>
                  <span className="by">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M12 2l8 4v6c0 5-3.4 8.4-8 10-4.6-1.6-8-5-8-10V6z" />
                    </svg>
                    enforced by the chain, not by us
                  </span>
                </div>
                <div className="caps">
                  <Cap l="Per trade" v={caps ? `${usd(caps.perTradeUsdg)}` : "—"} u="USDG" />
                  <Cap l="Per day" v={caps ? `${usd(caps.dailyUsdg)}` : "—"} u="USDG" />
                  <Cap l="Key dies in" v={daysLeft !== null ? `${daysLeft}` : "—"} u="days" />
                  <Cap l="Breaker" v={caps ? `${caps.maxDrawdownPct}%` : "—"} u="drawdown" />
                  <Cap l="Move out" v="blocked" u="· no-transfer" />
                </div>
              </section>

              <section className="floor one">
                <div className="col">
                  <div className="panel">
                    <div className="panel-h">
                      <h3>The decision tape</h3>
                      <span className="kick">refused shown too</span>
                    </div>
                    <div className="tape">
                      {(feed?.trades ?? []).length === 0 ? (
                        <div className="empty-note">No trades yet — the band hasn&apos;t ridden.</div>
                      ) : (
                        (feed?.trades ?? []).slice(0, 6).map((t, i) => <TradeRow key={i} t={t} />)
                      )}
                    </div>
                    {refusedToday > 0 && (
                      <div className="tape-foot">
                        A trade the wall turns back is part of the record — <b>{refusedToday} refused today</b>, not hidden.
                      </div>
                    )}
                  </div>
                </div>
              </section>
            </>
          )}

          {/* ── POSITIONS: just the book ── */}
          {view === "positions" && (
            <section className="floor one">
              <div className="col">
                <div className="panel">
                  <div className="panel-h">
                    <h3>Positions</h3>
                    <span className="kick">{feed?.positions?.length ?? 0} open</span>
                  </div>
                  <div className="pos">
                    {(feed?.positions ?? []).length === 0 ? (
                      <div className="empty-note">All in cash and the vault.</div>
                    ) : (
                      (feed?.positions ?? []).map((p, i) => (
                        <div className="prow" key={i}>
                          <span className="s">
                            <span
                              className="tk"
                              style={{ background: p.price_source === "chainlink" ? "var(--mint)" : "var(--lime)" }}
                            />{" "}
                            {p.symbol}
                          </span>
                          <span className="px">
                            ${usd(p.price_usd)}
                            {p.price_source !== "chainlink" && <span className="tagpx">{p.price_source === "curve" ? "curve px" : p.price_source === "broker" ? "broker px" : "pool px"}</span>}
                          </span>
                          <span className="val">{usd(p.value_usdg)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ── SHERWOOD: what is trading, from a third-party index ── */}
          {view === "sherwood" && (
            <section className="floor one">
              <div className="col">
                {/* Launched minutes ago, and someone is trading it. The gate is
                    25 trades from 3 distinct addresses, which keeps about an
                    eighth of a launchpad running at ~940/hour. */}
                <div className="panel">
                  <div className="panel-h">
                    <h3>Just launched</h3>
                    <span className="kick">
                      {disc ? `${disc.fresh.length} with a tape · last 15 min` : "looking…"}
                    </span>
                  </div>
                  <div className="pos">
                    {!disc ? (
                      <div className="empty-note">Reading the launchpad…</div>
                    ) : disc.fresh.length === 0 ? (
                      <div className="empty-note">Nothing launched in the last few minutes has anyone trading it.</div>
                    ) : (
                      disc.fresh.map((f: FreshRow) => (
                        <div className="prow" key={f.token}>
                          <span className="s">
                            <span className="tk" style={{ background: f.bare ? "var(--mint)" : "var(--lime)" }} />{" "}
                            {f.description || <span style={{ opacity: 0.5 }}>published nothing</span>}
                          </span>
                          <span className="px">
                            {f.twitter && (
                              <a href={f.twitter} target="_blank" rel="noreferrer noopener" className="tagpx">
                                x
                              </a>
                            )}
                            {f.website && (
                              <a href={f.website} target="_blank" rel="noreferrer noopener" className="tagpx">
                                web
                              </a>
                            )}
                            {f.telegram && <span className="tagpx">tg</span>}
                          </span>
                          {/* Distinct ADDRESSES, not trade count: 291 trades from
                              25 addresses is a different thing from 223 from 176. */}
                          <span className="val">
                            {f.traders} <span style={{ opacity: 0.55 }}>/ {f.trades}</span>
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="empty-note" style={{ opacity: 0.7 }}>
                    traders / trades over the last 15 minutes. Every word above was written by
                    whoever launched the coin.
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-h">
                    <h3>Trading now</h3>
                    <span className="kick">
                      {disc ? `${disc.rows.length} of ${disc.scanned} · ${disc.graduated} graduated` : "looking…"}
                    </span>
                  </div>
                  <div className="pos">
                    {!disc ? (
                      <div className="empty-note">Reading the tape…</div>
                    ) : disc.rows.length === 0 ? (
                      <div className="empty-note">Nothing clearing the floor right now.</div>
                    ) : (
                      disc.rows.map((r: DiscoveryRow) => (
                        <div className="prow" key={r.token}>
                          <span className="s">
                            <span
                              className="tk"
                              style={{ background: r.graduated ? "var(--lime)" : "var(--mint)" }}
                            />{" "}
                            {r.name}
                            {r.graduated && <span className="tagpx">graduated</span>}
                            {r.onCurve && <span className="tagpx">on its curve</span>}
                          </span>
                          <span className="px">
                            {/* A coin still on its bonding curve reports a
                                reserve that is mostly the VIRTUAL SEED — about
                                $4,100 it does not hold — so its depth is not
                                shown as though it were money. */}
                            {r.onCurve
                              ? "pre-graduation"
                              : r.reserveUsd === null
                                ? "depth unknown"
                                : `${Math.round(r.reserveUsd).toLocaleString()} deep`}
                          </span>
                          <span
                            className="val"
                            style={{
                              color:
                                r.change24hPct === null
                                  ? undefined
                                  : r.change24hPct >= 0
                                    ? "var(--lime)"
                                    : "var(--rose, #e57)",
                            }}
                          >
                            {r.change24hPct === null
                              ? "—"
                              : `${r.change24hPct > 0 ? "+" : ""}${r.change24hPct.toFixed(1)}%`}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="empty-note" style={{ opacity: 0.7 }}>
                    A third party&rsquo;s reading of the market, not mine — nothing here has been
                    checked against the chain. I can&rsquo;t trade any of it until you add the token
                    in <Link href="/settings">settings</Link> and re-sign at <Link href="/grant">grant</Link>.
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* ── CHAT: the agent, full width ── */}
          {view === "chat" && (
            <section className="floor one chatview">
              <div className="col">
                <Chat
                  agentName={agentName}
                  strategy={strategy}
                  ledger={{ eqNow, todayDelta, allTime, positions: feed?.positions ?? [], refusedToday, events: feed?.events ?? [], daysLeft }}
                />
              </div>
            </section>
          )}
        </main>
      </div>

      {/* mobile tabs */}
      <nav className="tabbar">
        <button type="button" className={`navlink ${view === "home" ? "on" : ""}`} onClick={() => setView("home")}>
          <Ic d="home" /> Home
        </button>
        <button type="button" className={`navlink ${view === "chat" ? "on" : ""}`} onClick={() => setView("chat")}>
          <Ic d="chat" /> Chat
        </button>
        <button type="button" className={`navlink ${view === "positions" ? "on" : ""}`} onClick={() => setView("positions")}>
          <Ic d="chart" /> Positions
        </button>
        <button type="button" className={`navlink ${view === "sherwood" ? "on" : ""}`} onClick={() => setView("sherwood")}>
          <Ic d="spark" /> Sherwood
        </button>
        <Link className="navlink" href="/settings">
          <Ic d="gear" /> Settings
        </Link>
      </nav>
    </div>
  );
}

function TradeRow({ t }: { t: TradeRecord }) {
  const rejected = t.status === "rejected" || t.status === "reverted";
  const isVault = t.kind.includes("vault");
  const cls = rejected ? "no" : isVault ? "vault" : "ok";
  const ic = rejected ? "✕" : isVault ? "⛬" : "↑";
  const kindLabel: Record<string, string> = {
    swap: "traded",
    "vault-deposit": "parked in the vault",
    "vault-withdraw": "pulled from the vault",
    transfer: "moved USDG",
    "equity-order": "traded",
  };
  const label = kindLabel[t.kind] ?? t.kind;
  return (
    <div className={`trade ${cls}`}>
      <span className="ic">{ic}</span>
      <span>
        <span className="sym">{t.buy_token ? symbolish(t) : t.kind.toUpperCase()}</span>{" "}
        <span className="desc">
          {rejected ? (
            <>
              refused — <span className="rule">{t.reject_rule || "wall"}</span>
            </>
          ) : (
            label
          )}
        </span>
      </span>
      <span className="amt">
        {rejected ? "—" : usd(t.amount_usdg)}
        <br />
        <span className="t">{timeAgo(t.created_at)}</span>
      </span>
    </div>
  );
}

// The ledger stores token addresses, not symbols, on trades; until the symbol
// join lands we label by the humanized kind. Kept as a seam.
function symbolish(t: TradeRecord): string {
  return t.kind === "vault-deposit" || t.kind === "vault-withdraw" ? "VAULT" : "TRADE";
}

function timeAgo(s: string): string {
  const then = new Date(String(s).replace(" ", "T") + "Z").getTime();
  if (Number.isNaN(then)) return "";
  const m = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Tile({ label, v, pct, color }: { label: string; v: number; pct: number; color: string }) {
  return (
    <div className="tile">
      <div className="l">
        <span className="lab">{label}</span>
      </div>
      <div className="v">{usd(v)}</div>
      <div className="bar">
        <i style={{ width: `${Math.min(100, Math.max(2, pct))}%`, background: color }} />
      </div>
    </div>
  );
}

function Cap({ l, v, u }: { l: string; v: string; u: string }) {
  return (
    <div className="cap">
      <span className="cl">{l}</span>
      <span className="cv">
        {v} <small>{u}</small>
      </span>
    </div>
  );
}

// ── chat (real-data-aware; LLM free-form lands next) ──
type Ledger = {
  eqNow: number;
  todayDelta: number | null;
  allTime: number | null;
  positions: FeedResponse["positions"];
  refusedToday: number;
  events: FeedResponse["events"];
  daysLeft: number | null;
};

function Chat({ agentName, strategy, ledger }: { agentName: string; strategy: string; ledger: Ledger }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    {
      role: "them",
      html: `I'm ${escapeHtml(agentName)}. Ask me anything about your book — or for a quick <span class="mono">/status</span>, <span class="mono">/positions</span>, <span class="mono">/pnl</span>. Orders still go through the wall on the Wallet screen.`,
    },
  ]);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs]);

  // The tenant's own ledger, as a compact context the model narrates from. Built
  // client-side (the console has the feed) and sent to /api/chat, which supplies
  // only the LLM — so it works in hosted mode where the server can't read the
  // ledger. The model can never act on this; it returns text only.
  const buildState = () => {
    const posLine = ledger.positions.length
      ? ledger.positions
          .slice(0, 8)
          .map((p) => `${p.symbol} ${usd(p.value_usdg)} USDG @ $${usd(p.price_usd)}${p.price_source === "chainlink" ? "" : ` (${p.price_source} px)`}`)
          .join("; ")
      : "all in cash and the vault";
    const last = ledger.events.find((e) => e.level === "ok")?.message || ledger.events[0]?.message || "";
    return [
      `YOU ARE: ${agentName}, a merryman running the ${strategy} strategy on Robinhood Chain.`,
      `EQUITY: ${usd(ledger.eqNow)} USDG${ledger.todayDelta !== null ? `, ${ledger.todayDelta >= 0 ? "+" : ""}${usd(ledger.todayDelta)} today` : ""}${ledger.allTime !== null ? `, ${ledger.allTime >= 0 ? "+" : ""}${ledger.allTime.toFixed(1)}% all-time net of gas` : ""}.`,
      `POSITIONS: ${posLine}.`,
      `TODAY: ${ledger.refusedToday} trade(s) refused by the wall.${ledger.daysLeft !== null ? ` Session key expires in ${ledger.daysLeft} days.` : ""}`,
      last ? `RECENT FROM CAMP: ${last.slice(0, 240)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  };

  const answer = (raw: string): string => {
    const q = raw.trim().toLowerCase();
    if (q.startsWith("/status") || q === "status") {
      const d =
        ledger.todayDelta !== null
          ? `${ledger.todayDelta >= 0 ? "▲ +" : "▼ "}${usd(Math.abs(ledger.todayDelta))} today`
          : "steady today";
      const at = ledger.allTime !== null ? `, ${ledger.allTime >= 0 ? "+" : ""}${ledger.allTime.toFixed(1)}% all-time` : "";
      return `Equity <span class="mono">${usd(ledger.eqNow)} USDG</span>, ${d}${at}. ${ledger.positions.length} open position${ledger.positions.length === 1 ? "" : "s"}, ${ledger.refusedToday} refused today${ledger.daysLeft !== null ? `, key dies in ${ledger.daysLeft} days` : ""}.`;
    }
    if (q.startsWith("/positions") || q.includes("position") || q.includes("holding")) {
      if (!ledger.positions.length) return "All in cash and the vault right now — no open positions.";
      return (
        "Open positions:\n" +
        ledger.positions
          .slice(0, 8)
          .map((p) => `• ${escapeHtml(p.symbol)} — <span class="mono">${usd(p.value_usdg)} USDG</span> @ $${usd(p.price_usd)}`)
          .join("\n")
      );
    }
    if (q.startsWith("/pnl") || q.includes("pnl") || q.includes("how much") || q.includes("making")) {
      return ledger.allTime !== null
        ? `Up <span class="mono">${ledger.allTime >= 0 ? "+" : ""}${ledger.allTime.toFixed(1)}%</span> all-time, net of gas — that's equity minus what you put in, not the bankroll dressed up as profit.`
        : "No deposit on record yet, so there's no honest P&L to state — I won't call your own capital a gain.";
    }
    if (q.includes("why") || q.includes("reason") || q.includes("thinking")) {
      const last = ledger.events.find((e) => e.level === "ok")?.message || ledger.events[0]?.message;
      return last
        ? `Last from camp: “${escapeHtml(last.slice(0, 220))}”. The full reasoning behind each trade — joined to the decision that made it — is what the chat gets next.`
        : "Nothing on the wire yet. Once I've taken a shot I'll tell you exactly why.";
    }
    if (q.includes("pause") || q.includes("stop") || q.includes("kill")) {
      return "Giving orders through chat — pause, kill, buy, sell — runs next, each checked against the wall before I move a thing. For now, pause and the kill switch live on the Wallet screen.";
    }
    return `Heard you — but I answered that from a lookup table, not from thinking. Ask me <span class="mono">/status</span>, <span class="mono">/positions</span> or <span class="mono">/pnl</span> for something exact.`;
  };

  /**
   * What to say when the route could not think.
   *
   * The route ALREADY reports why — no-llm, llm-error, not signed in — and the
   * client used to discard it and print a line about free-form reasoning being
   * "the next thing I learn". That reads as an unbuilt feature. It is a missing
   * key: /api/chat calls a real model, but it resolves one only from the WEB
   * service's own environment, and the hosted deploy guide gives the house keys
   * to the orchestrator. A config gap that looks like a product gap is the
   * worst kind, because nobody can see there is something to fix.
   */
  const brainlessNote = (why: string): string => {
    if (why === "no-llm") {
      return "I can think, but I have no brain wired up right now — this deployment has no model key, so I can only answer the exact commands. Whoever runs it needs to set one on the web service.";
    }
    if (why === "llm-error") return "I tried to think and the model call failed. Try again in a moment.";
    if (why === "not signed in") return "Sign in first and I can answer from your own book.";
    return `I couldn't answer that one (${why}).`;
  };

  const submit = async (text?: string) => {
    const v = (text ?? val).trim();
    if (!v || busy) return;
    setVal("");
    setBusy(true);
    const history = msgs.map((m) => ({ role: m.role === "me" ? "user" : "assistant", content: stripTags(m.html) }));
    setMsgs((m) => [
      ...m,
      { role: "me", html: escapeHtml(v) },
      { role: "them", html: '<span style="color:var(--faint);font-family:var(--mono)">…</span>' },
    ]);
    let replyHtml: string | null = null;
    try {
      const r = (await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: v, state: buildState(), history }),
      }).then((res) => res.json())) as { reply?: string | null; why?: string };
      if (r && typeof r.reply === "string" && r.reply.trim()) replyHtml = escapeHtml(r.reply.trim());
      // SAY WHY IT DID NOT ANSWER. The route already reports `why` -- no-llm,
      // llm-error, not signed in -- and this used to throw it away and fall
      // through to a canned line about free-form reasoning being "the next
      // thing I learn". It reads as a missing FEATURE. It is a missing KEY, and
      // the difference is a config change nobody could see they had to make.
      else if (r?.why) replyHtml = escapeHtml(brainlessNote(r.why));
    } catch {
      /* fall through to the deterministic answer */
    }
    const finalHtml = replyHtml ?? answer(v);
    // Replace the "…" placeholder with the real reply.
    setMsgs((m) => [...m.slice(0, -1), { role: "them", html: finalHtml }]);
    setBusy(false);
  };

  return (
    <div className="panel chat">
      <div className="panel-h">
        <h3>Talk to {escapeHtml(agentName).split(" ")[0]}</h3>
        <span className="live" style={{ marginLeft: "auto" }}>
          <span className="beat" /> here now
        </span>
      </div>
      <div className="chat-stream" ref={streamRef}>
        {msgs.map((m, i) => (
          <div className={`msg ${m.role}`} key={i}>
            <span className="who">{m.role === "me" ? "you" : agentName}</span>
            <div className="bubble" dangerouslySetInnerHTML={{ __html: m.html }} />
          </div>
        ))}
      </div>
      <div className="chips">
        {["/status", "/positions", "/pnl", "why?"].map((c) => (
          <span className="chip" key={c} onClick={() => submit(c)}>
            {c}
          </span>
        ))}
      </div>
      <div className="chat-in">
        <input
          value={val}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={busy ? "Will is thinking…" : `Ask ${agentName.split(" ")[0]} anything…`}
          autoComplete="off"
        />
        <button className="send" onClick={() => submit()} aria-label="Send" disabled={!val.trim() || busy}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M22 2L11 13" />
            <path d="M22 2l-7 20-4-9-9-4z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c);
}

/** Plain text of a rendered bubble, for sending prior turns back as chat history. */
function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

// ── decorative canvas ──
function Spark({ points }: { points: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const pts = points.length >= 2 ? points : [0, 0];
    let raf = 0;
    const draw = (prog: number) => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth,
        h = cv.clientHeight;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const pad = 6,
        n = pts.length;
      const min = Math.min(...pts),
        max = Math.max(...pts);
      const range = max - min || 1;
      const X = (i: number) => pad + (i / (n - 1)) * (w - 2 * pad);
      const Y = (v: number) => pad + (1 - (v - min) / range) * (h - 2 * pad - 12) + 4;
      const last = Math.max(1, Math.floor(prog * (n - 1)));
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, "rgba(58,216,132,0.20)");
      g.addColorStop(1, "rgba(58,216,132,0)");
      ctx.beginPath();
      ctx.moveTo(X(0), h - pad);
      for (let i = 0; i <= last; i++) ctx.lineTo(X(i), Y(pts[i]));
      ctx.lineTo(X(last), h - pad);
      ctx.closePath();
      ctx.fillStyle = g;
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i <= last; i++) {
        const x = X(i),
          y = Y(pts[i]);
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
      ctx.strokeStyle = "#3ad884";
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      const ex = X(last),
        ey = Y(pts[last]);
      ctx.beginPath();
      ctx.arc(ex, ey, 3.2, 0, 7);
      ctx.fillStyle = "#b6e226";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex, ey, 7, 0, 7);
      ctx.strokeStyle = "rgba(182,226,38,0.35)";
      ctx.lineWidth = 1.4;
      ctx.stroke();
    };
    if (reduce) draw(1);
    else {
      const t0 = performance.now(),
        dur = 1100;
      const loop = (t: number) => {
        const k = Math.min(1, (t - t0) / dur);
        draw(k);
        if (k < 1) raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }
    const onR = () => draw(1);
    window.addEventListener("resize", onR);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onR);
    };
  }, [points]);
  return <canvas ref={ref} />;
}

function Embers() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let W = 0,
      H = 0,
      dpr = 1,
      raf = 0;
    const size = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = cv.width = innerWidth * dpr;
      H = cv.height = innerHeight * dpr;
      cv.style.width = innerWidth + "px";
      cv.style.height = innerHeight + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    size();
    window.addEventListener("resize", size);
    const N = Math.min(30, Math.floor(innerWidth / 44));
    const em = Array.from({ length: N }, () => ({
      x: Math.random() * innerWidth,
      y: Math.random() * innerHeight,
      r: Math.random() * 1.4 + 0.4,
      s: Math.random() * 0.25 + 0.05,
      d: Math.random() * 0.4 - 0.2,
      a: Math.random() * 0.5 + 0.2,
      p: Math.random() * 6,
    }));
    const tick = (t: number) => {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const e of em) {
        e.y -= e.s;
        e.x += e.d + Math.sin(t / 2600 + e.p) * 0.12;
        if (e.y < -6) {
          e.y = innerHeight + 6;
          e.x = Math.random() * innerWidth;
        }
        const fl = e.a * (0.6 + 0.4 * Math.sin(t / 700 + e.p));
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, 7);
        ctx.fillStyle = `rgba(182,226,38,${fl * 0.5})`;
        ctx.shadowColor = "rgba(182,226,38,0.5)";
        ctx.shadowBlur = 6;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
    };
  }, []);
  return <canvas id="sc-embers" ref={ref} aria-hidden="true" />;
}

function Ic({ d }: { d: string }) {
  const paths: Record<string, ReactElement> = {
    home: (
      <>
        <path d="M3 12l9-8 9 8" />
        <path d="M5 10v10h14V10" />
      </>
    ),
    spark: (
      <>
        <path d="M12 3v4" />
        <path d="M12 17v4" />
        <path d="M5 12H3" />
        <path d="M21 12h-2" />
        <path d="M7 7l3 3" />
        <path d="M14 14l3 3" />
      </>
    ),
    chat: <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
    chart: (
      <>
        <path d="M3 3v18h18" />
        <path d="M7 14l4-4 3 3 5-6" />
      </>
    ),
    wallet: (
      <>
        <rect x="3" y="6" width="18" height="13" rx="2" />
        <path d="M16 12h.01M3 10h18" />
      </>
    ),
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8 2 2 0 1 1-2.8 2.8 1.6 1.6 0 0 0-2.7 1.1 2 2 0 1 1-4 0 1.6 1.6 0 0 0-2.6-1.1 2 2 0 1 1-2.8-2.8A1.6 1.6 0 0 0 5 13.9a2 2 0 1 1 0-4 1.6 1.6 0 0 0 1.1-2.7 2 2 0 1 1 2.8-2.8A1.6 1.6 0 0 0 11 4.9a2 2 0 1 1 4 0 1.6 1.6 0 0 0 2.7 1.1 2 2 0 1 1 2.8 2.8A1.6 1.6 0 0 0 22 12z" />
      </>
    ),
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      {paths[d]}
    </svg>
  );
}
