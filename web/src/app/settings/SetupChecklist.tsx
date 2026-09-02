"use client";

/**
 * The setup checklist — where the first-run steps live AFTER onboarding.
 *
 * The /app muster walks a new owner through connect → create → fund one screen
 * at a time, then gets out of the way. This is the same three steps as a quiet
 * status strip in Settings: revisit-able, honest (every done-state is read from
 * real data, not a saved flag), and a fast way back to re-fund or re-key. Self-
 * contained inline styles so it drops into the dense-terminal settings page
 * without touching its stylesheet.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AgentStatus } from "@/app/api/grants/route";
import { canStart } from "@/lib/can-start";

type Sess = { hosted: boolean; address: string | null };

/*
 * THE DESIGN SYSTEM, not eleven hexes copied out of the old console.
 *
 * These were literals from the retired green palette — a #0f1410 card and a
 * #b6e226 lime — so this strip stayed the colour of a page that no longer
 * exists while everything around it went black. Reading the tokens means it
 * simply follows whatever the system says next.
 */
const C = {
  card: "var(--mm-surface)",
  line: "var(--mm-edge)",
  line2: "var(--mm-edge-2)",
  /*
   * TWO ROLES, NOT ONE GREEN. The old sheet spent lime on both the call to
   * action and the completed state, which mapped to --mm-up and put three
   * bright green things on a black page whose accent is meant to be single.
   *
   * A button asking you to create an agent is an ACTION, so it takes --mm-wire,
   * the same colour "Deploy an agent" wears in the bar directly above it. Only
   * a finished step is a gain.
   */
  lime: "var(--mm-wire)",
  mint: "var(--mm-up)",
  tx: "var(--mm-tx)",
  tx2: "var(--mm-tx-2)",
  dim: "var(--mm-dim)",
  faint: "var(--mm-faint)",
  mono: "var(--mm-mono)",
};


export default function SetupChecklist() {
  const [sess, setSess] = useState<Sess | null>(null);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/auth/session", { cache: "no-store" })
        .then((r) => r.json() as Promise<Sess>)
        .catch(() => ({ hosted: false, address: null } as Sess)),
      fetch("/api/grants", { cache: "no-store" })
        .then((r) => r.json() as Promise<AgentStatus>)
        .catch(() => ({ exists: false } as AgentStatus)),
    ]).then(([s, st]) => {
      if (!alive) return;
      setSess(s);
      setStatus(st);
      setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!ready) return null;

  const hosted = !!sess?.hosted;
  const connected = !hosted || !!sess?.address;
  const exists = !!status?.exists;
  // The SAME question the console asks, from the same module. Two private
  // copies meant this could report a sponsored, funded, trading owner as
  // unfinished forever while the console had already let them in.
  const funded = canStart(status ?? undefined);

  const steps = [
    ...(hosted
      ? [{ label: "Connect your wallet", done: connected, hint: "the signature is your whole login", href: "/app", cta: "Sign in" }]
      : []),
    { label: "Create your agent", done: exists, hint: "keys + caps, signed in your browser", href: "/grant", cta: "Create" },
    {
      label: "Fund the account",
      done: funded,
      // Sponsored, gas is not the owner's to send, so naming it would be a
      // chore invented for them.
      hint: status?.gasSponsored
        ? "USDG to trade with — the network fee is covered"
        : "a little gas + USDG to trade",
      href: "/grant",
      cta: "Fund",
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  return (
    <section
      style={{
        border: `1px solid ${allDone ? "var(--mm-edge)" : C.line2}`,
        background: C.card,
        borderRadius: 12,
        padding: "14px 16px",
        margin: "0 0 22px",
        maxWidth: 720,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: allDone ? 0 : 12 }}>
        <span style={{ fontFamily: C.mono, fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: allDone ? C.mint : C.lime }}>
          {allDone ? "✓ Setup complete" : "Getting started"}
        </span>
        <span style={{ marginLeft: "auto", fontFamily: C.mono, fontSize: 11, color: C.faint }}>
          {doneCount}/{steps.length} done
        </span>
      </div>

      {!allDone && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {steps.map((s) => (
            <div key={s.label} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderTop: `1px solid ${C.line}` }}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  flex: "none",
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  fontFamily: C.mono,
                  fontSize: 11,
                  border: `1px solid ${s.done ? "transparent" : C.line2}`,
                  background: s.done ? "rgba(182,226,38,0.16)" : "transparent",
                  color: s.done ? C.mint : C.faint,
                }}
              >
                {s.done ? "✓" : ""}
              </span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 14, color: s.done ? C.tx2 : C.tx, fontWeight: 600 }}>{s.label}</span>
                <span style={{ display: "block", fontFamily: C.mono, fontSize: 11, color: C.faint }}>{s.hint}</span>
              </span>
              {!s.done && (
                <Link
                  href={s.href}
                  style={{
                    marginLeft: "auto",
                    flex: "none",
                    fontFamily: C.mono,
                    fontSize: 12,
                    color: "var(--mm-bg)",
                    background: C.lime,
                    padding: "6px 12px",
                    borderRadius: 8,
                    fontWeight: 700,
                    textDecoration: "none",
                  }}
                >
                  {s.cta} →
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
