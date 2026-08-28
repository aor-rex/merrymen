"use client";

/**
 * The muster — merrymen's guided first run.
 *
 * The old /app dumped every gate and panel at once. This does the opposite: ONE
 * step on screen at a time, in order, each a single decision — connect, create,
 * fund — and then the console loads and this never shows again (the checklist
 * moves to /settings). Every step's done-state is DERIVED from real state
 * (session, grant, on-chain gas), so it's self-healing: sign out and step 1
 * returns; fund the account and step 3 clears on the next poll. Nothing here is
 * a dismissible lie.
 *
 * Look: near-black blueprint ground, a monospace decode on each title, a
 * hand-drawn wireframe per step, lime used only as the mark — the Sherwood
 * console's world, slowed down to one thing at a time.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { getInjectedProvider, requestAccount } from "@/lib/wallet";

export type OnboardStep = "connect" | "create" | "fund";

const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—");

/** Letters cycle through random glyphs, then settle left-to-right — the hellorobo
 *  "decode". Re-runs whenever `text` changes (key it by step to replay on nav).
 *  Reduced-motion gets the final text with no churn. */
function Decode({ text, className }: { text: string; className?: string }) {
  const [out, setOut] = useState(text);
  useEffect(() => {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOut(text);
      return;
    }
    const glyphs = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789#%&/\\<>*+={}—·";
    let frame = 0;
    const id = window.setInterval(() => {
      frame++;
      const revealed = Math.floor(frame / 2.3);
      setOut(
        text
          .split("")
          .map((ch, i) => (ch === " " ? " " : i < revealed ? ch : glyphs[(Math.random() * glyphs.length) | 0]))
          .join(""),
      );
      if (revealed >= text.length) window.clearInterval(id);
    }, 34);
    return () => window.clearInterval(id);
  }, [text]);
  return <span className={className}>{out}</span>;
}

/** Hand-drawn wireframe art per step — single-stroke, the carabiner idiom. */
function Blueprint({ step }: { step: OnboardStep }) {
  const common = {
    fill: "none" as const,
    stroke: "currentColor" as const,
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (step === "connect") {
    // a wallet card + a signature stroke + an orbiting proof-dot
    return (
      <svg viewBox="0 0 300 300" className="ob-art" aria-hidden="true">
        <g {...common}>
          <rect x="54" y="96" width="192" height="120" rx="12" />
          <path d="M54 132 H246" />
          <rect x="186" y="150" width="40" height="26" rx="5" />
          <circle cx="206" cy="163" r="3.2" />
          <path d="M74 190 q10 -18 20 0 t20 0 t20 -6" className="ob-accent" />
          <circle cx="150" cy="60" r="20" className="ob-accent" />
          <path d="M150 52 v16 M142 60 h16" className="ob-accent" />
        </g>
        <g className="ob-tick">
          <path d="M40 96 h-14 M40 216 h-14" {...common} strokeWidth={1} />
          <text x="18" y="160" className="ob-annot" transform="rotate(-90 18 160)">SIG · 01</text>
        </g>
      </svg>
    );
  }
  if (step === "create") {
    // the archer's longbow, nocked — the mark of the band
    return (
      <svg viewBox="0 0 300 300" className="ob-art" aria-hidden="true">
        <g {...common}>
          <path d="M96 40 C 176 96 176 204 96 260" strokeWidth={1.8} />
          <path d="M96 40 L 208 150 L 96 260" className="ob-string" strokeWidth={1} />
          <path d="M120 150 H 220" className="ob-accent" strokeWidth={1.8} />
          <path d="M212 142 L 228 150 L 212 158" className="ob-accent" />
          <path d="M120 150 l 12 -7 M120 150 l 12 7" className="ob-accent" />
          <circle cx="120" cy="150" r="4" className="ob-accent" />
        </g>
        <g className="ob-tick">
          <path d="M96 274 v14 M208 164 v24" {...common} strokeWidth={1} />
          <text x="150" y="292" textAnchor="middle" className="ob-annot">DRAW · 02</text>
        </g>
      </svg>
    );
  }
  // fund — a strongbox with a coin
  return (
    <svg viewBox="0 0 300 300" className="ob-art" aria-hidden="true">
      <g {...common}>
        <path d="M64 130 h172 v92 a8 8 0 0 1 -8 8 H72 a8 8 0 0 1 -8 -8 z" />
        <path d="M64 130 v-14 a26 26 0 0 1 26 -26 h120 a26 26 0 0 1 26 26 v14" />
        <path d="M64 158 H236" />
        <rect x="138" y="150" width="24" height="20" rx="4" />
        <path d="M150 160 v10" />
        <circle cx="212" cy="86" r="22" className="ob-accent" />
        <path d="M212 76 v20 M204 82 h16 a4 4 0 0 1 0 8 h-16" className="ob-accent" strokeWidth={1} />
      </g>
      <g className="ob-tick">
        <path d="M50 130 h-14 M50 230 h-14" {...common} strokeWidth={1} />
        <text x="18" y="182" className="ob-annot" transform="rotate(-90 18 182)">GAS · 03</text>
      </g>
    </svg>
  );
}

function CopyRow({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ob-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard blocked — the address is still visible to select */
        }
      }}
    >
      <span className="ob-copy-v">{value}</span>
      <span className="ob-copy-i">{copied ? "copied ✓" : "copy"}</span>
    </button>
  );
}

