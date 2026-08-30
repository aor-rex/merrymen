import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVITY_GATE,
  ACTIVITY_CHUNK_BLOCKS,
  MAX_ACTIVITY_BLOCKS,
  PONS_BUY_TOPIC,
  PONS_SELL_TOPIC,
  isActive,
  tallyActivity,
  type ActivityLog,
} from "./pons-activity";

/**
 * The funnel that makes the launchpad affordable.
 *
 * ~940 launches an hour is too many for an LLM, a page fetch, or a dashboard
 * row. The measured signal is TRADING — 25 trades in the first 180s keeps 12.6%
 * of launches and holds 96% of the ones that go on to graduate. What sounds
 * good and is not: a dev buy (1.1x), having socials (1.0x), the creator's
 * history (1.3x).
 */

const CURVE_A = "0x00000000000000000000000000000000000000a1";
const CURVE_B = "0x00000000000000000000000000000000000000b2";
const who = (n: number) => `0x${"0".repeat(24)}${String(n).padStart(40, "0")}`;

const log = (curve: string, topic: string, trader: number, tx = "0x1"): ActivityLog => ({
  address: curve,
  topics: [topic, who(trader)],
  transactionHash: tx,
});

describe("tallyActivity", () => {
  it("counts buys and sells per curve", () => {
    const t = tallyActivity([
      log(CURVE_A, PONS_BUY_TOPIC, 1),
      log(CURVE_A, PONS_BUY_TOPIC, 2),
      log(CURVE_A, PONS_SELL_TOPIC, 1),
      log(CURVE_B, PONS_BUY_TOPIC, 3),
    ]);
    assert.equal(t.get(CURVE_A)!.buys, 2);
    assert.equal(t.get(CURVE_A)!.sells, 1);
    assert.equal(t.get(CURVE_B)!.buys, 1);
  });

  it("counts distinct TRADERS from the event, not transactions", () => {
    // The correction that matters. An earlier version counted distinct
    // transactions, on the assumption the event carried no sender — it carries
    // one in topic1 — and since every trade is its own transaction, that proxy
    // read 1,825 trades as 1,822 "traders". It tracked the very thing it was
    // meant to discriminate against.
    const oneWhaleManyTrades = Array.from({ length: 50 }, (_, i) =>
      log(CURVE_A, PONS_BUY_TOPIC, 7, `0x${i}`),
    );
    const t = tallyActivity(oneWhaleManyTrades);
    assert.equal(t.get(CURVE_A)!.buys, 50);
    assert.equal(t.get(CURVE_A)!.traders, 1, "fifty trades from one address is one participant");
  });

  it("counts someone who bought AND sold once", () => {
    const t = tallyActivity([log(CURVE_A, PONS_BUY_TOPIC, 1), log(CURVE_A, PONS_SELL_TOPIC, 1)]);
    assert.equal(t.get(CURVE_A)!.traders, 1);
  });

  it("is case-insensitive about addresses on both sides", () => {
    const t = tallyActivity([
      { address: CURVE_A.toUpperCase(), topics: [PONS_BUY_TOPIC, who(5).toUpperCase()], transactionHash: "0x1" },
      log(CURVE_A, PONS_BUY_TOPIC, 5),
    ]);
    assert.equal(t.size, 1, "one curve, however it was cased");
    assert.equal(t.get(CURVE_A)!.traders, 1, "one trader, however it was cased");
  });

  it("ignores every other event a curve emits", () => {
    const t = tallyActivity([log(CURVE_A, "0xdeadbeef", 1), log(CURVE_A, PONS_BUY_TOPIC, 1)]);
    assert.equal(t.get(CURVE_A)!.buys, 1);
  });

  it("survives a log with no trader topic", () => {
    const t = tallyActivity([{ address: CURVE_A, topics: [PONS_BUY_TOPIC], transactionHash: "0x1" }]);
    assert.equal(t.get(CURVE_A)!.buys, 1);
    assert.equal(t.get(CURVE_A)!.traders, 0, "counted the trade, claimed no trader");
  });
});

describe("isActive", () => {
  const busy = { curve: CURVE_A, buys: 30, sells: 5, traders: 20 };

  it("admits a curve real people are trading", () => {
    assert.equal(isActive(busy), true);
  });

  it("refuses a curve NOBODY has touched", () => {
    // Absent is a no, not a maybe. 19.3% of launches have zero trades at 60s
    // and none of them ever graduated.
    assert.equal(isActive(undefined), false);
    assert.equal(isActive({ curve: CURVE_A, buys: 0, sells: 0, traders: 0 }), false);
  });

  it("refuses volume manufactured by a handful of addresses", () => {
    // The shape the trader count exists to catch: plenty of trades, almost
    // nobody behind them.
    assert.equal(isActive({ curve: CURVE_A, buys: 300, sells: 0, traders: 2 }), false);
  });

  it("refuses a thin tape however many addresses touched it", () => {
    assert.equal(isActive({ curve: CURVE_A, buys: 4, sells: 0, traders: 4 }), false);
  });

  it("takes a tighter gate when the step downstream is expensive", () => {
    // 100 trades is a 16.9x lift at 4.4% kept — the right setting when what
    // follows costs real money or real tokens.
    assert.equal(isActive(busy, { minTrades: 100, minTraders: 3 }), false);
  });
});

