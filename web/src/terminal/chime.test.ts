/**
 * THE TRADE CHIME: OFF UNLESS THE READER TURNED IT ON, AND NEVER A THROW.
 *
 * The preference lives in localStorage, which throws in a private window, when
 * site data is blocked, and in some embedded previews. A page that crashed —
 * or chimed — because storage misbehaved would be worse than no chime.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blip, chimeSide, readSoundOn, writeSoundOn, SOUND_KEY } from "./chime";
import type { Thesis } from "./live";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
const throwing = (): Storage => {
  throw new Error("SecurityError: storage is disabled");
};
const broken: Storage = {
  length: 0,
  clear() {},
  key: () => null,
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("denied");
  },
};

describe("the sound preference", () => {
  it("is off by default", () => {
    assert.equal(readSoundOn(() => memoryStorage()), false);
    assert.equal(readSoundOn(() => null), false, "no storage at all is off");
  });

  it("is on only after the reader turned it on, and off again after they turned it off", () => {
    const s = memoryStorage();
    assert.equal(writeSoundOn(true, () => s), true);
    assert.equal(readSoundOn(() => s), true);
    assert.equal(s.getItem(SOUND_KEY), "on");
    writeSoundOn(false, () => s);
    assert.equal(readSoundOn(() => s), false);
  });

  it("storage that throws reads as off and fails to save quietly", () => {
    assert.equal(readSoundOn(throwing), false);
    assert.equal(readSoundOn(() => broken), false);
    assert.equal(writeSoundOn(true, throwing), false);
    assert.equal(writeSoundOn(true, () => broken), false);
  });
});

/** An AudioContext that records what it was asked to play. */
function fakeAudio() {
  const log: string[] = [];
  const param = (name: string) => ({
    setValueAtTime: (v: number, t: number) => log.push(`${name}=${v}@${t}`),
    exponentialRampToValueAtTime: (v: number, t: number) => log.push(`${name}->${v}@${t}`),
  });
  const ctx = {
    currentTime: 2,
    destination: {},
    createOscillator: () => ({
      type: "",
      frequency: param("freq"),
      connect: () => log.push("osc->gain"),
      start: (t: number) => log.push(`start@${t}`),
      stop: (t: number) => log.push(`stop@${t}`),
    }),
    createGain: () => ({ gain: param("gain"), connect: () => log.push("gain->out") }),
  };
  return { ctx: ctx as unknown as AudioContext, log };
}

describe("the blip", () => {
  it("is short, and ends in silence", () => {
    const { ctx, log } = fakeAudio();
    blip(ctx, "buy");
    const stop = Number(log.find((l) => l.startsWith("stop@"))!.slice(5));
    assert.ok(stop - 2 <= 0.25, `a blip, not a tune: ${stop - 2}s`);
    assert.ok(log.includes("start@2"));
    assert.ok(log.some((l) => /^gain->0\.0001@/.test(l)), "the gain ramps back to silence, no click");
  });

  it("a buy rises and a sell falls", () => {
    const pitch = (side: "buy" | "sell") => {
      const { ctx, log } = fakeAudio();
      blip(ctx, side);
      const start = Number(/^freq=(\d+)@/.exec(log.find((l) => l.startsWith("freq="))!)![1]);
      const end = Number(/^freq->(\d+)@/.exec(log.find((l) => l.startsWith("freq->"))!)![1]);
      return end - start;
    };
    assert.ok(pitch("buy") > 0);
    assert.ok(pitch("sell") < 0);
  });

  it("plays for the newest fill of a batch", () => {
    const t = (action: "buy" | "sell", at: number) => ({ action, at }) as Thesis;
    assert.equal(chimeSide([t("buy", 1), t("sell", 5)]), "sell");
    assert.equal(chimeSide([]), null);
  });
});