export default function Onboarding(props: {
  hosted: boolean;
  address: string | null;
  step: OnboardStep;
  smartAccount?: string | null;
  testnet: boolean;
  onSkipFund: () => void;
}) {
  const { hosted, step, smartAccount, testnet, onSkipFund } = props;

  // The visible rail: connect only exists as a step in hosted mode (self-hosted's
  // perimeter is localhost, so it's signed in by construction).
  const order: OnboardStep[] = hosted ? ["connect", "create", "fund"] : ["create", "fund"];
  const activeIdx = order.indexOf(step);

  return (
    <div className="sc-root">
      <div className="ob" data-step={step}>
        <div className="ob-grid" aria-hidden="true" />

        <header className="ob-top">
          <span className="ob-brand">
            <span className="ob-mark">🏹</span> merrymen
          </span>
          <span className="ob-crumb">
            SETUP · {String(activeIdx + 1).padStart(2, "0")}_{String(order.length).padStart(2, "0")}
          </span>
        </header>

        {/* progress rail */}
        <nav className="ob-rail" aria-label="Setup progress">
          {order.map((s, i) => {
            const state = i < activeIdx ? "done" : i === activeIdx ? "on" : "todo";
            return (
              <span key={s} className={`ob-node ${state}`}>
                <span className="ob-dot">{state === "done" ? "✓" : String(i + 1).padStart(2, "0")}</span>
                <span className="ob-label">{LABELS[s]}</span>
              </span>
            );
          })}
          <span className={`ob-node ${activeIdx >= order.length - 1 ? "on" : "todo"} ob-camp`}>
            <span className="ob-dot">→</span>
            <span className="ob-label">Camp</span>
          </span>
        </nav>

        {/* the one thing on screen */}
        <main className="ob-scene" key={step}>
          <div className="ob-copyz">
            <span className="ob-kick">{KICK[step]}</span>
            <h1 className="ob-title">
              <Decode key={step} text={TITLE[step]} />
            </h1>
            {step === "connect" && <ConnectStep />}
            {step === "create" && <CreateStep />}
            {step === "fund" && <FundStep smartAccount={smartAccount} testnet={testnet} onSkip={onSkipFund} />}
          </div>

          <div className="ob-artwrap">
            <Blueprint step={step} />
            <span className="ob-artcap">{ARTCAP[step]}</span>
          </div>
        </main>

        <footer className="ob-foot">
          <span>N 53.1385° · SHERWOOD</span>
          <span className="ob-foot-r">
            {testnet ? "ROBINHOOD · TESTNET 46630" : "ROBINHOOD CHAIN"} · NON-CUSTODIAL
          </span>
        </footer>
      </div>
    </div>
  );
}

