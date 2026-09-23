/**
 * A SHORT TONE WHEN A REAL-MONEY TRADE LANDS — opt-in, off by default.
 *
 * The preference is the reader's and lives in their browser. localStorage
 * throws in private windows, with site data blocked and in some previews, so
 * every touch of it is caught, and anything but an explicit "on" is off.
 *
 * WebAudio, synthesised, so there is no sound file to fetch. Browsers start an
 * AudioContext suspended until the reader has interacted with the page, so the
 * context is created and resumed from the toggle's own click (`unlockAudio`),
 * and after a reload with the sound already on, from the first click or key
 * anywhere — until then nothing plays, and nothing fails loudly either.
 */
import type { Thesis } from "./live";

export const SOUND_KEY = "merrymen.sound";

type StorageSource = () => Storage | null | undefined;

export function readSoundOn(storage: StorageSource): boolean {
  try {
    return storage()?.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

/** True when the choice was saved; false when storage would not take it. */
export function writeSoundOn(on: boolean, storage: StorageSource): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (on) s.setItem(SOUND_KEY, "on");
    else s.removeItem(SOUND_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * One blip: a buy rises a fifth, a sell falls one. Under a fifth of a second,
 * quiet, and ramped in and out so it does not click.
 */
export function blip(ctx: AudioContext, side: "buy" | "sell"): void {
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  const [from, to] = side === "buy" ? [660, 990] : [990, 660];
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + 0.09);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.18);
}

/** One tone per batch of arrivals, for the newest of them. */
export function chimeSide(news: readonly Thesis[]): "buy" | "sell" | null {
  let newest: Thesis | null = null;
  for (const t of news) if (!newest || (t.at ?? 0) >= (newest.at ?? 0)) newest = t;
  return newest?.action === "buy" || newest?.action === "sell" ? newest.action : null;
}

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  const Ctor =
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    context = new Ctor();
  } catch {
    return null;
  }
  return context;
}

/** From a click or a key press — the only moment a browser lets audio start. */
export function unlockAudio(): void {
  const ctx = audio();
  if (ctx && ctx.state === "suspended") void ctx.resume().catch(() => {});
}

/** Play the tone for `side`, if the browser will let us; never throws. */
export function playChime(side: "buy" | "sell"): void {
  const ctx = audio();
  if (!ctx) return;
  try {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    blip(ctx, side);
  } catch {
    /* A tone is a nicety; a page that stopped over one would not be. */
  }
}
