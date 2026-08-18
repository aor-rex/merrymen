import assert from "node:assert/strict";
import { PolicyFlags } from "@zerodev/permissions";
import { ParamCondition } from "@zerodev/permissions/policies";
import { encodeFunctionData, pad } from "viem";
import test from "node:test";
import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  UNISWAP,
  UNISWAP_SWAP_ROUTER_ABI,
  allowedSpenders,
  buildCallPermissions,
  buildWallPolicies,
  WALL_POLICY_FLAG,
  usableExtraTokens,
  type GrantCaps,
} from "../../packages/core/src/index";

/**
 * THE WALL, PINNED.
 *
 * These assertions are a specification, not a snapshot. The permission list moved
 * out of the dashboard so a phone could sign the same grant, and the danger in
 * that move is silent: drop one entry, loosen one condition, reorder the args of
 * an approve, and nothing throws — grants just start carrying powers their owners
 * did not agree to, and only for the people who signed after the change.
 *
 * So each expectation below was read off the ORIGINAL dashboard implementation and
 * written down independently. If a future edit widens the wall, this fails and
 * says which entry.
 */

const CAPS: GrantCaps = {
  perTradeUsdg: 50,
  dailyUsdg: 500,
  expiryDays: 14,
  maxDrawdownPct: 10,
  maxOpsPerDay: 48,
};

/** USDG is 6dp — the units a cap is actually expressed in on-chain. */
const usdg = (v: number) => BigInt(Math.round(v * 1e6));

type Perm = ReturnType<typeof buildCallPermissions>[number] & {
  target: string;
  functionName?: string;
  args?: unknown[];
};

/** The agent's own account — what the wall pins swap/vault destinations to. */
const SELF = "0x00000000000000000000000000000000000000a9" as const;
const perms = () => buildCallPermissions(CAPS, SELF) as unknown as Perm[];
const find = (target: string, fn?: string) =>
  perms().filter((p) => p.target.toLowerCase() === target.toLowerCase() && (fn === undefined || p.functionName === fn));

test("the default spenders exclude Rialto and Permit2, and universalRouter is never one", () => {
  // Rialto is opt-in: an approved spender can pull whatever it was approved
  // for, and the stock approvals carry no amount condition, so listing an
  // unused router is a standing licence over every share the agent holds.
  const s = allowedSpenders().map((a) => a.toLowerCase());
  assert.deepEqual(s, [UNISWAP.swapRouter02.toLowerCase(), MORPHO.steakhouseUsdgVault.toLowerCase()]);
  assert.equal(
    allowedSpenders(true)[0]!.toLowerCase(),
    RIALTO.routerSnapshot.toLowerCase(),
    "opting in adds Rialto, and only then",
  );
  // Permit2 is exactly the standing licence the comment above describes, and it
  // used to be here unconditionally. It only earns its place alongside the v4
  // CALL permissions, so it rides the same opt-in.
  assert.equal(s.includes(UNISWAP.permit2.toLowerCase()), false, "Permit2 is not a default spender");
  assert.equal(
    allowedSpenders(false, true).map((a) => a.toLowerCase()).includes(UNISWAP.permit2.toLowerCase()),
    true,
    "opting into v4 adds Permit2, and only then",
  );
  // v4 never pulls tokens directly — Permit2 does, on the router's behalf. Approving
  // the router itself would skip even that indirection.
  assert.equal(
    allowedSpenders(true, true).map((a) => a.toLowerCase()).includes(UNISWAP.universalRouter.toLowerCase()),
    false,
    "the UniversalRouter must never be an approved spender, on any setting",
  );
});

