/**
 * THE SECOND GATE, RUN RATHER THAN READ.
 *
 * Between the route that validated an owner's order and the code that signs
 * it, the order crossed a shared table, an orchestrator that can see every
 * tenant's home, and a JSON file. This gate is the one standing between a
 * string and a signed UserOperation. It used to live inline in main(), where
 * nothing could run it, and was pinned by reading the source — so the one
 * refusal a between-tick order depends on (a book this tick could not value)
 * could be deleted and every test stayed green.
 *
 * Every test here hands placeOrder a submitter that records being called: a
 * refusal is only a refusal if nothing reached it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chatOrderGate, orderReadsOf, placeOrder, tickReads, type OrderReads } from "./order-gate";

const READ: OrderReads = { marketUnreadable: false, bookUnreadable: false, equityKnown: true, paused: false, ceilingUsdg: 0 };
const BUY = { side: "buy", symbol: "TSLA", usdgAmount: 5 };
const SELL = { side: "sell", symbol: "TSLA", usdgAmount: 5 };

/** Run the gate with a submitter that records every call. */
async function place(args: Record<string, unknown> | undefined, reads: Partial<OrderReads> = {}) {
  const sent: { side: string; symbol: string; size: number }[] = [];
  const reply = await placeOrder(args, { ...READ, ...reads }, async (side, symbol, size) => {
    sent.push({ side, symbol, size });
    return { ok: true, line: "submitted" };
  });
  return { reply, sent };
}

/** A refusal: ok false, the sentence, and nothing sent. */
async function refused(args: Record<string, unknown> | undefined, reads: Partial<OrderReads>, line: RegExp) {
  const { reply, sent } = await place(args, reads);
  assert.equal(reply.ok, false);
  assert.match(reply.line, line);
  assert.deepEqual(sent, [], "a refusal is only a refusal if nothing reached the submitter");
}

