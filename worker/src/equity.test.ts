import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookGaps, composeEquityUsdg, drawdownBps, pnlUsdg } from "./equity";

const usdg = (v: number) => BigInt(Math.round(v * 1e6));

describe("composeEquityUsdg — one definition, not two", () => {
  it("sums cash, vault, positions and quarantined cost", () => {
    const e = composeEquityUsdg({
      cashUsdg: usdg(700),
      vaultUsdg: usdg(100),
      positionsUsdg: usdg(199.48),
      quarantinedCostUsdg: usdg(25),
    });
    assert.equal(e, usdg(1024.48));
  });

  it("THE DIVERGENCE: dropping quarantined cost understates the book", () => {
    // The equity ROW used to re-derive cash + vault + positions while the fee
    // and the breaker were judged against a total that also included
    // quarantine — so the published curve sat permanently below the figure the
    // performance fee ratcheted on.
    const parts = {
      cashUsdg: usdg(700),
      vaultUsdg: 0n,
      positionsUsdg: usdg(200),
      quarantinedCostUsdg: usdg(50),
    };
    const whole = composeEquityUsdg(parts);
    const rowUsedToWrite = parts.cashUsdg + parts.vaultUsdg + parts.positionsUsdg;
    assert.equal(whole - rowUsedToWrite, usdg(50));
  });

  it("a scout buy is not an instant loss — cash out, cost carried", () => {
    // Cash leaves the wallet for a token we cannot yet price. Without the
    // quarantine term equity drops by the full spend and books a drawdown that
    // never happened.
    const before = composeEquityUsdg({ cashUsdg: usdg(1000), vaultUsdg: 0n, positionsUsdg: 0n, quarantinedCostUsdg: 0n });
    const after = composeEquityUsdg({ cashUsdg: usdg(950), vaultUsdg: 0n, positionsUsdg: 0n, quarantinedCostUsdg: usdg(50) });
    assert.equal(before, after);
  });
});

// The whole reporting path is float — `equity`, `flows` and `fee_accruals` are
// all REAL columns — so these compare within a cent rather than exactly. The
// bigint side of the house (basis, policy) is exact; this side is not, and
// pretending otherwise in a test would just make it flaky.
const near = (a: number | null, b: number) => assert.ok(a !== null && Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

describe("pnlUsdg — unknown is not zero", () => {
  it("subtracts capital from equity", () => {
    near(pnlUsdg(999.48, 1000), -0.52);
  });

  it("is NULL when contributions are unknown, never the bankroll", () => {
    // The regression in one line: equity minus nothing is what the account
    // holds, and reporting that as profit is the whole bug.
    assert.equal(pnlUsdg(999.48, null), null);
  });

  it("a withdrawal reduces contributions, so profit survives it", () => {
    // Put in 1000, took out 400, book worth 700 → made 100.
    near(pnlUsdg(700, 600), 100);
  });
});

describe("drawdownBps", () => {
  it("measures the fall from the mark", () => {
    assert.equal(drawdownBps(usdg(1000), usdg(900)), 1_000); // 10%
  });

  it("is zero at or above the mark", () => {
    assert.equal(drawdownBps(usdg(1000), usdg(1000)), 0);
    assert.equal(drawdownBps(usdg(1000), usdg(1200)), 0);
  });

  it("an unset mark is not a 100% drawdown", () => {
    assert.equal(drawdownBps(0n, usdg(500)), 0);
  });

  it("a withdrawal is NOT a drawdown once the mark has moved with it", () => {
    // 1000 in, owner takes 400 home. The mark moves to 600 with the capital, so
    // the book is flat — not 40% under water and tripping the breaker.
    assert.equal(drawdownBps(usdg(600), usdg(600)), 0);
  });
});

describe("bookGaps — an unknown must never be bookable", () => {
  it("is empty when everything read cleanly", () => {
    assert.deepEqual(bookGaps({ unreadBalances: [], positionsReadFailed: false, missingPrice: [] }), []);
  });

  it("names each kind of gap so the operator is told which", () => {
    assert.deepEqual(
      bookGaps({ unreadBalances: ["cash", "vault"], positionsReadFailed: true, missingPrice: ["NVDA"] }),
      ["cash", "vault", "positions", "NVDA"],
    );
  });

  it("a failed position read counts even though it reports no symbols", () => {
    // The silent case: three empty arrays used to look identical to "holds
    // nothing", so the tick wrote positionsUsdg = 0 for a held book.
    assert.deepEqual(
      bookGaps({ unreadBalances: [], positionsReadFailed: true, missingPrice: [] }),
      ["positions"],
    );
  });
});