test("the v4 drain path is absent by default and arrives only as a set", () => {
  // THE REGRESSION THIS PINS. These two permissions were granted
  // unconditionally while Permit2 was an unconditional spender and the stock
  // approvals carry no amount condition. That chain — approve(stock, permit2,
  // unbounded) -> permit2.approve(stock, universalRouter, max, max) ->
  // execute(<opaque inputs naming any recipient>) — moved the entire non-USDG
  // book anywhere, in one UserOp, past a wall the front page says the chain
  // enforces. The execute permission's own comment claimed Permit2 was "only
  // ever granted one trade's worth, expiring"; that described what the worker
  // encodes, not what the policy allows.
  assert.equal(find(UNISWAP.permit2).length, 0, "no Permit2 permission by default");
  assert.equal(find(UNISWAP.universalRouter).length, 0, "no UniversalRouter permission by default");

  const v4 = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true }) as unknown as Perm[];
  const p2 = v4.filter((p) => p.target.toLowerCase() === UNISWAP.permit2.toLowerCase());
  const ur = v4.filter((p) => p.target.toLowerCase() === UNISWAP.universalRouter.toLowerCase());
  assert.equal(p2.length, 1, "opting in adds the Permit2 approve");
  assert.equal(ur.length, 1, "opting in adds the UniversalRouter execute");
  // And they must arrive TOGETHER with the spender, because each alone is inert
  // and granting them piecemeal is how this became a hole in the first place.
  assert.equal(
    allowedSpenders(false, true).map((a) => a.toLowerCase()).includes(UNISWAP.permit2.toLowerCase()),
    true,
    "the call permission and the spender entry are one decision",
  );
  // Still true when opted in: the router's calldata is opaque, so this really is
  // "call anything on this contract" — which is why it is not the default.
  assert.equal(ur[0]!.args, undefined, "execute stays unconstrainable — that is the point of making it opt-in");
});

test("USDG approve is capped at ONE TRADE and restricted to the allowed spenders", () => {
  const [p] = find(CASH.USDG, "approve");
  assert.ok(p, "USDG approve permission must exist");
  const [spender, amount] = p.args as [{ condition: number; value: string[] }, { condition: number; value: bigint }];
  // Two by default — the swap router and the vault. Rialto and Permit2 are each
  // opt-in, and every entry here is a standing licence, so the list growing
  // silently is exactly the regression this asserts against.
  assert.equal(spender.value.length, 2, "the two default spenders — Rialto and Permit2 are opt-in");
  // The cap is per TRADE, not per day. Using dailyUsdg here would let one approval
  // authorise ten trades' worth.
  assert.equal(amount.value, usdg(CAPS.perTradeUsdg));
});

test("by DEFAULT there is no way to send USDG out at all", () => {
  // The recipient used to be free-form, which left the per-call amount as the
  // only on-chain bound — and the daily USDG cap lives off-chain, in the very
  // worker that would be compromised. The real ceiling was therefore
  // perTradeUsdg x maxOpsPerDay per day until expiry (2,400/day at the default
  // preset): "bounded" only in that draining took a fortnight.
  assert.equal(find(CASH.USDG, "transfer").length, 0, "no registered address, no power to send");
});

test("registering withdrawal addresses pins the recipient to exactly those", () => {
  const A = "0x1111111111111111111111111111111111111111" as const;
  const B = "0x2222222222222222222222222222222222222222" as const;
  const list = buildCallPermissions(CAPS, SELF, {
    // Duplicated and mixed-case on purpose: a repeat must not bloat the policy
    // and a case difference must not read as a second address.
    withdrawalAddresses: [A, B, A, B.toUpperCase() as typeof B],
  }) as unknown as Perm[];
  const p = list.find((x) => x.target.toLowerCase() === CASH.USDG.toLowerCase() && x.functionName === "transfer");
  assert.ok(p, "registering an address grants the transfer permission");
  const [recipient, amount] = p.args as [{ condition: number; value: string[] }, { value: bigint }];
  assert.equal(recipient.condition, ParamCondition.ONE_OF);
  assert.deepEqual(recipient.value, [A, B]);
  // The amount cap still applies on top of the destination pin.
  assert.equal(amount.value, usdg(CAPS.perTradeUsdg));
});

test("every tradeable stock token can be approved, so nothing can be bought but not sold", () => {
  const tradeable = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol));
  assert.ok(tradeable.length > 0, "sanity: there are tradeable tokens");
  for (const t of tradeable) {
    const [p] = find(t.address, "approve");
    assert.ok(p, `${t.symbol} must be approvable or the agent could buy it and never sell`);
    // No amount condition on purpose: share counts are 18dp and not comparable to
    // a USDG cap. Asserted so nobody "tightens" it into a broken policy.
    assert.equal((p.args as unknown[])[1], null, `${t.symbol} approve must have no amount condition`);
  }
});

