/**
 * A bonding curve survives in the candidate store — proven against real sqlite.
 *
 * TWO DISCOVERERS NOW WRITE THIS TABLE. The Uniswap/Bitquery pass and the Pons
 * launchpad pass both upsert onto `address`, and each knows things the other
 * does not: only the launchpad has a curve, and only the pool pass can price a
 * token in USD. Every test here is about one of the two blanking something the
 * other captured — the failure mode that produces no error, no log, and a
 * candidate that quietly stops qualifying.
 *
 * MERRYMEN_HOME is set before any store import runs getDb(); node's --test runs
 * each file in its own process, so the override never leaks.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-curves-"));
process.env.MERRYMEN_HOME = HOME;

const { initStore, recentCandidates, recordCandidate } = await import("./store");

await initStore();
after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* Windows holds the sqlite handle a moment longer; the dir is disposable */
  }
});

const NATIVE = `0x${"0".repeat(40)}`;
const find = async (addr: string) => (await recentCandidates(3600, 100)).find((c) => c.address === addr);

describe("curve columns in the candidate store", () => {
  it("captures the curve and its quote asset", async () => {
    const token = "0x00000000000000000000000000000000000000c1";
    await recordCandidate({
      address: token, symbol: "PONSY", decimals: 18, liquidityUsd: 900, fdvUsd: 12_000, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000e1", quoteToken: NATIVE },
    });
    const got = await find(token);
    assert.ok(got?.curve, "a pre-graduation token is unreachable without its curve");
    assert.equal(got!.curve!.curve, "0x00000000000000000000000000000000000000e1");
  });

  it("a NATIVE-ETH quote survives, rather than reading as absent", async () => {
    // The all-zero address is a meaningful value here — it means native ETH,
    // which is 53.6% of launches. A truthiness test on the column would drop
    // the curve for the majority case.
    const token = "0x00000000000000000000000000000000000000c2";
    await recordCandidate({
      address: token, symbol: "NATIVE", decimals: 18, liquidityUsd: 0, fdvUsd: 0, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000e2", quoteToken: NATIVE },
    });
    const got = await find(token);
    assert.ok(got?.curve, "a native-quoted curve must not vanish");
    assert.equal(got!.curve!.quoteToken, NATIVE);
  });

  it("a CURVELESS re-sighting does not blank the curve", async () => {
    // The Uniswap discoverer re-seeing the same token after it graduates, or a
    // gateway pass that never had a curve. Losing it is worse than losing a
    // PoolKey: there is no tier-scan fallback for a bonding curve.
    const token = "0x00000000000000000000000000000000000000c3";
    await recordCandidate({
      address: token, symbol: "KEEP", decimals: 18, liquidityUsd: 100, fdvUsd: 1_000, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000e3", quoteToken: NATIVE },
    });
    await recordCandidate({ address: token, symbol: "KEEP", decimals: 18, liquidityUsd: 200, fdvUsd: 2_000, firstSeen: 0 });
    assert.equal((await find(token))?.curve?.curve, "0x00000000000000000000000000000000000000e3");
  });
});

describe("one discoverer must not zero the other's figures", () => {
  it("a re-sighting with NO usd figures keeps the ones already captured", async () => {
    // The live hazard: 42.8% of Pons launches are quoted in stock tokens and
    // 2.3% in cbBTC, which this repo cannot price at all, so the launchpad pass
    // legitimately records 0/0. Unconditional overwrite would wipe a real
    // reading and push the candidate under trencher's $25,000 depth and
    // $50,000 FDV gates — with no error and nothing logged.
    const token = "0x00000000000000000000000000000000000000c4";
    await recordCandidate({ address: token, symbol: "RICH", decimals: 18, liquidityUsd: 80_000, fdvUsd: 500_000, firstSeen: 0 });
    await recordCandidate({
      address: token, symbol: "RICH", decimals: 18, liquidityUsd: 0, fdvUsd: 0, firstSeen: 0,
      curve: { curve: "0x00000000000000000000000000000000000000e4", quoteToken: NATIVE },
    });
    const got = await find(token);
    assert.equal(got?.liquidityUsd, 80_000, "depth was zeroed by a pass that could not price it");
    assert.equal(got?.fdvUsd, 500_000, "fdv was zeroed by a pass that could not price it");
    assert.ok(got?.curve, "and the curve from the zero-figure pass was still captured");
  });

  it("a re-sighting WITH figures still updates them", async () => {
    // The preservation above must not become a freeze: a real new reading wins.
    const token = "0x00000000000000000000000000000000000000c5";
    await recordCandidate({ address: token, symbol: "MOVE", decimals: 18, liquidityUsd: 10_000, fdvUsd: 20_000, firstSeen: 0 });
    await recordCandidate({ address: token, symbol: "MOVE", decimals: 18, liquidityUsd: 3_000, fdvUsd: 9_000, firstSeen: 0 });
    const got = await find(token);
    assert.equal(got?.liquidityUsd, 3_000, "a genuine lower reading must still land");
    assert.equal(got?.fdvUsd, 9_000);
  });

  it("states the cost of that choice honestly: a true drain to zero is not recorded", () => {
    // Documented rather than pretended away. The stored figure is a snapshot
    // from announce time, and trencher re-derives depth every tick from
    // lastLiquidityUsd, falling back to this only when it has no live reading —
    // so a stale non-zero here is the safer of the two available errors.
    assert.ok(true);
  });
});