describe("an order is never placed on numbers this tick could not read", () => {
  it("AN UNREADABLE MARKET REFUSES IT BY NAME — the breaker would be judging nothing", async () => {
    await refused(BUY, { marketUnreadable: true }, /I could not read the market this tick, so I did not place it/);
    await refused(SELL, { marketUnreadable: true }, /fact about my reads, not about your order/);
  });

  it("AN UNREAD BOOK REFUSES IT BY NAME — the order is never filled against the previous tick's equity", async () => {
    // The command tick's unread-book and unpriced-holding returns drain with
    // this flag set. Without the refusal the order fills against the equity
    // the PREVIOUS tick left behind: the forbidden "drain without re-reading".
    await refused(BUY, { bookUnreadable: true }, /I could not value your book this tick, so I did not place it/);
    await refused(SELL, { bookUnreadable: true }, /could not value your book/);
  });

  it("the reads come first — before the pause, and before the arguments are even looked at", async () => {
    await refused({ side: "yolo" }, { marketUnreadable: true, paused: true }, /could not read the market/);
    await refused({ side: "yolo" }, { bookUnreadable: true, paused: true }, /could not value your book/);
  });

  it("A BUY WITH THE BOOK UNTOTALLED IS REFUSED — checkPolicy would skip the drawdown breaker for it", async () => {
    // equityKnown is false when a holding has neither a price nor a cost on
    // record. policy.ts then runs the breaker only `if (state.equityKnown !==
    // false)`, so the buy would go out with the loss limit switched off.
    await refused(BUY, { equityKnown: false }, /I did not place it[\s\S]*the drawdown limit can't judge a buy/);
    await refused(BUY, { equityKnown: false }, /Selling still works/);
  });

  it("BUT A SELL STILL GOES THROUGH — exits are exempt from the breaker, and the owner can always get out", async () => {
    const { reply, sent } = await place(SELL, { equityKnown: false });
    assert.equal(reply.ok, true);
    assert.deepEqual(sent, [{ side: "sell", symbol: "TSLA", size: 5 }]);
  });
});

describe("pause is the owner's stop button", () => {
  it("A PAUSED AGENT PLACES NOTHING", async () => {
    await refused(BUY, { paused: true }, /you have me paused, so I did not place it/);
    await refused(SELL, { paused: true }, /Un-pause and ask again/);
  });
});

describe("what an argument may be, proved a second time", () => {
  it("A SIDE IS BUY OR SELL", async () => {
    await refused({ ...BUY, side: "yolo" }, {}, /'yolo' is not a buy or a sell/);
    await refused({ ...BUY, side: undefined }, {}, /is not a buy or a sell/);
    await refused(undefined, {}, /is not a buy or a sell/);
  });

  it("A SYMBOL IS A SHORT TICKER, not a sentence or a path", async () => {
    await refused({ ...BUY, symbol: "../../x" }, {}, /is not a symbol I can look up/);
    await refused({ ...BUY, symbol: "ABCDEFGHIJKLM" }, {}, /is not a symbol I can look up/);
    await refused({ ...BUY, symbol: 7 }, {}, /is not a symbol I can look up/);
    const { sent } = await place({ ...BUY, symbol: "  tsla " });
    assert.deepEqual(sent, [{ side: "buy", symbol: "TSLA", size: 5 }], "trimmed and upper-cased, as the watch set is keyed");
  });

  it("A SIZE IS FINITE AND POSITIVE — NaN and Infinity die before usdg() turns them into a throw", async () => {
    for (const usdgAmount of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, "lots", undefined]) {
      await refused({ ...BUY, usdgAmount }, {}, /is not an amount I can trade/);
    }
    const { sent } = await place({ ...BUY, usdgAmount: "2.5" });
    assert.deepEqual(sent, [{ side: "buy", symbol: "TSLA", size: 2.5 }], "a numeric string from the file is read as its number");
  });

  it("THE OWNER'S OWN CEILING ON A TYPED ORDER HOLDS HERE TOO", async () => {
    await refused({ ...BUY, usdgAmount: 26 }, { ceilingUsdg: 25 }, /26 USDG is over your 25 USDG limit for a chat order/);
    assert.equal((await place({ ...BUY, usdgAmount: 25 }, { ceilingUsdg: 25 })).reply.ok, true, "at the ceiling is allowed");
    assert.equal((await place({ ...BUY, usdgAmount: 10_000 }, { ceilingUsdg: 0 })).reply.ok, true, "no ceiling set is no ceiling");
  });
});

describe("an order that passes every gate is handed on exactly as validated", () => {
  it("side, symbol and size reach the submitter once, and its reply comes back untouched", async () => {
    const reply = { ok: true, line: "bought 5.00 USDG of TSLA", verdict: { kind: "no-row" as const } };
    let calls = 0;
    const out = await placeOrder(BUY, READ, async (side, symbol, size) => {
      calls += 1;
      assert.deepEqual([side, symbol, size], ["buy", "TSLA", 5]);
      return reply;
    });
    assert.equal(calls, 1);
    assert.equal(out, reply);
  });
});

/**
 * EVERY DRAIN SAYS WHAT ITS TICK READ.
 *
 * runQueuedCommand, runCommand and runOrderCommand took the two read flags as
 * positional booleans defaulting to false, so a drain site that dropped them
 * still typechecked — and an order drained on a tick that could not value the
 * book was judged against the PREVIOUS tick's equity, which the doNotDo list
 * forbids by name. And the order's equityKnown was a literal read off a global
 * beside them. The tick now hands its reads over whole, built here, and none is
 * defaulted: a drain that states nothing does not compile.
 */