describe("the window ceiling", () => {
  it("stays inside the node's 10,000-log cap", () => {
    // MEASURED, not assumed: 1,800 blocks returns 1,668 logs and 5,000 returns
    // 4,159, so the cap arrives around 12,000. Over it the node ERRORS, which
    // reads as "nothing traded" to anyone not checking — the failure this bound
    // exists to prevent, and one that already happened once here.
    assert.ok(MAX_ACTIVITY_BLOCKS <= 12_000n);
    assert.ok(MAX_ACTIVITY_BLOCKS >= 3_000n, "but wide enough to see a launch's first minutes");
  });

  it("pins the gate at the measured sweet spot", () => {
    assert.equal(ACTIVITY_GATE.minTrades, 25);
    assert.equal(ACTIVITY_GATE.minTraders, 3);
  });
});

/**
 * THE 10,000-LOG CAP IS THE FAILURE THAT ACTUALLY ARRIVED.
 *
 * This query asks the node for BOTH sides of every curve trade on the chain
 * with no address filter, which is what makes it affordable — and what makes it
 * collide with the node's cap on a response. Measured against mainnet on
 * 2026-08-30 over the 9,000-block window this module asks for:
 *
 *     launches          233 logs   fine
 *     buys only       6,024 logs   fine
 *     buys + sells      OVER CAP   -32000 "logs matched by query exceeds limit of 10000"
 *
 * The whole funnel then went empty and the page announced that nothing had
 * launched — on a launchpad doing roughly 940 an hour. It is deterministic
 * above a level of activity, so it arrives for good the day the chain gets
 * busy, and the earlier calibration that picked 9,000 was measured on the
 * buys-only half.
 *
 * The window is deliberately NOT shrunk to fix it: `ACTIVITY_GATE` counts trades
 * absolutely over the window, so halving the window silently tightens the gate
 * about twofold and changes which launches the page is even about. Chunking
 * keeps the window and the gate's calibration intact, because `tallyActivity`
 * merges per curve and dedupes traders through a Set — chunked input gives
 * byte-identical output to one query.
 */
describe("the activity sweep survives a busy launchpad", () => {
  it("splits the window into chunks well under the node's cap", () => {
    assert.ok(ACTIVITY_CHUNK_BLOCKS > 0n);
    assert.ok(
      ACTIVITY_CHUNK_BLOCKS <= MAX_ACTIVITY_BLOCKS / 2n,
      "a chunk must be meaningfully smaller than the window, or it is not chunking",
    );
    // At the measured rate (~6,024 buy logs per 9,000 blocks, and sells on top)
    // a 3,000-block chunk sits at roughly a third of the cap.
    assert.ok(ACTIVITY_CHUNK_BLOCKS <= 3_000n, "measured headroom needs chunks of 3,000 blocks or less");
  });

  it("keeps the full window — the gate is calibrated against it", () => {
    // 25 trades and 3 traders is an ABSOLUTE count over the window. Shrinking
    // the window would tighten the gate without anyone deciding to.
    assert.equal(MAX_ACTIVITY_BLOCKS, 9_000n);
    assert.equal(ACTIVITY_GATE.minTrades, 25);
    assert.equal(ACTIVITY_GATE.minTraders, 3);
  });

  it("chunked input tallies identically to one query", () => {
    // The property that makes chunking safe rather than merely smaller.
    const logs = [
      log(CURVE_A, PONS_BUY_TOPIC, 1, "0xa"),
      log(CURVE_A, PONS_BUY_TOPIC, 2, "0xb"),
      log(CURVE_A, PONS_SELL_TOPIC, 1, "0xc"),
      log(CURVE_B, PONS_BUY_TOPIC, 1, "0xd"),
    ];
    const whole = tallyActivity(logs);
    const chunked = tallyActivity([...logs.slice(0, 2), ...logs.slice(2)]);
    assert.deepEqual(
      [...whole.entries()].map(([k, v]) => [k, v.buys, v.sells, v.traders]),
      [...chunked.entries()].map(([k, v]) => [k, v.buys, v.sells, v.traders]),
    );
    // And a trader seen in two chunks is still ONE trader.
    assert.equal(whole.get(CURVE_A)!.traders, 2);
  });
});
