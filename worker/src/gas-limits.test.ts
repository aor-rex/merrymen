import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  FIRST_ENABLE_GAS_BOUNDS,
  GAS_BOUNDS,
  boundGas,
  totalGas,
  type UserOpGas,
} from "./gas-limits";
import { isFirstEnable } from "./executor";

/**
 * The gap this closes was total: no floor, no ceiling, whatever the bundler
 * returned was what got signed. These tests are about the two asymmetries that
 * make the policy the shape it is.
 */

const est = (call: bigint, ver: bigint, pre: bigint): UserOpGas => ({
  callGasLimit: call,
  verificationGasLimit: ver,
  preVerificationGas: pre,
});
const NORMAL = est(180_000n, 90_000n, 55_000n);

test("headroom is applied to every field, not just the call", () => {
  // verificationGasLimit covers the session-key signature check and the FIRST
  // op also carries enable data and account deployment — the most expensive
  // verification this account will ever do, and the one we care most about
  // not clipping.
  //
  // Every field still gets headroom. What changed in Stage E is HOW MUCH: the
  // blanket 2x below was measured to be the entire reason a real first
  // operation was refused, and the per-field figures are justified on
  // GAS_BOUNDS. The invariant this test defends — no field goes unpadded — is
  // unchanged.
  const v = boundGas(NORMAL, null);
  assert.ok(v.ok);
  assert.deepEqual(v.gas, est(360_000n, 112_500n, 68_750n));
  assert.equal(v.total, 541_250n);
  for (const [field, raw] of Object.entries(NORMAL) as [keyof UserOpGas, bigint][]) {
    assert.ok(v.gas[field]! > raw, `${field} must be padded, not passed through`);
  }
});

test("being generous is FREE and being tight is total — so the bound is one-sided", () => {
  // A UserOp is charged for gas USED, not gas requested; the EntryPoint refunds
  // the rest. So a limit that is too high costs a slightly larger prefund, while
  // one that is too low costs the whole operation AND still charges for it.
  // Nothing here should ever reduce an estimate.
  const v = boundGas(NORMAL, null);
  assert.ok(v.ok);
  for (const k of ["callGasLimit", "verificationGasLimit", "preVerificationGas"] as const) {
    assert.ok(v.gas[k] > NORMAL[k], `${k} must never be clamped downward`);
  }
});

test("REFUSES rather than clamps when the estimate is absurd", () => {
  // Clamping would submit an operation we have positively decided is
  // under-provisioned — the OOG case, on purpose. An approve plus an
  // exactInputSingle does not approach 3M, so crossing it means this is not the
  // operation we think it is.
  const v = boundGas(est(2_000_000n, 500_000n, 100_000n), null);
  assert.equal(v.ok, false);
  assert.equal(v.rule, "gas-absurd");
  assert.match(v.detail, /nothing was spent/i);
});

test("two estimates far apart is a refusal — the estimator disagreeing with itself", () => {
  // Vex re-estimated one unchanged calldata across twelve consecutive blocks and
  // got 804,028-1,660,619, a 2.07x spread. Their four mined-reverted swaps had
  // burned ~97.3% of their limit with zero logs. 4x is the line past which
  // neither figure is one to sign against.
  const v = boundGas(est(100_000n, 50_000n, 25_000n), est(500_000n, 250_000n, 125_000n));
  assert.equal(v.ok, false);
  assert.equal(v.rule, "gas-unstable");
});

test("a normal spread between two estimates is fine, and bounds against the HIGHER", () => {
  // The cheap one may be the wrong one, and headroom is the direction where
  // being wrong is free.
  const lo = est(100_000n, 50_000n, 25_000n);
  const hi = est(150_000n, 75_000n, 30_000n);
  const a = boundGas(lo, hi);
  const b = boundGas(hi, lo);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.gas, b.gas, "order must not matter");
  // The higher estimate, padded per field: 300,000 + 93,750 + 37,500.
  assert.equal(a.total, 431_250n);
  assert.ok(a.total > totalGas(hi), "and it is the higher one that was padded");
  assert.ok(a.total > totalGas(lo) * 2n, "not merely the lower one doubled");
});

