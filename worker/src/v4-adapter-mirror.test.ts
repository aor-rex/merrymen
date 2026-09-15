import assert from "node:assert/strict";
import test from "node:test";
import { limitsFromGrant } from "./limits";
import { checkPolicy, type AgentState, type TradeIntent } from "./policy";
import {
  CASH,
  GRANT_V4_ADAPTER,
  RIALTO,
  UNISWAP,
  buildCallPermissions,
  usdgUnits,
  type GrantCaps,
  type StoredGrant,
} from "../../packages/core/src/index";

/**
 * THE ADAPTER MIRROR — both halves asserted against each other, the
 * transfer-mirror idiom.
 *
 * The rule runs in both directions and this file holds both. LOOSER than the
 * chain (the transfer saga): a mirror that admits a target the wall refuses
 * makes the worker build UserOps the account contract rejects — gas spent to
 * be told no. STRICTER than the chain (the multihop bug's silent sibling): a
 * mirror missing a target the wall grants kills a correctly-signed route
 * off-chain at `target-allowlist`, and nothing ever fires — a route that
 * looks granted and silently is not.
 *
 * The load-bearing choice under test: limits mirror the GRANT-SEALED address
 * via grantV4Adapter (marker AND address), never settings. Settings feed the
 * signers; the grant is the record of what was actually signed.
 */

const ADAPTER = "0x00000000000000000000000000000000000000d4" as const;
const CAPS: GrantCaps = { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 };
const SELF = "0x00000000000000000000000000000000000000a9" as const;

const grantWith = (over: Partial<StoredGrant>): StoredGrant =>
  ({
    smartAccount: SELF,
    owner: "0x00000000000000000000000000000000000000b1",
    sessionKeyAddress: "0x00000000000000000000000000000000000000c1",
    serialized: "x",
    caps: CAPS,
    grantedAt: 1_800_000_000,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    chainId: 4663,
    grantFeatures: ["tradeable-v2", "multihop"],
    ...over,
  }) as unknown as StoredGrant;

const CALM: AgentState = {
  spentTodayUsdg: 0n,
  opsToday: 0,
  equityUsdg: 1_000_000_000n,
  highWaterMarkUsdg: 1_000_000_000n,
  nowSec: Math.floor(Date.now() / 1000),
};

/** A buy routed AT the adapter — the shape the execution path will submit. */
const adapterBuy = (target: `0x${string}`): TradeIntent => ({
  kind: "swap",
  target,
  sellToken: CASH.USDG as `0x${string}`,
  buyToken: (limitsFromGrant(grantWith({})).allowedAssets[1] ?? CASH.USDG) as `0x${string}`,
  sellAmountRaw: usdgUnits(10),
  notionalUsdg: usdgUnits(10),
});

test("marker + sealed address: the wall grants it AND the mirror admits it", () => {
  const grant = grantWith({ grantFeatures: ["tradeable-v2", GRANT_V4_ADAPTER], v4AdapterAddress: ADAPTER });

  // The chain half, from the real builder.
  const perms = buildCallPermissions(CAPS, SELF, { v4AdapterAddress: ADAPTER }) as unknown as {
    target: string;
    functionName?: string;
  }[];
  assert.equal(perms.filter((p) => p.target.toLowerCase() === ADAPTER && p.functionName === "swapExactIn").length, 1);

  // The mirror half, judged by the real policy.
  const limits = limitsFromGrant(grant);
  assert.ok(limits.allowedTargets.map((a) => a.toLowerCase()).includes(ADAPTER), "the mirror admits the target");
  const verdict = checkPolicy(adapterBuy(ADAPTER), limits, CALM);
  assert.equal(verdict.ok, true, `an adapter swap must pass the mirror: ${JSON.stringify(verdict)}`);
});

