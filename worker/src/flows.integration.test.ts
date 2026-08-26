/**
 * Capital is not profit — proven against a real sqlite file.
 *
 * The bug these pin cost a real owner real money. equity was a bare balance
 * reading with no flow term, so a deposit was arithmetically indistinguishable
 * from a gain: /pnl reported +999.48 on a book that was down 0.52, and the
 * performance fee charged the owner on their own principal. The one mitigation
 * that existed fired only while the high-water mark was still zero, so it fixed
 * the FIRST deposit and no other.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-flows-"));
process.env.MERRYMEN_HOME = HOME;

const {
  initStore,
  addFlow,
  addEquity,
  adjustAgentHwm,
  ensureAgent,
  getAgentFinancials,
  getNetContributionsUsdg,
  listFlows,
  setAgentStatus,
} = await import("./store");
const { accrueAboveHwm } = await import("./fees");
const { readPnl } = await import("./telegram/reads");
const { homePaths } = await import("./home");
const { DatabaseSync } = await import("node:sqlite");

/**
 * ensureHome copies a legacy <repo>/.data ledger into a fresh home, so a
 * throwaway MERRYMEN_HOME does NOT start empty when run from a checkout that
 * still has one — it starts with somebody's July trading history, and every
 * "which agent is current" assertion below would answer with theirs. Clear the
 * tables these tests reason about so the fixture is the fixture.
 */
function clearLedger(): void {
  const db = new DatabaseSync(homePaths.db());
  for (const table of ["agents", "equity", "flows", "trades", "fee_accruals"]) {
    try {
      db.exec(`DELETE FROM ${table}`);
    } catch {
      /* table may not exist on a pre-migration copy */
    }
  }
  db.close();
}

const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";

const usdg = (v: number) => BigInt(Math.round(v * 1e6));

function grant(smartAccount: string) {
  return {
    smartAccount,
    owner: "0x00000000000000000000000000000000000000ff",
    sessionKeyAddress: "0x00000000000000000000000000000000000000fe",
    chainId: 46630,
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantedAt: 1_700_000_000,
    expiresAt: 1_800_000_000,
  } as unknown as Parameters<typeof ensureAgent>[0];
}

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup is best-effort */
  }
});

describe("the flow ledger", () => {
  it("nets deposits against withdrawals", async () => {
    initStore();
    clearLedger();
    await ensureAgent(grant(A));
    await addFlow({ agentId: A, direction: "in", amountUsdg: 1000, source: "inferred" });
    await addFlow({ agentId: A, direction: "out", amountUsdg: 250, source: "transfer-intent", txHash: "0xabc" });
    assert.equal(await getNetContributionsUsdg(A), 750);
  });

  it("keeps one agent's capital out of another's", async () => {
    await ensureAgent(grant(B));
    await addFlow({ agentId: B, direction: "in", amountUsdg: 4242, source: "inferred" });
    assert.equal(await getNetContributionsUsdg(A), 750);
    assert.equal(await getNetContributionsUsdg(B), 4242);
  });

  it("records how it knows, because the three sources are not equal evidence", async () => {
    const rows = await listFlows(A);
    const bySource = Object.fromEntries(rows.map((r) => [r.source, r.tx_hash]));
    assert.equal(bySource["transfer-intent"], "0xabc"); // ours, signed, on chain
    assert.equal(bySource["inferred"], null); // guesswork carries no tx, and says so
  });
});

describe("a deposit is never profit (the fee regression)", () => {
  it("the exact July sequence accrues ZERO fee: 154.87 seed, then +1000, then +500", async () => {
    // Before the flow ledger this booked PROFIT 1000 / FEE 100 on the second
    // deposit and PROFIT 500 / FEE 50 on the third — 150 USDG of fees taken on
    // an account that had never placed a trade.
    let hwm = 0n;
    let fees = 0n;
    for (const deposit of [154.87, 1000, 500]) {
      // The flow moves the mark it will be judged against, BEFORE judgement.
      hwm += usdg(deposit);
      const equity = hwm; // funded, nothing traded, nothing earned
      const accrual = accrueAboveHwm(equity, hwm, 1_000); // 10%
      fees += accrual.feeUsdg;
      hwm = accrual.newHwmUsdg;
    }
    assert.equal(fees, 0n);
    assert.equal(hwm, usdg(1654.87));
  });

  it("still charges on money the agent actually made", async () => {
    // 1000 in, then genuinely worth 1100 → fee on the 100, not on the 1000.
    const hwm = usdg(1000);
    const accrual = accrueAboveHwm(usdg(1100), hwm, 1_000);
    assert.equal(accrual.profitUsdg, usdg(100));
    assert.equal(accrual.feeUsdg, usdg(10));
  });

  it("a withdrawal lowers the mark, so taking profit home is not a drawdown", async () => {
    await ensureAgent(grant(A));
    await adjustAgentHwm(A, 1654.87);
    await adjustAgentHwm(A, -1000);
    const { hwmUsdg } = await getAgentFinancials(A);
    assert.ok(Math.abs(hwmUsdg - 654.87) < 1e-6, `hwm was ${hwmUsdg}`);

    // The breaker measures equity against this mark. Left at 1654.87 against an
    // equity of 654.87 it reads a 60% drawdown and trips — on an account whose
    // owner simply took their money home.
    const drawdownBps = Number(((usdg(654.87) - usdg(654.87)) * 10_000n) / usdg(654.87));
    assert.equal(drawdownBps, 0);
  });

  it("the mark floors at zero — a withdrawal cannot drive it negative", async () => {
    await adjustAgentHwm(A, -99_999);
    const { hwmUsdg } = await getAgentFinancials(A);
    assert.equal(hwmUsdg, 0);
  });
});

describe("readPnl reports the agent's own money", () => {
  it("subtracts what was put in, rather than calling it profit", async () => {
    // The real shape of the July ledger: money in, worth 999.48 now.
    await setAgentStatus(A, "armed"); // the armed agent is the one being reported on
    await addEquity(A, { ethWei: 0n, cashUsdg: 700, vaultUsdg: 0, positionsUsdg: 299.480778 });
    // B is funded and marked to a very different number in the same tables.
    await addEquity(B, { ethWei: 0n, cashUsdg: 50_000, vaultUsdg: 0, positionsUsdg: 0 });

    const out = readPnl();
    // The headline is equity MINUS capital: 999.48 − 750 = 249.48. It used to be
    // last-minus-first over every agent's rows at once, which on this fixture
    // would report the whole bankroll — and B's 50,000 alongside it.
    assert.match(out, /change: \$249\.48/);
    assert.doesNotMatch(out, /change: \$999\.48/);
    assert.doesNotMatch(out, /50,?000/);
    assert.match(out, /you put in \$750\.00/);
  });
});