test("instability is judged on the TOTAL, because the fields trade off", () => {
  // Verification moving into preVerification between estimator versions is a
  // re-attribution, not instability — and the total is what the account posts a
  // prefund against. Per-field comparison would refuse this, wrongly.
  const a = est(200_000n, 150_000n, 20_000n);
  const b = est(200_000n, 20_000n, 150_000n);
  assert.equal(totalGas(a), totalGas(b));
  assert.equal(boundGas(a, b).ok, true);
});

test("A REFUSAL TO QUOTE IS NOT A QUOTE OF ZERO", () => {
  // The same conflation delivery.ts refuses to make about a balance. Signing
  // limits we invented is precisely the OOG this file exists to prevent.
  const v = boundGas(null, null);
  assert.equal(v.ok, false);
  assert.equal(v.rule, "gas-unreadable");
  assert.match(v.detail, /not a quote of zero/i);
});

test("a zero or negative field is not an estimate either", () => {
  // The shape a malformed RPC reply takes, and signing it guarantees the OOG.
  for (const bad of [est(0n, 90_000n, 55_000n), est(180_000n, -1n, 55_000n), est(180_000n, 90_000n, 0n)]) {
    const v = boundGas(bad, null);
    assert.equal(v.ok, false, "must not be treated as a very cheap operation");
    assert.equal(v.rule, "gas-unreadable");
  }
});

test("the disagreement check is SKIPPED, never assumed, when there is one estimate", () => {
  // A check that did not run must not read as one that passed. With a single
  // estimate the verdict is ok on the headroom alone — and gas-unstable is
  // simply unreachable, rather than silently satisfied.
  const v = boundGas(est(100_000n, 50_000n, 25_000n), null);
  assert.ok(v.ok);
  assert.equal(v.total, 293_750n); // 200,000 + 62,500 + 31,250
});

test("the bounds are the numbers the comments claim", () => {
  assert.equal(GAS_BOUNDS.callHeadroomBps, 20_000, "2x");
  assert.equal(GAS_BOUNDS.verificationHeadroomBps, 12_500, "1.25x");
  assert.equal(GAS_BOUNDS.preVerificationHeadroomBps, 12_500, "1.25x");
  assert.equal(GAS_BOUNDS.disagreementBps, 40_000, "4x");
  assert.equal(GAS_BOUNDS.absoluteMax, 3_000_000n);
  assert.ok(
    GAS_BOUNDS.disagreementBps > GAS_BOUNDS.callHeadroomBps,
    "a refusal must be looser than the widest headroom it guards",
  );
});

test("REGRESSION: a zero field in the SECOND estimate is caught too", () => {
  // The guard checked `first` only, and boundGas then reassigns
  // `first = second` whenever the second total is higher. So a zero
  // callGasLimit riding in on an otherwise-inflated second estimate was signed
  // unchecked — an op that passes validation and prefund, runs out of gas in
  // the inner call, and is charged in full. Exactly the indistinguishable OOG
  // this module exists to prevent, produced by the guard against it.
  //
  // These numbers are the reviewer's: 175,000 vs 600,000 is 3.43x, UNDER the 4x
  // disagreement line, so nothing else would have caught it.
  const good = est(100_000n, 50_000n, 25_000n);
  const zeroBearing = est(0n, 400_000n, 200_000n);
  assert.equal(totalGas(zeroBearing) <= totalGas(good) * 4n, true, "under the disagreement line, as the scenario requires");

  const v = boundGas(good, zeroBearing);
  assert.equal(v.ok, false, "must not be signed");
  assert.equal(v.rule, "gas-unreadable");
  // And in the other order, since which call returns the zero is chance.
  assert.equal(boundGas(zeroBearing, good).ok, false);
});

test("REGRESSION: the zero check runs BEFORE the disagreement math", () => {
  // A zero field also skews the total that the 4x test compares, so validating
  // first is what makes that comparison trustworthy rather than incidentally
  // correct. A zero-bearing pair far apart must read as unreadable, not unstable
  // — the honest answer is "that is not an estimate", not "they disagree".
  const v = boundGas(est(0n, 10n, 10n), est(900_000n, 900_000n, 900_000n));
  assert.equal(v.ok, false);
  assert.equal(v.rule, "gas-unreadable", "not 'gas-unstable'");
});

