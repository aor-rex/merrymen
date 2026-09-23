/**
 * WHAT THE SHELL DOES WHEN A REAL-MONEY TRADE LANDS: a tone, if the reader
 * asked for one, and a count in the tab title while the tab is hidden.
 *
 * Driven by the feed's own reads — the feed clock keeps reading once a minute
 * while the tab is hidden precisely so this can count — and by `arrivals.ts`
 * for what counts. No request of its own.
 *
 * Hooks in a .ts file so the runner can execute them against a DOM: App.tsx
 * renders under next/navigation and cannot be mounted by a test.
 */
import { useEffect, useRef, useState } from "react";
import { createArrivals } from "./arrivals";
import { chimeSide, playChime, readSoundOn, unlockAudio, writeSoundOn } from "./chime";
import type { ReadState, Thesis } from "./live";
import { badgedTitle } from "./tab-badge";

export function useLiveNews(opts: {
  theses: readonly Thesis[];
  read: ReadState;
  soundOn: boolean;
  play?: (side: "buy" | "sell") => void;
  nowMs?: () => number;
}): number {
  const { theses, read } = opts;
  const arrivals = useRef<ReturnType<typeof createArrivals> | null>(null);
  if (!arrivals.current) arrivals.current = createArrivals();
  const latest = useRef(opts);
  latest.current = opts;
  const [unseen, setUnseen] = useState(0);

  useEffect(() => {
    // Only an answer that was read: an unreadable one has no rows, and the
    // first readable one seeds the set without a sound.
    if (read !== "ok") return;
    const now = latest.current.nowMs?.() ?? Date.now();
    const news = arrivals.current!.take(theses, now / 1000);
    if (!news.length) return;
    if (document.hidden) setUnseen((n) => n + news.length);
    const side = chimeSide(news);
    if (latest.current.soundOn && side) (latest.current.play ?? playChime)(side);
  }, [theses, read]);

  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) setUnseen(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  useEffect(() => {
    document.title = badgedTitle(document.title, unseen);
  }, [unseen]);

  return unseen;
}

/**
 * The reader's sound choice: off until they turn it on, remembered in this
 * browser when storage allows (chime.ts). Turning it on plays one tone — from
 * the click itself, which is the moment a browser lets audio start, and so the
 * reader hears what they chose.
 */
export function useSoundPref(
  storage: () => Storage | null | undefined = () => globalThis.localStorage,
): [boolean, () => void] {
  const [on, setOn] = useState(false);
  const source = useRef(storage);
  source.current = storage;
  // Read after mount, never during the server render, which has no storage.
  useEffect(() => {
    setOn(readSoundOn(() => source.current()));
  }, []);
  // Remembered as on from an earlier visit: the context can only start from a
  // gesture, so the first click or key press on the page starts it.
  useEffect(() => {
    if (!on) return;
    const unlock = () => void unlockAudio();
    document.addEventListener("pointerdown", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [on]);
  const toggle = () => {
    const next = !on;
    writeSoundOn(next, () => source.current());
    setOn(next);
    // The click resumes the context; the tone waits until it is running,
    // which from a click is a moment, and plays nothing if it never is.
    if (next) void unlockAudio().then((running) => running && playChime("buy"));
  };
  return [on, toggle];
}