test("Permit2, WHEN opted into, may only ever grant an allowance to the UniversalRouter", () => {
  const optedIn = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true }) as unknown as Perm[];
  const p = optedIn.find(
    (x) => x.target.toLowerCase() === UNISWAP.permit2.toLowerCase() && x.functionName === "approve",
  );
  assert.ok(p, "permit2 approve permission must exist once opted in");
  const args = p.args as [null, { condition: number; value: string }, null, null];
  // Without this EQUAL condition, this single permission would let the session key
  // hand ANY spender an allowance on ANY token — strictly more power than trading.
  assert.equal(args[1].value.toLowerCase(), UNISWAP.universalRouter.toLowerCase());
});

test("the vault deposit is capped, the withdrawal is not — but BOTH land in our own account", () => {
  const [dep] = find(MORPHO.steakhouseUsdgVault, "deposit");
  const [wd] = find(MORPHO.steakhouseUsdgVault, "withdraw");
  assert.ok(dep && wd);

  // deposit(assets, receiver): size capped at the daily limit...
  assert.equal((dep.args as [{ value: bigint }, unknown])[0].value, usdg(CAPS.dailyUsdg));
  // ...and the SHARES come to us. Unpinned, the agent could spend the owner's
  // USDG and mint the vault position to someone else.
  assert.deepEqual((dep.args as [unknown, { condition: number; value: string }])[1], {
    condition: ParamCondition.EQUAL,
    value: SELF,
  });

  // withdraw(assets, receiver, owner): size deliberately unbounded — money
  // coming home is not a risk. But this test used to assert `wd.args ===
  // undefined` ON PURPOSE, with a comment about money coming home, while the
  // policy let the session key send the entire vault position ANYWHERE in one
  // uncapped call. The comment described the intent; the policy permitted the
  // opposite. "Coming home" is now enforced rather than assumed.
  const wdArgs = wd.args as [null, { condition: number; value: string }, null];
  assert.equal(wdArgs[0], null, "size stays unbounded");
  assert.deepEqual(wdArgs[1], { condition: ParamCondition.EQUAL, value: SELF });
  assert.equal(wdArgs[2], null, "owner is unconstrained — it can only be us anyway");
});

test("the routers are narrowed to one function each, and Rialto is absent by default", () => {
  assert.equal(find(UNISWAP.swapRouter02, "exactInputSingle").length, 1);
  // The UniversalRouter is absent entirely by default — see the v4 test above.
  // When opted in it is narrowed to `execute` and no further, because there is
  // no further: its arguments are opaque bytes.
  assert.equal(find(UNISWAP.universalRouter).length, 0);
  const v4 = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true }) as unknown as Perm[];
  assert.equal(
    v4.filter((p) => p.target.toLowerCase() === UNISWAP.universalRouter.toLowerCase() && p.functionName === "execute")
      .length,
    1,
  );
  // Rialto's calldata comes from a quote API, so there is no shape to
  // constrain — the permission is effectively "call anything on this
  // contract". It needs an integrator key to work at all, so the default wall
  // simply doesn't carry it.
  assert.equal(find(RIALTO.routerSnapshot).length, 0);

  const optedIn = buildCallPermissions(CAPS, SELF, { allowRialto: true }) as unknown as Perm[];
  const rialto = optedIn.find((p) => p.target.toLowerCase() === RIALTO.routerSnapshot.toLowerCase());
  assert.ok(rialto, "opting in adds it");
  assert.equal(rialto.functionName, undefined, "still unconstrainable — that is the point of making it opt-in");
});

test("owner-added tokens are validated and de-duplicated before becoming policy", () => {
  const builtinAddr = STOCK_TOKENS[0]!.address;
  const usable = usableExtraTokens([
    { address: builtinAddr, symbol: "DUP", decimals: 18 } as never, // already covered
    { address: "0xnothex", symbol: "BAD", decimals: 18 } as never, // malformed
    { address: "0x1111111111111111111111111111111111111111", symbol: "OK", decimals: 18 } as never,
    { address: "0x1111111111111111111111111111111111111111", symbol: "OK", decimals: 18 } as never, // repeat
  ]);
  assert.equal(usable.length, 1, "only the one valid, non-duplicate token survives");
  assert.equal(usable[0]!.symbol, "OK");
});