const LABELS: Record<OnboardStep, string> = { connect: "Connect", create: "Create", fund: "Fund" };
const KICK: Record<OnboardStep, string> = { connect: "Step one · prove it's you", create: "Step two · muster the band", fund: "Step three · fill the strongbox" };
const TITLE: Record<OnboardStep, string> = { connect: "SIGN IN WITH YOUR WALLET", create: "MUSTER YOUR BAND", fund: "FILL THE STRONGBOX" };
const ARTCAP: Record<OnboardStep, string> = { connect: "fig. 1 — the signature is the whole login", create: "fig. 2 — caps sealed into the draw", fund: "fig. 3 — the account self-pays its gas" };

function ConnectStep() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = async () => {
    setErr(null);
    setBusy(true);
    try {
      const provider = getInjectedProvider();
      const account = await requestAccount(provider);
      const ch = (await fetch("/api/auth/challenge", { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error("sign-in is unavailable right now");
        return r.json();
      })) as { nonce: string; message: string };
      const signature = (await provider.request({ method: "personal_sign", params: [ch.message, account] })) as string;
      const v = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce: ch.nonce, signature }),
      });
      if (!v.ok) {
        const e = (await v.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error || "sign-in failed");
      }
      window.location.reload();
    } catch (e) {
      const m = e instanceof Error ? e.message : "sign-in failed";
      setErr(/reject|denied|4001/i.test(m) ? "Sign-in cancelled." : m);
      setBusy(false);
    }
  };
  return (
    <StepBody
      body="No password, no email. Your wallet signs a one-time challenge — it moves no funds and grants no permissions, it just proves the account is yours. That signature is your whole login."
      fine="your owner key never leaves this device"
      err={err}
    >
      <button className="ob-btn" onClick={connect} disabled={busy}>
        {busy ? "Check your wallet…" : "Connect wallet →"}
      </button>
    </StepBody>
  );
}

function CreateStep() {
  return (
    <StepBody
      body="Generate an agent wallet right here in your browser, set the caps the chain itself enforces, and back up the key. The server only ever holds a capped, revocable session key — never the one that owns the funds."
      fine="non-custodial · caps enforced on-chain"
    >
      <Link className="ob-btn" href="/grant">
        Create your agent →
      </Link>
    </StepBody>
  );
}

function FundStep({ smartAccount, testnet, onSkip }: { smartAccount?: string | null; testnet: boolean; onSkip: () => void }) {
  return (
    <StepBody
      body={`Send a little ${testnet ? "testnet " : ""}ETH for gas — the account self-pays every trade — and some USDG for it to trade with, to your agent's smart account:`}
      fine="nothing trades until there's gas in the tank"
    >
      {smartAccount ? (
        <CopyRow value={smartAccount} />
      ) : (
        <span className="ob-note">Create your agent first — its address appears here.</span>
      )}
      <div className="ob-actions">
        {testnet && (
          <a className="ob-btn ghost" href="https://docs.robinhood.com/chain/" target="_blank" rel="noreferrer">
            Get testnet gas →
          </a>
        )}
        <button className="ob-btn" onClick={onSkip}>
          I&apos;ve funded it — enter camp →
        </button>
      </div>
      <button className="ob-skip" onClick={onSkip}>
        skip for now, I&apos;ll fund it later
      </button>
    </StepBody>
  );
}

function StepBody({
  body,
  fine,
  err,
  children,
}: {
  body: string;
  fine: string;
  err?: string | null;
  children: ReactNode;
}) {
  return (
    <>
      <p className="ob-body">{body}</p>
      <div className="ob-do">{children}</div>
      {err && <span className="ob-err">{err}</span>}
      <span className="ob-fine">{fine}</span>
    </>
  );
}

export { short as obShort };