// ────────────────────────────────────────────────────────────────────────────
// STAGE E. The first operation of a merrymen account installs the entire policy
// wall inside validation, and the blanket 2x headroom turned a 7,711,654-gas
// operation into a 15,423,308-gas refusal — on the one operation in an
// account's life that has to succeed. These pin what changed and what did not.
// ────────────────────────────────────────────────────────────────────────────

/** The measured first-enable estimate. Pimlico, chain 4663, 2026-09-03. */
const MEASURED_WALL = est(50_180n, 7_418_031n, 243_443n);

test("callGasLimit gets 2x, and it is the only field that does", () => {
  // The asymmetry is the point. callGasLimit too low OOGs the call, success is
  // false, and THE ACCOUNT PAYS IN FULL. The other two fail during validation,
  // before the op enters a bundle, and cost nothing.
  const v = boundGas(est(100_000n, 200_000n, 40_000n), null);
  assert.ok(v.ok);
  assert.equal(v.gas.callGasLimit, 200_000n, "2x");
});

test("verification and preVerification get 1.25x, not 2x", () => {
  const v = boundGas(est(100_000n, 200_000n, 40_000n), null);
  assert.ok(v.ok);
  assert.equal(v.gas.verificationGasLimit, 250_000n, "1.25x");
  assert.equal(v.gas.preVerificationGas, 50_000n, "1.25x");
  // Pinned as a comparison too, so an edit that sets all three equal fails here
  // rather than quietly restoring the bug.
  assert.ok(
    GAS_BOUNDS.verificationHeadroomBps < GAS_BOUNDS.callHeadroomBps,
    "verification is deterministic given fixed calldata; the call is not",
  );
});

test("THE 18-PERMISSION WALL PASSES. This is the operation that was refused.", () => {
  const v = boundGas(MEASURED_WALL, MEASURED_WALL, FIRST_ENABLE_GAS_BOUNDS);
  assert.equal(v.ok, true, "the measured full wall must be signable");
  assert.ok(v.ok);
  assert.equal(v.gas.callGasLimit, 100_360n);
  assert.equal(v.gas.verificationGasLimit, 9_272_538n);
  assert.equal(v.gas.preVerificationGas, 304_303n);
  assert.equal(v.total, 9_677_201n, "the arithmetic in the constant's comment");

  // The same estimate under the OLD blanket 2x is still refused, so the
  // per-field headroom did the work — not the ceiling on its own.
  const blanket2x = totalGas(MEASURED_WALL) * 2n;
  assert.equal(blanket2x, 15_423_308n);
  assert.ok(blanket2x > FIRST_ENABLE_GAS_BOUNDS.absoluteMax, "15.4M is past 12M");
});

test("THE FIRST-ENABLE CEILING IS DERIVED, not chosen", () => {
  // Every term of the comment, recomputed. Widen the ceiling without widening
  // the justification and this fails.
  const bounded = 9_677_201n; // asserted above
  const perExtraToken = 462_874n; // measured ~370,299 raw x 1.25
  const withMargin = bounded + 5n * perExtraToken;
  assert.equal(withMargin, 11_991_571n);
  assert.equal(FIRST_ENABLE_GAS_BOUNDS.absoluteMax, 12_000_000n);
  assert.ok(
    FIRST_ENABLE_GAS_BOUNDS.absoluteMax >= withMargin,
    "the ceiling must cover the margin it claims",
  );
  assert.ok(
    FIRST_ENABLE_GAS_BOUNDS.absoluteMax - withMargin < perExtraToken,
    "and must not quietly exceed it by another token's worth",
  );
  // ONLY the ceiling moved. A first op gets the same headroom as any other.
  assert.equal(FIRST_ENABLE_GAS_BOUNDS.callHeadroomBps, GAS_BOUNDS.callHeadroomBps);
  assert.equal(FIRST_ENABLE_GAS_BOUNDS.verificationHeadroomBps, GAS_BOUNDS.verificationHeadroomBps);
  assert.equal(
    FIRST_ENABLE_GAS_BOUNDS.preVerificationHeadroomBps,
    GAS_BOUNDS.preVerificationHeadroomBps,
  );
  assert.equal(FIRST_ENABLE_GAS_BOUNDS.disagreementBps, GAS_BOUNDS.disagreementBps);
});

test("THE ORDINARY CEILING DID NOT MOVE. A deployed account cannot reach 12M.", () => {
  assert.equal(GAS_BOUNDS.absoluteMax, 3_000_000n, "unchanged by Stage E");
  // The same measured wall, offered the ordinary bounds, is refused.
  const v = boundGas(MEASURED_WALL, MEASURED_WALL);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "gas-absurd");
});