test("the wall carries exactly the expected permission set — no more, no less", () => {
  const list = perms();
  const stockCount = STOCK_TOKENS.filter((t) => (TRADEABLE_SYMBOLS as readonly string[]).includes(t.symbol)).length;
  // DEFAULT wall: 1 USDG approve + N stock approves + swapRouter02 + vault
  // deposit + vault withdraw. No USDG transfer, no Rialto and no v4 — all
  // three are opt-in. This count dropped from stockCount + 6 when Permit2 and
  // the UniversalRouter stopped being granted unconditionally.
  assert.equal(list.length, stockCount + 4, "an unexpected permission count means something was added or lost");
  // ...and each opt-in adds exactly the entries it should, never more.
  const withXfer = buildCallPermissions(CAPS, SELF, { withdrawalAddresses: [SELF] });
  const withRialto = buildCallPermissions(CAPS, SELF, { allowRialto: true });
  const withV4 = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true });
  assert.equal(withXfer.length, list.length + 1);
  assert.equal(withRialto.length, list.length + 1);
  assert.equal(withV4.length, list.length + 2, "v4 is a PAIR — Permit2 approve plus UniversalRouter execute");
  // Nothing may authorise sending native value.
  for (const p of list) assert.equal(p.valueLimit, 0n, `${p.target} must not be allowed to move native ETH`);
});

test("policies carry a hard expiry and a daily op limit", () => {
  const now = 1_800_000_000;
  const { policies, expiresAt } = buildWallPolicies({ caps: CAPS, smartAccount: SELF, now });
  assert.equal(expiresAt, now + CAPS.expiryDays * 86_400);
  // Expiry, rate limit, call policy — the key dies on schedule even if every
  // other control fails.
  assert.equal(policies.length, 3);
});

test("the session key may EXECUTE but may not SIGN (the ERC-1271 hole)", () => {
  // Every other assertion in this file is about a CALL policy, and a call
  // policy governs UserOp calls only — it says nothing about signatures. The
  // permission validator implements signMessage and signTypedData, so on the
  // library default (FOR_ALL_VALIDATION) the session key can mint ERC-1271
  // signatures the account honours. That bypasses the wall rather than
  // stretching it: Permit2 is an approved spender and the stock approvals
  // carry no amount condition, so a SIGNED permitTransferFrom — submitted by
  // anyone, from their own EOA — drains tokens with no UserOp, no rate limit,
  // and no trace in the ledger.
  //
  // This costs merrymen nothing: the whole trading path is UserOps, and v4
  // authorises Permit2 with a CALL (venues/uniswap-v4.ts), not a signed permit.
  assert.equal(WALL_POLICY_FLAG, PolicyFlags.NOT_FOR_VALIDATE_SIG);
  assert.notEqual(
    WALL_POLICY_FLAG,
    PolicyFlags.FOR_ALL_VALIDATION,
    "the library default lets the session key sign — never ship it",
  );
});

test("the swap recipient is pinned to our own account, at the RIGHT calldata offset", () => {
  const [swap] = find(UNISWAP.swapRouter02, "exactInputSingle");
  assert.ok(swap);
  const args = swap.args as (null | { condition: number; value: string })[];

  // Seven entries for a ONE-parameter function, because the call policy maps
  // args[i] to calldata offset i*32 with no ABI arity check, and
  // ExactInputSingleParams is an all-static tuple encoded INLINE as seven
  // consecutive words. Index 3 is `recipient`.
  assert.equal(args.length, 7);
  assert.deepEqual(args[3], { condition: ParamCondition.EQUAL, value: SELF });
  for (const i of [0, 1, 2, 4, 5, 6]) assert.equal(args[i], null, `arg ${i} must stay unconstrained`);

  // AND PROVE THE OFFSET, against viem's encoder rather than against the
  // reasoning above. If SwapRouter02's struct ever gains a dynamic member or
  // reorders its fields, the inline layout shifts and args[3] would silently
  // constrain the WRONG word — a policy that looks strict and isn't. This
  // fails loudly instead.
  const OTHER = "0x00000000000000000000000000000000000000ff" as const;
  const calldata = encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: CASH.USDG as `0x${string}`,
        tokenOut: OTHER,
        fee: 3000,
        recipient: SELF,
        amountIn: 1_000_000n,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  // Skip the 4-byte selector, then read word 3 (the policy's offset 3*32).
  const body = `0x${calldata.slice(10)}`;
  const word3 = `0x${body.slice(2 + 3 * 64, 2 + 4 * 64)}`;
  assert.equal(
    word3.toLowerCase(),
    pad(SELF, { size: 32 }).toLowerCase(),
    "offset 3*32 must be `recipient` — if this fails the tuple layout moved and the pin is aimed at the wrong field",
  );
});
