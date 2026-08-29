import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ACTIVITY_GATE,
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
