"use client";

import { useEffect, useState } from "react";
import { MerrymanFigure } from "./MerrymanFigure";
import {
  COLORWAYS,
  KINDS,
  colorwayFromStored,
  colorwayHex,
  colorwayKey,
  kindEmoji,
  kindFromStored,
  kindKey,
  type FigureColorway,
  type FigureKind,
} from "@/lib/merryman-figure";

/**
 * SEE IT, DRESS IT, CONTROL IT — one stage.
 *
 * The figure is state (mode, strategy, wire). The swatches are dress: body
 * paint only, stored per agent in this browser, and they can never touch
 * trim, fins or ring. Tapping the figure opens its orders: Talk (focuses the
 * chat box), Portfolio (opens the book), Add funds, Withdraw — every one of
 * them the screen's own handler, no new authority invented here.
 *
 * Styled inline, not in a sheet: styles/scoped.test.ts pins every rule in
 * web/src/styles under .mm, and this leaf needs none of that machinery.
 */
export function MerrymanStage({
  mode,
  strategy,
  wired = false,
  slug,
  name,
  size = 200,
  actions,
}: {
  mode: string | null | undefined;
  strategy?: string | null;
  wired?: boolean;
  slug: string | null | undefined;
  name: string;
  size?: number;
  actions: {
    talk: () => void;
    portfolio: () => void;
    deposit: () => void;
    withdraw: () => void;
  };
}) {
  const key = colorwayKey(slug);
  const kkey = kindKey(slug);
  const [colorway, setColorway] = useState<FigureColorway>("spectre");
  const [kind, setKind] = useState<FigureKind>("robot");
  const [open, setOpen] = useState(false);

  // Dress survives reloads, per agent, in this browser only.
  useEffect(() => {
    try {
      setColorway(colorwayFromStored(window.localStorage.getItem(key)));
      setKind(kindFromStored(window.localStorage.getItem(kkey)));
    } catch {
      setColorway("spectre");
      setKind("robot");
    }
  }, [key, kkey]);

  const dress = (next: FigureColorway) => {
    setColorway(next);
    try {
      window.localStorage.setItem(key, next);
    } catch {
      // Private browsing: the shell just doesn't survive. Nothing breaks.
    }
  };

  const pickKind = (next: FigureKind) => {
    setKind(next);
    try {
      window.localStorage.setItem(kkey, next);
    } catch {
      // Private browsing: the kind just doesn't survive. Nothing breaks.
    }
  };
  const order = (
    label: string,
    run: () => void,
  ) => (
    <button
      key={label}
      type="button"
      onClick={() => {
        setOpen(false);
        run();
      }}
      style={{
        background: "#10141b",
        border: "1px solid #232c38",
        borderRadius: 10,
        color: "#e6ebf2",
        padding: "8px 12px",
        fontSize: 13,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <MerrymanFigure
        mode={mode}
        strategy={strategy}
        wired={wired}
        colorway={colorway}
        kind={kind}
        size={size}
        onTap={() => setOpen((v) => !v)}
      />
      {/* KIND: which figurine. The head is the character, never the state. */}
      <div role="group" aria-label={`kind of ${name}`} style={{ display: "flex", gap: 8 }}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            title={k}
            aria-label={`${name} as ${k}`}
            aria-pressed={kind === k}
            onClick={() => pickKind(k)}
            style={{
              width: 30,
              height: 30,
              borderRadius: "50%",
              background: kind === k ? "#1c2530" : "transparent",
              border: kind === k ? "2px solid #22c55e" : "2px solid #232c38",
              fontSize: 17,
              lineHeight: 1,
              cursor: "pointer",
              padding: 0,
            }}
          >
            {kindEmoji(k)}
          </button>
        ))}
      </div>
      {/* DRESS: paint, not state. Three shells, the house black first. */}
      <div role="group" aria-label={`dress ${name}`} style={{ display: "flex", gap: 8 }}>
        {COLORWAYS.map((c) => (
          <button
            key={c}
            type="button"
            title={c}
            aria-label={`dress ${name} in ${c}`}
            aria-pressed={colorway === c}
            onClick={() => dress(c)}
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: colorwayHex(c),
              border: colorway === c ? "2px solid #22c55e" : "2px solid #232c38",
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>
      {/* CONTROL: its orders. Every button is the screen's own handler. */}
      {open && (
        <div
          role="menu"
          aria-label={`command ${name}`}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}
        >
          {order(`talk to ${name}`, actions.talk)}
          {order("portfolio", actions.portfolio)}
          {order("add funds", actions.deposit)}
          {order("withdraw", actions.withdraw)}
        </div>
      )}
    </div>
  );
}
