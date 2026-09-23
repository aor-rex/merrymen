/**
 * AN EXIT IS NAMED BY WHAT ITS BUY CALLED THE COIN.
 *
 * A held coin drops off the tape's qualified list, and discovery then labels it
 * with its own id — so every exit and review of it was written unnamed and
 * published "sell TA151B4A9E1B 5.01 USDG" (live feed, 2026-09-23). The name its
 * buy used is still in this agent's ledger, and `displayNameFor` is the one
 * place the writer asks for it. These drive the real store.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-decision-names-"));
const isolatedCwd = path.join(scratch, "cwd");
mkdirSync(isolatedCwd);
process.env.MERRYMEN_HOME = path.join(scratch, "home");
delete process.env.DATABASE_URL;
const originalCwd = process.cwd();
const store = await import("./store");
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

const AGENT = "0x5555555555555555555555555555555555555555";
const OTHER = "0x6666666666666666666666666666666666666666";
const COIN = "TA151B4A9E1B";

test("AN EXIT WRITTEN AFTER THE TAPE FORGOT THE COIN IS NAMED BY WHAT THE BUY CALLED IT", async () => {
  await store.addDecision({ id: "buy-named", agent_id: AGENT, source: "brain", symbol: COIN, action: "buy", display_name: "CASHCAT" });
  // Another agent calls the same id something else. It must never leak across.
  await store.addDecision({ id: "other-named", agent_id: OTHER, source: "brain", symbol: COIN, action: "buy", display_name: "IMPOSTOR" });
  // The tape has nothing for it any more — the caller's own lookup came back null.
  assert.equal(await store.displayNameFor(AGENT, COIN, null), "CASHCAT");
  assert.equal(await store.displayNameFor(OTHER, COIN, null), "IMPOSTOR");
});

test("the tape's own name wins when it has one", async () => {
  assert.equal(await store.displayNameFor(AGENT, COIN, "CASHCAT2"), "CASHCAT2");
});

test("a coin nobody named stays unnamed, and a stock is never looked up", async () => {
  assert.equal(await store.displayNameFor(AGENT, "TFFFFFFFFFFF", null), null);
  // A stock's name is its ticker. Even a (malformed) named row for it must not
  // turn "TSLA" into something else: the lookup is only for address-derived ids.
  await store.addDecision({ id: "stock-named", agent_id: AGENT, source: "brain", symbol: "TSLA", action: "hold", display_name: "Tesla" });
  assert.equal(await store.displayNameFor(AGENT, "TSLA", null), null);
});