test("the first-enable ceiling is a CEILING, not an exemption", () => {
  // 12M is not "safe because it is large". An operation past it is as suspect
  // on the first op as on the thousandth.
  const absurd = est(3_000_000n, 8_000_000n, 3_000_000n);
  const v = boundGas(absurd, absurd, FIRST_ENABLE_GAS_BOUNDS);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "gas-absurd");
});

test("PAYMASTER GAS CANNOT WALK UNDER THE CEILING", () => {
  // paymaster.ts allows up to 500,000 in each of these, and totalGas counted
  // neither — so up to a million gas of prefund sat outside every bound in this
  // file. The EntryPoint's prefund counts them; now so do we.
  const withPm: UserOpGas = {
    ...est(400_000n, 600_000n, 100_000n), // bounded: 800k + 750k + 125k = 1.675M
    paymasterVerificationGasLimit: 500_000n,
    paymasterPostOpGasLimit: 500_000n,
  };
  assert.equal(totalGas(withPm), 2_100_000n, "totalGas sees the paymaster fields");

  // Sponsored: admitted, counted, and NOT multiplied — they are the sponsor's
  // numbers, bounded by paymaster.ts, and inflating them is not ours to do.
  const ok = boundGas(withPm, withPm, GAS_BOUNDS, true);
  assert.ok(ok.ok);
  assert.equal(ok.gas.paymasterVerificationGasLimit, 500_000n, "carried, never inflated");
  assert.equal(ok.gas.paymasterPostOpGasLimit, 500_000n);
  assert.equal(ok.total, 2_675_000n, "1.675M of ours plus 1M of theirs");

  // And the ceiling is enforced against the total INCLUDING them: the same
  // three fields alone clear 3M, and refuse once the sponsor's are counted.
  const ours = est(600_000n, 800_000n, 160_000n); // bounded 1.2M + 1M + 200k = 2.4M
  assert.equal(boundGas(ours, ours).ok, true, "2.4M alone clears the 3M ceiling");
  const big: UserOpGas = {
    ...ours,
    paymasterVerificationGasLimit: 500_000n,
    paymasterPostOpGasLimit: 500_000n,
  };
  const refused = boundGas(big, big, GAS_BOUNDS, true);
  assert.equal(refused.ok, false, "3.4M does not");
  assert.equal(refused.ok === false ? refused.rule : null, "gas-absurd");
});

test("a paymaster on a SELF-PAYING operation is refused, not ignored", () => {
  // The other half of "include them or prove they are absent". If nobody asked
  // a sponsor to pay and the estimate returns paymaster gas, the operation
  // being priced is not the operation about to be signed.
  const withPm: UserOpGas = {
    ...est(100_000n, 100_000n, 40_000n),
    paymasterVerificationGasLimit: 1n,
  };
  const v = boundGas(withPm, withPm);
  assert.equal(v.ok, false);
  assert.equal(v.ok === false ? v.rule : null, "gas-paymaster-unexpected");
  // The default is the strict reading, so a caller that forgets to say gets it.
  assert.equal(boundGas(withPm, withPm, GAS_BOUNDS, true).ok, true, "sponsored is fine");
});

// ── FAIL CLOSED ON EXECUTION STATE ──────────────────────────────────────────

test("isFirstEnable reads the operation's own nonce, and needs BOTH bytes", () => {
  // Kernel v3 packs mode(1) vType(1) validator(20) id(2) seq(8). Measured on
  // 4663: a walled account's first nonce is 0x0102…, a sudo-only one 0x0000….
  const walled = 0x0102630974640000000000000000000000000000000000000000000000000000n;
  const sudoOnly = 0x0000845adb2c0000000000000000000000000000000000000000000000000000n;
  assert.equal(isFirstEnable(walled), true, "mode ENABLE, type PERMISSION");
  assert.equal(isFirstEnable(sudoOnly), false, "mode DEFAULT is not an enable");

  // Mode alone is not enough: an enable of some OTHER validator type is not the
  // operation this ceiling was measured for.
  const enableOfSudo = 0x0100000000000000000000000000000000000000000000000000000000000000n;
  assert.equal(isFirstEnable(enableOfSudo), false, "an enable, but not of a permission validator");
  // And an ALREADY-INSTALLED permission validator — mode DEFAULT, type
  // PERMISSION — is the steady state, every op after the first.
  const installed = 0x0002000000000000000000000000000000000000000000000000000000000000n;
  assert.equal(isFirstEnable(installed), false, "installed is not enabling");
  // The sequence bytes must not change the answer either way.
  assert.equal(isFirstEnable(walled + 7n), true, "the sequence is not consulted");
});

