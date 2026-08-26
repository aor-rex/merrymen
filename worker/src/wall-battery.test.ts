import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CASH,
  GRANT_V4,
  STOCK_TOKENS,
  TRADEABLE_V2,
  type StoredGrant,
} from "../../packages/core/src/index";
import { limitsFromGrant } from "./limits";
import { runWallBattery } from "./wall-battery";

const NOW = 1_800_000_000;
const PRIVATE_KEY = `0x${"11".repeat(32)}` as `0x${string}`;

function grant(grantFeatures: string[]): StoredGrant {
  return {
    smartAccount: "0x0000000000000000000000000000000000000001",
    owner: "0x0000000000000000000000000000000000000002",
    sessionKeyAddress: "0x0000000000000000000000000000000000000003",
    serialized: "test-only",
    caps: {
      perTradeUsdg: 25,
      dailyUsdg: 100,
      expiryDays: 14,
      maxDrawdownPct: 15,
      maxOpsPerDay: 4,
    },
    grantedAt: NOW - 100,
    expiresAt: NOW + 100,
    chainId: 46630,
    grantFeatures,
    demoSessionPrivateKey: PRIVATE_KEY,
  };
}

describe("runWallBattery", () => {
  for (const [name, features] of [
    ["legacy", ["transfer"]],
    ["pre-allowlist", ["transfer", TRADEABLE_V2, GRANT_V4]],
    // WHAT BOTH SIGNERS ACTUALLY MINT TODAY — no "transfer" marker, because
    // neither registers a withdrawal address and so the wall carries no
    // transfer permission to claim. Its absence here is what let the battery's
    // first case go stale unnoticed: every fixture carried the marker, the
    // suite stayed green, and the dashboard printed "⚠ BREACH" for a real grant
    // on a wall that had just got STRICTER. A battery whose fixtures are all
    // legacy is a battery that tests the past.
    ["modern", [TRADEABLE_V2, "multihop"]],
  ] as const) {
    it(`holds every exact rule for an unexpired ${name} grant`, () => {
      const result = runWallBattery(grant([...features]), NOW);
      assert.equal(result.allHeld, true);
      assert.equal(result.cases.length, 10);
      assert.deepEqual(
        result.cases.map((entry) => entry.rule ?? "approved"),
        [
          // The prompt-injected transfer. A pre-allowlist grant carries a
          // free-form transfer permission and is stopped by the cap; a grant
          // signed today has no transfer permission at all and is stopped
          // earlier and harder. Both are the wall holding — and this line is
          // exactly what the battery has to get right, because reporting the
          // wrong rule here reads as a BREACH on the dashboard.
          (features as readonly string[]).includes("transfer") ? "per-trade-cap" : "transfer-not-permitted",
          "per-trade-cap",
          "target-allowlist",
          "asset-allowlist",
          "daily-cap",
          "ops-cap",
          "expiry",
          "drawdown-breaker",
          "approved",
          "no-exit",
        ],
      );
      assert.ok(result.cases.every((entry) => entry.held));
    });
  }

  it("uses the requested watchlist as allowedAssets without widening sell permissions", () => {
    const aapl = STOCK_TOKENS.find((token) => token.symbol === "AAPL")!;
    const legacy = grant(["transfer"]);
    const limits = limitsFromGrant(legacy, [aapl]);

    assert.deepEqual(
      limits.allowedAssets.map((address) => address.toLowerCase()),
      [CASH.USDG.toLowerCase(), aapl.address.toLowerCase()],
    );
    assert.equal(
      limits.sellableAssets?.some((address) => address.toLowerCase() === aapl.address.toLowerCase()),
      false,
      "selecting AAPL must not pretend a legacy signature can sell it",
    );
  });
});
