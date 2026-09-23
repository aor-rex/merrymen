/**
 * AN EXIT IS STILL NAMED AFTER A REDEPLOY WIPED THE LEDGER ITS BUY WAS IN.
 *
 * The writer's first fix looked the name up in the child's own `decisions`
 * table — the name its buy used. That table is WIPED BY EVERY REDEPLOY
 * (index.ts and orchestrator.ts both say so), and the default Trencher holds a
 * coin for up to three days. So for a coin bought before the latest deploy
 * every exit and every review written afterwards went out unnamed again, and
 * the reader's fallback only looks inside its own 24h window — the feed went
 * back to "sell TA151B4A9E1B 5.01 USDG", the live defect this was meant to fix.
 *
 * What survives a redeploy is the coin itself: its contract's own `symbol()`,
 * which is the word the tape's pool label was built from. These drive the real
 * store, empty as a redeploy leaves it, and the real resolver the tick calls.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { StockToken } from "../../packages/core/src/index";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-decision-name-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
const { ChainCoinNames, makeDecisionNamer } = await import("./decision-name");
try {
  process.chdir(isolatedCwd);
  await store.initStore();
} finally {
  process.chdir(originalCwd);
}

after(() => {
  store.closeStoreForTest();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const AGENT = "0x7777777777777777777777777777777777777777";
const HELD = "0x00000000000000000000000000a151b4a9e1b000" as `0x${string}`;
const COIN = `T${HELD.slice(-11).toUpperCase()}`;

/** How discovery labels a held coin the tape no longer qualifies: its own id. */
const forgotten = (over: Partial<StockToken> = {}): StockToken => ({
  symbol: COIN,
  name: COIN,
  address: HELD,
  decimals: 18,
  kind: "memecoin",
  chainlinkFeed: null,
  ...over,
} as StockToken);

const NVDA: StockToken = {
  symbol: "NVDA",
  name: "NVIDIA",
  address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  chainlinkFeed: null,
  kind: "stock",
} as StockToken;

/** A chain that answers `symbol()` from a table, and counts what it was asked. */
const chainOf = (answers: Record<string, string | Error>, opts: { delayMs?: number } = {}) => {
  const asked: string[] = [];
  const names = new ChainCoinNames(async (address) => {
    asked.push(address.toLowerCase());
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    const a = answers[address.toLowerCase()];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error("execution reverted");
    return a;
  }, { timeoutMs: 50, retryMs: 60_000 });
  return { asked, names };
};

const namer = (watch: StockToken[], chain: InstanceType<typeof ChainCoinNames>) =>
  makeDecisionNamer({ watchTokens: () => watch, ledger: store.displayNameFor, chain });

describe("after a redeploy, the coin names itself", () => {
  it("AN EXIT WRITTEN INTO AN EMPTY LEDGER, FOR A COIN THE TAPE FORGOT, CARRIES THE COIN'S OWN NAME", async () => {
    const { names } = chainOf({ [HELD]: "CASHCAT" });
    assert.equal(await store.displayNameFor(AGENT, COIN, null), null, "the ledger has nothing — as a redeploy leaves it");
    assert.equal(await namer([forgotten()], names)(AGENT, COIN), "CASHCAT");
  });

  it("the tape's own name still wins, and the chain is not asked", async () => {
    const { names, asked } = chainOf({ [HELD]: "CASHCAT" });
    assert.equal(await namer([forgotten({ name: "KITTY / WETH 1%" })], names)(AGENT, COIN), "KITTY");
    assert.deepEqual(asked, []);
  });

  it("the name this agent's buy used comes before the chain's — the feed says what the buy said", async () => {
    await store.addDecision({ id: "named-buy", agent_id: AGENT, source: "brain", symbol: COIN, action: "buy", display_name: "CASHCAT" });
    const { names, asked } = chainOf({ [HELD]: "RENAMED" });
    assert.equal(await namer([forgotten()], names)(AGENT, COIN), "CASHCAT");
    assert.deepEqual(asked, [], "a ledger hit costs no chain read");
  });
});