test("THE CALL SITE: undeployed alone does NOT buy the elevated ceiling", () => {
  // A constant nothing reads is worth nothing, and this codebase has already
  // shipped the bug where a correct fact had no consequence. Pin that BOTH
  // conditions gate the ceiling and that the ordinary one is the fallback.
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(src, /await isDeployed\(\)/, "the deploy state must be consulted");
  assert.match(
    src,
    /!accountLive && isFirstEnable\(/,
    "undeployed AND proven-enable, never undeployed alone",
  );
  assert.match(
    src,
    /firstEnable \? FIRST_ENABLE_GAS_BOUNDS : GAS_BOUNDS/,
    "anything else gets the ordinary ceiling",
  );
  assert.match(src, /deployed = true;/, "a landed send must retire the first-enable ceiling");
  assert.doesNotMatch(src, /DEPLOY_GAS_BOUNDS/, "the undeployed-only ceiling is gone");
});

// ── THE OVERRIDE IS A PARAMETER OF ONE RPC CALL ─────────────────────────────

test("stateOverride appears ONLY on the estimation request", () => {
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.equal([...src.matchAll(/stateOverride:/g)].length, 1, "exactly one use");

  // And it is inside the estimate call's own argument object.
  const at = src.indexOf("estimateUserOperationGas({");
  assert.ok(at > 0, "the estimate call is where we think it is");
  const call = src.slice(at, src.indexOf("})) as Partial<UserOpGas>", at));
  assert.match(call, /stateOverride:/, "the override is an argument of the estimate");

  // Nowhere near the send. If it ever migrates there, this fails.
  const sendAt = src.indexOf("sendUserOperation(");
  assert.ok(sendAt > at, "the send comes after the estimate");
  assert.doesNotMatch(src.slice(sendAt), /stateOverride/, "never on the send");
});

test("the balance override cannot reach the UserOperation, signed or otherwise", () => {
  // A state override is a parameter of eth_estimateUserOperationGas — it is not
  // a field of a UserOperation, so it cannot be signed, hashed or broadcast.
  // What is provable here is that our own code never lets the value travel.
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  assert.match(src, /balance: bounds\.absoluteMax \* feeCeiling \* 2n/, "computed in one place");
  assert.doesNotMatch(
    src,
    /const\s+\w*[Bb]alance\w*\s*=\s*bounds\.absoluteMax/,
    "the override balance is not hoisted into a variable that could travel",
  );
  // feeCeiling exists to size the override and to price the prefund CHECK. It
  // must never appear in what we sign.
  const send = src.slice(src.indexOf("sendUserOperation("));
  assert.doesNotMatch(send, /feeCeiling/, "the override's fee never prices the real op");
  assert.doesNotMatch(send, /bounds\.absoluteMax/, "nor does the ceiling");
});

test("an underfunded account is told so, in words, AFTER the estimate", () => {
  // The override buys a number instead of an opaque AA21. It must not buy a
  // signature on an operation the chain will reject for the same reason — so
  // the REAL balance is checked against the bounded total before signing.
  const src = readFileSync(new URL("./executor.ts", import.meta.url), "utf8");
  const boundAt = src.indexOf("const bounded = boundGas(");
  const checkAt = src.indexOf('"prefund-short"');
  const signAt = src.indexOf("sendUserOperation(");
  assert.ok(boundAt > 0 && checkAt > 0 && signAt > 0, "all three exist");
  assert.ok(checkAt > boundAt, "the check is priced from the bounded total");
  assert.ok(checkAt < signAt, "and happens before anything is signed");
  assert.match(src, /getBalance\(\{ address: account\.address \}\)/, "the REAL balance");
  assert.match(src, /short by/, "the message says how short, not merely that it failed");
  assert.match(src, /Nothing was signed/, "and that nothing was spent");
});