test("marker alone: the mirror refuses, because the wall would too", () => {
  const grant = grantWith({ grantFeatures: ["tradeable-v2", GRANT_V4_ADAPTER] });
  const limits = limitsFromGrant(grant);
  assert.equal(limits.allowedTargets.map((a) => a.toLowerCase()).includes(ADAPTER), false);
  const verdict = checkPolicy(adapterBuy(ADAPTER), limits, CALM);
  assert.equal(verdict.ok, false, "no sealed address, no target — refused off-chain, before gas");
  assert.equal(verdict.rule, "target-allowlist");
});

test("address alone: a leftover field is not a permission", () => {
  const grant = grantWith({ v4AdapterAddress: ADAPTER });
  const limits = limitsFromGrant(grant);
  assert.equal(limits.allowedTargets.map((a) => a.toLowerCase()).includes(ADAPTER), false);
});

test("a default grant is untouched, and so is a legacy GRANT_V4 one", () => {
  const plain = limitsFromGrant(grantWith({}));
  assert.equal(plain.allowedTargets.map((a) => a.toLowerCase()).includes(ADAPTER), false);
  assert.equal(plain.allowedTargets.map((a) => a.toLowerCase()).includes(UNISWAP.permit2.toLowerCase()), false);

  // Legacy grants that carry "v4" keep exactly the Permit2 + UniversalRouter
  // targets they always had — narrowing them would strand a working wallet,
  // the mistake the transfer fix was careful not to make.
  const legacy = limitsFromGrant(grantWith({ grantFeatures: ["tradeable-v2", "v4"] }));
  const targets = legacy.allowedTargets.map((a) => a.toLowerCase());
  assert.ok(targets.includes(UNISWAP.permit2.toLowerCase()), "legacy keeps Permit2");
  assert.ok(targets.includes(UNISWAP.universalRouter.toLowerCase()), "legacy keeps the UniversalRouter");
  assert.equal(targets.includes(ADAPTER), false, "…and does not gain the adapter it never sealed");
});

test("the sealed address is mirrored case-insensitively", () => {
  // Grants store it lowercased, but a hand-edited grant.json might not be —
  // and an address that differs only by case must not read as a second,
  // unlisted target.
  const grant = grantWith({
    grantFeatures: ["tradeable-v2", GRANT_V4_ADAPTER],
    v4AdapterAddress: ADAPTER.toUpperCase().replace("0X", "0x"),
  });
  const limits = limitsFromGrant(grant);
  assert.ok(limits.allowedTargets.map((a) => a.toLowerCase()).includes(ADAPTER));
});

/**
 * THE MIRROR MUST NOT BE LOOSER THAN THE CHAIN — Rialto, specifically.
 *
 * `RIALTO.routerSnapshot` sat in `allowedTargets` for every grant, while
 * `buildCallPermissions` only ever emits that permission under `allowRialto` —
 * which no signer sets. So no grant this repo can produce carries it, and the
 * worker believed otherwise: it would pass `checkPolicy`, build the UserOp, and
 * have the chain refuse it. Gas spent to be told no, by a revert naming nothing.
 *
 * The rule this file exists for, stated in its own header: looser than the chain
 * means gas burned to be refused; stricter means a route that looks granted and
 * never fires. This is the first kind.
 */
test("Rialto is not in the mirror, because it is not in any wall we can sign", () => {
  const grant = {
    caps: { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    grantFeatures: ["tradeable-v2"],
  } as never;
  const targets = limitsFromGrant(grant).allowedTargets.map((a) => a.toLowerCase());
  assert.ok(
    !targets.includes(RIALTO.routerSnapshot.toLowerCase()),
    "the mirror must not claim a target the signature does not carry",
  );

  // And the wall genuinely does not grant it by default — so the two now agree.
  const perms = buildCallPermissions(
    { perTradeUsdg: 50, dailyUsdg: 500, expiryDays: 14, maxDrawdownPct: 10, maxOpsPerDay: 48 },
    "0x00000000000000000000000000000000000000a9",
  ) as unknown as { target: string }[];
  assert.equal(
    perms.filter((p) => p.target.toLowerCase() === RIALTO.routerSnapshot.toLowerCase()).length,
    0,
    "no Rialto permission by default",
  );
});