describe("the chain's answer is display text somebody else wrote", () => {
  const other = "0x00000000000000000000000000bbbbbbbbbbb000" as `0x${string}`;
  const otherId = `T${other.slice(-11).toUpperCase()}`;
  const tok = forgotten({ symbol: otherId, name: otherId, address: other });

  it("SANITISED like the tape's: an address, or nothing readable, is no name", async () => {
    for (const raw of ["0x00000000000000000000000000bbbbbbbbbbb000", "   ", "$$$", otherId]) {
      const { names } = chainOf({ [other]: raw });
      assert.equal(await namer([tok], names)(AGENT + "0", otherId), null, JSON.stringify(raw));
    }
    const { names } = chainOf({ [other]: "  Pepe<script>  " });
    assert.equal(await namer([tok], names)(AGENT + "0", otherId), "Pepescript");
  });

  it("A STOCK IS NEVER LOOKED UP — its ticker is its name", async () => {
    const { names, asked } = chainOf({ [NVDA.address.toLowerCase()]: "Something Else" });
    assert.equal(await namer([NVDA], names)(AGENT, "NVDA"), null);
    assert.deepEqual(asked, []);
  });

  it("a coin outside the watch set has no address to ask about, and no name", async () => {
    const { names, asked } = chainOf({});
    assert.equal(await namer([], names)(AGENT, "TFFFFFFFFFFF"), null);
    assert.deepEqual(asked, []);
  });

  it("ONLY AN ADDRESS-DERIVED ID IS LOOKED UP — a coin with a readable ticker already has its word", async () => {
    const cate = forgotten({ symbol: "CATE", name: "CATE", address: "0x00000000000000000000000000eeeeeeeeeee000" as `0x${string}` });
    const { names, asked } = chainOf({ [cate.address.toLowerCase()]: "CATECOIN" });
    assert.equal(await namer([cate], names)(AGENT, "CATE"), null);
    assert.deepEqual(asked, []);
  });

  it("the cache never reads a stock, even asked directly", async () => {
    const { names, asked } = chainOf({ [NVDA.address.toLowerCase()]: "Something Else" });
    assert.equal(await names.nameOf(NVDA), null);
    assert.deepEqual(asked, []);
  });
});

describe("a name never costs a trade", () => {
  const slow = "0x00000000000000000000000000ccccccccccc000" as `0x${string}`;
  const slowId = `T${slow.slice(-11).toUpperCase()}`;
  const tok = forgotten({ symbol: slowId, name: slowId, address: slow });

  it("A FAILED READ IS NO NAME, not a throw — and it is not retried on every decision", async () => {
    const { names, asked } = chainOf({ [slow]: new Error("rpc down") });
    const n = namer([tok], names);
    assert.equal(await n(AGENT, slowId), null);
    assert.equal(await n(AGENT, slowId), null);
    assert.equal(asked.length, 1, "one read per retry window, not one per decision");
  });

  it("A SLOW READ IS NO NAME within the bound — and its late answer is kept for the next decision", async () => {
    const { names } = chainOf({ [slow]: "TURTLE" }, { delayMs: 1_000 });
    const n = namer([tok], names);
    const started = Date.now();
    assert.equal(await n(AGENT, slowId), null);
    assert.ok(Date.now() - started < 800, "the decision did not wait for the chain");
    await new Promise((r) => setTimeout(r, 1_200));
    assert.equal(await n(AGENT, slowId), "TURTLE");
  });

  it("NOTHING HERE THROWS INTO THE WRITER — not the chain step, and not the resolver", async () => {
    const lost = "0x00000000000000000000000000fffffffffff000" as `0x${string}`;
    const id = `T${lost.slice(-11).toUpperCase()}`;
    assert.equal(await store.displayNameFor(AGENT, id, null, async () => { throw new Error("rpc down"); }), null);
    const broken = makeDecisionNamer({
      watchTokens: () => { throw new Error("watch set unreadable"); },
      ledger: store.displayNameFor,
      chain: chainOf({}).names,
    });
    assert.equal(await broken(AGENT, id), null);
    const ledgerDown = makeDecisionNamer({
      watchTokens: () => [forgotten({ symbol: id, name: id, address: lost })],
      ledger: async () => { throw new Error("database is locked"); },
      chain: chainOf({}).names,
    });
    assert.equal(await ledgerDown(AGENT, id), null);
  });

  it("CONCURRENT ASKS SHARE ONE READ", async () => {
    const coin = "0x00000000000000000000000000abcabcabcab000" as `0x${string}`;
    const tok = forgotten({ symbol: `T${coin.slice(-11).toUpperCase()}`, name: "x", address: coin });
    const { names, asked } = chainOf({ [coin]: "SHARED" }, { delayMs: 10 });
    assert.deepEqual(await Promise.all([names.nameOf(tok), names.nameOf(tok), names.nameOf(tok)]), ["SHARED", "SHARED", "SHARED"]);
    assert.equal(asked.length, 1);
  });

  it("ONE READ PER COIN: an answer is remembered, and concurrent asks share it", async () => {
    const coin = "0x00000000000000000000000000ddddddddddd000" as `0x${string}`;
    const id = `T${coin.slice(-11).toUpperCase()}`;
    const { names, asked } = chainOf({ [coin]: "DOGWIF" });
    const n = namer([forgotten({ symbol: id, name: id, address: coin })], names);
    const [a, b] = await Promise.all([n(AGENT, id), n(AGENT, id)]);
    assert.equal(a, "DOGWIF");
    assert.equal(b, "DOGWIF");
    assert.equal(await n(AGENT, id), "DOGWIF");
    assert.equal(asked.length, 1);
  });
});
