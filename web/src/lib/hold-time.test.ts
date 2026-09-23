import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { averageHoldSec, holdWords, type HoldFill } from "./hold-time";

const buy = (coin: string, qty: bigint, at: number): HoldFill => ({ side: "buy", coin, qty, at });
const sell = (coin: string, qty: bigint, at: number): HoldFill => ({ side: "sell", coin, qty, at });

describe("average hold is FIFO round trips, and nothing else", () => {
  it("a sell closes the OLDEST open buy of its coin first", () => {
    // Bought at 0 and at 100, sold one lot at 1,000: FIFO says the lot from 0
    // closed, so the hold is 1,000 — LIFO would say 900.
    assert.equal(averageHoldSec([buy("CASH", 5n, 0), buy("CASH", 5n, 100), sell("CASH", 5n, 1_000)]), 1_000);
  });

  it("a sell larger than one lot reaches into the next, each piece one round trip", () => {
    // 10 sold at 1,000 closes both lots: holds 1,000 and 900, mean 950.
    assert.equal(averageHoldSec([buy("CASH", 5n, 0), buy("CASH", 5n, 100), sell("CASH", 10n, 1_000)]), 950);
  });

  it("a partial sell leaves the rest of the lot open for the next sell", () => {
    // Lot of 10 at 0; sells of 4 at 100 and 6 at 300 — both close the same lot.
    assert.equal(averageHoldSec([buy("X", 10n, 0), sell("X", 4n, 100), sell("X", 6n, 300)]), 200);
  });

  it("coins are paired only with themselves, case-insensitively", () => {
    // Selling CHUMP must close the CHUMP lot from 100, not the older CASH lot.
    assert.equal(averageHoldSec([buy("CASH", 1n, 0), buy("chump", 1n, 100), sell("CHUMP", 1n, 150)]), 50);
    // CHUMP 100, CASH 400.
    assert.equal(averageHoldSec([buy("CASH", 1n, 0), buy("chump", 1n, 50), sell("CHUMP", 1n, 150), sell("cash", 1n, 400)]), 250);
  });

  it("quantity decides which lots close, but never WEIGHTS the mean", () => {
    // Raw units across coins with different decimals are not comparable, so a
    // huge-unit memecoin must not drown a small-unit stock token.
    const meme = 10n ** 27n;
    assert.equal(averageHoldSec([buy("MEME", meme, 0), sell("MEME", meme, 100), buy("TSLA", 1n, 0), sell("TSLA", 1n, 900)]), 500);
  });

  it("no round trip is null, not zero", () => {
    assert.equal(averageHoldSec([]), null);
    assert.equal(averageHoldSec([buy("X", 1n, 0), buy("Y", 1n, 5)]), null, "buys alone never closed");
  });

  it("a sell with nothing open against it was bought before the period, and is left out", () => {
    // A carried-over position sold this period is not a round trip here.
    assert.equal(averageHoldSec([sell("OLD", 5n, 10)]), null);
    assert.equal(averageHoldSec([sell("OLD", 5n, 10), buy("X", 1n, 0), sell("X", 1n, 60)]), 60);
  });

  it("ANY unread input is a refusal, because FIFO is order-dependent", () => {
    const whole = [buy("X", 1n, 0), sell("X", 1n, 60)];
    assert.equal(averageHoldSec(whole), 60);
    assert.equal(averageHoldSec([...whole, { side: null, coin: "X", qty: 1n, at: 70 }]), null, "unknown side");
    assert.equal(averageHoldSec([...whole, { side: "sell", coin: null, qty: 1n, at: 70 }]), null, "unknown coin");
    assert.equal(averageHoldSec([...whole, { side: "buy", coin: "X", qty: null, at: 70 }]), null, "unknown quantity");
    assert.equal(averageHoldSec([...whole, { side: "buy", coin: "X", qty: 0n, at: 70 }]), null, "a zero fill is not a fill");
  });
});

describe("a hold in words", () => {
  it("uses the two largest units, and nothing for nothing", () => {
    assert.equal(holdWords(45), "45s");
    assert.equal(holdWords(12 * 60), "12m");
    assert.equal(holdWords(3 * 3600 + 20 * 60), "3h 20m");
    assert.equal(holdWords(3 * 3600), "3h");
    assert.equal(holdWords(2 * 86_400 + 4 * 3600), "2d 4h");
    assert.equal(holdWords(null), null);
    assert.equal(holdWords(Number.NaN), null);
  });
});