describe("every drain states what its tick read", () => {
  const OWNER = { paused: false, ceilingUsdg: 0 };
  /** placeOrder, fed the reads a drain site builds. */
  const drained = async (args: Record<string, unknown>, tick: ReturnType<typeof tickReads.composed>, owner = OWNER) => {
    const sent: string[] = [];
    const reply = await placeOrder(args, orderReadsOf(tick, owner), async (side) => {
      sent.push(side);
      return { ok: true, line: "submitted" };
    });
    return { reply, sent };
  };

  it("A TICK THAT COULD NOT READ THE MARKET REFUSES THE ORDER BY NAME — a buy and a sell alike", async () => {
    for (const args of [BUY, SELL]) {
      const { reply, sent } = await drained(args, tickReads.marketUnread());
      assert.match(reply.line, /I could not read the market this tick/);
      assert.deepEqual(sent, []);
    }
  });

  it("A TICK THAT COULD NOT VALUE THE BOOK REFUSES IT BY NAME — never judged on the last tick's equity", async () => {
    for (const args of [BUY, SELL]) {
      const { reply, sent } = await drained(args, tickReads.bookUnread());
      assert.match(reply.line, /I could not value your book this tick/);
      assert.deepEqual(sent, []);
    }
  });

  it("A TICK THAT READ THE BOOK BUT COULD NOT TOTAL IT REFUSES A BUY, AND PLACES A SELL", async () => {
    const buy = await drained(BUY, tickReads.composed(false));
    assert.match(buy.reply.line, /the drawdown limit can't judge a buy/);
    assert.deepEqual(buy.sent, []);
    const sell = await drained(SELL, tickReads.composed(false));
    assert.deepEqual(sell.sent, ["sell"]);
  });

  it("a tick that totalled its book places the order", async () => {
    assert.deepEqual((await drained(BUY, tickReads.composed(true))).sent, ["buy"]);
  });

  it("the owner's pause and ceiling ride along with the tick's reads, unchanged", async () => {
    assert.match((await drained(BUY, tickReads.composed(true), { paused: true, ceilingUsdg: 0 })).reply.line, /you have me paused/);
    assert.match(
      (await drained({ ...BUY, usdgAmount: 26 }, tickReads.composed(true), { paused: false, ceilingUsdg: 25 })).reply.line,
      /over your 25 USDG limit/,
    );
  });
});

/**
 * ONE GATE FOR THE APP AND FOR TELEGRAM.
 *
 * The "buy with the book untotalled" refusal lived only in placeOrder, which
 * only an app order reaches. A buy typed in Telegram went straight to
 * submitChatTrade, which hands lastEquityKnown to checkPolicy — and when that
 * is false the drawdown breaker is skipped. submitChatTrade now asks
 * chatOrderGate first, so the app, Telegram and Brain orders all meet it.
 */
describe("one gate for an order, whoever placed it", () => {
  it("A TELEGRAM BUY WITH THE BOOK UNTOTALLED IS REFUSED WITH THE APP ORDER'S OWN SENTENCE", async () => {
    const app = await place(BUY, { equityKnown: false });
    assert.equal(app.reply.ok, false);
    assert.equal(chatOrderGate("buy", { equityUsdg: 100_000_000n, equityKnown: false }), app.reply.line);
  });

  it("BUT A SELL STILL GOES THROUGH — the owner can always get out of the holding that untotals the book", () => {
    assert.equal(chatOrderGate("sell", { equityUsdg: 100_000_000n, equityKnown: false }), null);
  });

  it("with the book totalled nothing is refused here — the wall judges the rest", () => {
    assert.equal(chatOrderGate("buy", { equityUsdg: 100_000_000n, equityKnown: true }), null);
    assert.equal(chatOrderGate("sell", { equityUsdg: 100_000_000n, equityKnown: true }), null);
  });

  it("BEFORE THE FIRST TICK HAS READ THE BOOK, NOTHING IS PLACED — a buy or a sell", () => {
    // Equity is still its 0n initialiser, and the breaker would judge garbage.
    for (const side of ["buy", "sell"] as const) {
      assert.match(chatOrderGate(side, { equityUsdg: 0n, equityKnown: true }) ?? "", /still saddling up \(first tick pending\)/);
    }
  });
});
