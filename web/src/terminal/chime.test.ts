/**
 * THE TRADE CHIME: OFF UNLESS THE READER TURNED IT ON, AND NEVER A THROW.
 *
 * The preference lives in localStorage, which throws in a private window, when
 * site data is blocked, and in some embedded previews. A page that crashed —
 * or chimed — because storage misbehaved would be worse than no chime.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  blip,
  chimeSide,
  forgetAudioForTest,
  playChime,
  readSoundOn,
  unlockAudio,
  writeSoundOn,
  SOUND_KEY,
} from "./chime";
import { act, createElement } from "react";

import type { Thesis } from "./live";
import { useSoundPref } from "./live-news";
import { testDom } from "./test-dom";

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

/**
 * A browser's AudioContext, as far as the chime uses it: made suspended, and
 * running only once `resume()` settles — which a browser allows from a click or
 * a key press and nothing else. Every oscillator it is asked for is recorded.
 */
function fakeBrowserAudio() {
  const made: FakeContext[] = [];
  class FakeContext {
    state: "suspended" | "running" = "suspended";
    currentTime = 0;
    destination = {};
    oscillators = 0;
    private wake: Array<() => void> = [];
    constructor() {
      made.push(this);
    }
    resume() {
      return new Promise<void>((r) => this.wake.push(r));
    }
    /** The browser honouring the resume: the page's gesture reached it. */
    allow() {
      this.state = "running";
      for (const r of this.wake.splice(0)) r();
    }
    createOscillator() {
      this.oscillators++;
      const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
      return { type: "", frequency: param, connect() {}, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }
  const g = globalThis as { AudioContext?: unknown };
  const before = g.AudioContext;
  g.AudioContext = FakeContext;
  forgetAudioForTest();
  return {
    made,
    restore() {
      forgetAudioForTest();
      if (before === undefined) delete g.AudioContext;
      else g.AudioContext = before;
    },
  };
}
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("a tone plays when the trade lands, or not at all", () => {
  it("a fill before the reader's first click makes no context and schedules nothing", () => {
    const audio = fakeBrowserAudio();
    try {
      const played = playChime("buy");
      assert.equal(audio.made.length, 0, "only a gesture makes the context");
      assert.equal(played, false);
    } finally {
      audio.restore();
    }
  });

  it("A FILL WHILE THE CONTEXT IS STILL SUSPENDED IS SILENT — scheduled, it would play late, at the next click", async () => {
    // A suspended context's clock is frozen: a blip scheduled on it is queued
    // and renders the moment the context resumes, so a trade from minutes ago
    // sounded as if it had just landed, several at once.
    const audio = fakeBrowserAudio();
    try {
      void unlockAudio();
      const ctx = audio.made[0]!;
      assert.equal(ctx.state, "suspended");
      const played = playChime("sell");
      assert.equal(ctx.oscillators, 0, "nothing queued behind the suspension");
      assert.equal(played, false);
      ctx.allow();
      await tick();
      assert.equal(ctx.oscillators, 0, "and nothing plays when it resumes");
      assert.equal(playChime("buy"), true, "the next fill, once it is running, sounds");
      assert.equal(ctx.oscillators, 1);
    } finally {
      audio.restore();
    }
  });

  it("the switch's own click plays its tone once the context is running — not before", async () => {
    const audio = fakeBrowserAudio();
    try {
      let running = false;
      const unlocked = unlockAudio().then((r) => (running = r));
      assert.equal(running, false);
      audio.made[0]!.allow();
      await unlocked;
      assert.equal(running, true);
      assert.equal(audio.made.length, 1, "one context, reused");
      void unlockAudio();
      assert.equal(audio.made.length, 1);
    } finally {
      audio.restore();
    }
  });

  it("turning the sound on sounds once, when the click has started the context", async () => {
    const audio = fakeBrowserAudio();
    const t = testDom();
    let toggle: () => void = () => {};
    function Sound() {
      const [, flip] = useSoundPref(() => null);
      toggle = flip;
      return null;
    }
    try {
      await t.render(createElement(Sound));
      await act(async () => toggle());
      const ctx = audio.made[0]!;
      assert.equal(ctx.oscillators, 0, "not onto a context that is still starting");
      await act(async () => {
        ctx.allow();
        await tick();
      });
      assert.equal(ctx.oscillators, 1, "the reader hears what they chose");
    } finally {
      await t.close();
      audio.restore();
    }
  });
});

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
