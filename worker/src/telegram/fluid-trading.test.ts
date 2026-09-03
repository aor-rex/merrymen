import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fastParseTrade, parseSlash } from "./interpreter";
import { executeCommand, type CommandDeps, type PendingAction } from "./executor";

/**
 * THE FLUID PATH — say it, see the card, confirm it lands.
 *
 * fastParseTrade must catch every trade-shaped phrasing BEFORE the LLM (a
 * down provider once answered "/buy 1 nvda" with a paragraph of leaked
 * reasoning while the trade went nowhere). executeCommand must PARK every
 * buy/sell — no size threshold — and only deps.trade on /confirm.
 */

describe("fastParseTrade — trade-shaped text parses with no model", () => {
  it("parses every slash form", async () => {
    assert.deepEqual(await fastParseTrade("/buy 1 nvda"), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.deepEqual(await fastParseTrade("/buy NVDA 1"), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.deepEqual(await fastParseTrade("/sell 2 TSLA"), { kind: "sell", symbol: "TSLA", usdg: 2 });
  });

  it("refuses a symbol that is not a known token when a resolver is passed", async () => {
    const known = async (s: string) => ["NVDA", "TSLA", "AAPL", "QQQ"].includes(s);
    assert.deepEqual(await fastParseTrade("/buy 1 nvda", known), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.equal(await fastParseTrade("/buy 1 UNKNOWNCOIN", known), null);
    assert.equal(await fastParseTrade("buy 1 usdg of randomx", known), null);
  });

  it("resolves a Pons launch symbol through the async resolver", async () => {
    const ponsSet = new Set(["POTAM", "PIPEC", "VTSI", "GALIKA"]);
    const resolver = async (s: string) => ponsSet.has(s.toUpperCase());
    assert.deepEqual(await fastParseTrade("/buy 1 potam", resolver), { kind: "buy", symbol: "POTAM", usdg: 1 });
    assert.deepEqual(await fastParseTrade("/buy 1 pipec", resolver), { kind: "buy", symbol: "PIPEC", usdg: 1 });
    assert.equal(await fastParseTrade("/buy 1 NOTAPONSCOIN", resolver), null);
  });

  it("parses bare-verb phrasings with filler words", async () => {
    assert.deepEqual(await fastParseTrade("buy 1 usdg of nvda"), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.deepEqual(await fastParseTrade("sell 2 usdg of tsla"), { kind: "sell", symbol: "TSLA", usdg: 2 });
    assert.deepEqual(await fastParseTrade("buy nvda 1"), { kind: "buy", symbol: "NVDA", usdg: 1 });
  });

  it("corrects the one-key thumb typos", async () => {
    assert.deepEqual(await fastParseTrade("but 1 usdg of nvda"), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.deepEqual(await fastParseTrade("byu 2 nvda"), { kind: "buy", symbol: "NVDA", usdg: 2 });
    assert.deepEqual(await fastParseTrade("/buy 1 usdg of nvda"), { kind: "buy", symbol: "NVDA", usdg: 1 });
  });

  it("WINS over parseSlash: filler words are stripped, not read as symbols", async () => {
    // THE BUG THIS LOCKS. parseSlash reads the "usdg" in "/sell 1 usdg of
    // tsla" as the SYMBOL (it matches the ticker shape), producing a
    // nonsense USDG-for-USDG swap that would burn gas reaching the wall.
    // The fluid parse strips filler and gets TSLA — and it must be asked
    // FIRST, which is the order service.ts now uses.
    assert.deepEqual(await fastParseTrade("/sell 1 usdg of tsla"), { kind: "sell", symbol: "TSLA", usdg: 1 });
    assert.deepEqual(await fastParseTrade("/buy 1 usdg of nvda"), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.notDeepEqual(parseSlash("/sell 1 usdg of tsla")?.kind === "sell" ? (parseSlash("/sell 1 usdg of tsla") as { symbol: string }).symbol : "", "TSLA");
  });

  it("parses $ symbols and usdg suffixes", async () => {
    assert.deepEqual(await fastParseTrade("/buy $nvda 1"), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.deepEqual(await fastParseTrade("/buy nvda 1usdg"), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.deepEqual(await fastParseTrade("/buy $NVDA 1usdg"), { kind: "buy", symbol: "NVDA", usdg: 1 });
    assert.deepEqual(await fastParseTrade("buy 1usdg of $nvda"), { kind: "buy", symbol: "NVDA", usdg: 1 });
  });

  it("accepts longer memecoin names (up to 10 chars)", async () => {
    assert.deepEqual(await fastParseTrade("/buy pipotam 5"), { kind: "buy", symbol: "PIPOTAM", usdg: 5 });
    assert.deepEqual(await fastParseTrade("buy 2 pipotam"), { kind: "buy", symbol: "PIPOTAM", usdg: 2 });
    assert.deepEqual(parseSlash("/buy PIPOTAM 1"), { kind: "buy", symbol: "PIPOTAM", usdg: 1 });
  });

  it("returns null for non-trades — the LLM keeps its job", async () => {
    assert.equal(await fastParseTrade("/status"), null);
    assert.equal(await fastParseTrade("what's my pnl?"), null);
    assert.equal(await fastParseTrade("buy 1 usdg of any coin"), null, "no symbol → not a trade");
    assert.equal(await fastParseTrade("buy"), null);
    assert.equal(await fastParseTrade(""), null);
    // /buy 0 is not a valid amount — returns ask-amount just like /buy without it
    const zeroParse = await fastParseTrade("buy 0 nvda");
    assert.ok(zeroParse === null || (zeroParse as any).kind === "ask-amount", "zero amount should not create a trade");
  });

  it("never returns a non-trade kind even from a slash", async () => {
    // /pause IS a real slash command — parseSlash handles it. The fluid path
    // must simply refuse it: trading verbs only, or the LLM keeps its job.
    assert.equal(await fastParseTrade("/pause"), null);
    assert.equal(await fastParseTrade("/help"), null);
    assert.deepEqual(parseSlash("/pause"), { kind: "pause" });
  });
});

/** In-memory deps: pending store, recorded trades, nothing on-chain. */
function fakeDeps(over: Partial<CommandDeps> = {}) {
  const calls: { side: string; symbol: string; usdg: number }[] = [];
  let pending: PendingAction | null = null;
  let nowSec = 1_000_000;
  const deps: CommandDeps = {
    controlEnabled: true,
    maxActionUsdg: 25,
    transferEnabled: false,
    grantHasTransfer: false,
    link: () => ({ ok: true }),
    trade: async (side, symbol, usdg) => {
      calls.push({ side, symbol, usdg });
      return `⚡ executed — ${side} ${usdg} USDG of ${symbol}`;
    },
    confirmTrade: async (side, symbol, usdg) => {
      calls.push({ side, symbol, usdg });
      return `✅ confirmed — ${side} ${usdg} USDG of ${symbol}`;
    },
    transfer: async () => "unused",
    getPending: () => pending,
    setPending: (p) => {
      pending = p;
    },
    clearPending: () => {
      pending = null;
    },
    now: () => nowSec,
    kill: () => ({ ok: true }),
    ...over,
  } as CommandDeps;
  return {
    deps,
    calls,
    get pending() {
      return pending;
    },
    tick: (s: number) => {
      nowSec += s;
    },
  };
}

const CHAT = { chatId: 1, fromId: 1 } as never;
void CHAT;

describe("executeCommand — every trade parks for confirmation", () => {
  it("a buy parks: nothing fires until /confirm", async () => {
    const t = fakeDeps();
    const reply = await executeCommand({ kind: "buy", symbol: "NVDA", usdg: 1 }, t.deps);
    assert.match(reply, /pending/);
    assert.match(reply, /\/confirm/);
    assert.equal(t.calls.length, 0, "no trade on park");
    assert.deepEqual(t.pending, { kind: "buy", symbol: "NVDA", usdg: 1, expiresAt: 1_000_090 });
  });

  it("/confirm fires exactly the parked trade, once", async () => {
    const t = fakeDeps();
    await executeCommand({ kind: "buy", symbol: "NVDA", usdg: 1 }, t.deps);
    const reply = await executeCommand({ kind: "confirm" }, t.deps);
    assert.match(reply, /confirmed/);
    assert.deepEqual(t.calls, [{ side: "buy", symbol: "NVDA", usdg: 1 }]);
    assert.equal(t.pending, null, "the slot clears after firing");
  });

  it("/cancel discards without firing", async () => {
    const t = fakeDeps();
    await executeCommand({ kind: "sell", symbol: "TSLA", usdg: 2 }, t.deps);
    await executeCommand({ kind: "cancel" }, t.deps);
    assert.equal(t.calls.length, 0);
    assert.equal(t.pending, null);
  });

  it("an expired card cannot fire", async () => {
    const t = fakeDeps();
    await executeCommand({ kind: "buy", symbol: "NVDA", usdg: 1 }, t.deps);
    t.tick(91); // past the 90s TTL
    const reply = await executeCommand({ kind: "confirm" }, t.deps);
    assert.match(reply, /expired/);
    assert.equal(t.calls.length, 0);
  });

  it("the amount above the chat ceiling parks TRIMMED, and fires trimmed", async () => {
    const t = fakeDeps();
    await executeCommand({ kind: "buy", symbol: "NVDA", usdg: 50 }, t.deps);
    assert.deepEqual(t.pending, { kind: "buy", symbol: "NVDA", usdg: 25, expiresAt: 1_000_090 });
    await executeCommand({ kind: "confirm" }, t.deps);
    assert.deepEqual(t.calls, [{ side: "buy", symbol: "NVDA", usdg: 25 }]);
  });

  it("control switched off mid-window: the confirm is refused, nothing moves", async () => {
    const t = fakeDeps();
    await executeCommand({ kind: "buy", symbol: "NVDA", usdg: 1 }, t.deps);
    t.deps.controlEnabled = false;
    const reply = await executeCommand({ kind: "confirm" }, t.deps);
    assert.match(reply, /control was turned off/);
    assert.equal(t.calls.length, 0);
  });

  it("control off at park time: the 🔒 refusal, unchanged", async () => {
    const t = fakeDeps({ controlEnabled: false });
    const reply = await executeCommand({ kind: "buy", symbol: "NVDA", usdg: 1 }, t.deps);
    assert.match(reply, /control commands are turned off/);
    assert.equal(t.pending, null);
  });

  it("the fluid path end to end: typo'd phrase → park → confirm → fired", async () => {
    const t = fakeDeps();
    const parsed = await fastParseTrade("but 1 usdg of nvda", async (s) => true);
    assert.ok(parsed);
    await executeCommand(parsed, t.deps);
    await executeCommand({ kind: "confirm" }, t.deps);
    assert.deepEqual(t.calls, [{ side: "buy", symbol: "NVDA", usdg: 1 }]);
  });
});
