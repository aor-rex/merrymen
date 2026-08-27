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
  V4SELFSWAP_ABI,
  allowedSpenders,
  buildCallPermissions,
  buildWallPolicies,
  grantHasMultihop,
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

test("a MULTI-HOP swap IS permitted, and its recipient is pinned at the RIGHT word", () => {
  // `exactInput` (the via-WETH route) is a different selector from
  // `exactInputSingle`, and the wall used to grant only the latter while the
  // worker quoted multi-hop routes anyway: they logged "simulated ✓ v3 via
  // WETH", were submitted, and reverted on-chain — burning gas every tick,
  // invisible in paper mode because paper never builds calldata.
  //
  // Granting it costs nothing beyond what single-hop already grants: the input
  // is bounded by the USDG approve cap (≤ perTradeUsdg) and the output is
  // pinned to this account, exactly as asserted below.
  const [hop] = find(UNISWAP.swapRouter02, "exactInput");
  assert.ok(hop, "the multi-hop permission exists");
  const args = hop.args as (null | { condition: number; value: string })[];

  // THREE entries, not seven, and the pin sits at index 2 rather than 3 — THAT
  // is the trap. ExactInputParams leads with `bytes path`, so the tuple is
  // DYNAMIC: word 0 is the pointer to the tuple, word 1 the pointer to the
  // path, and `recipient` lands at word 2. Copying the single-hop mapping would
  // have constrained `amountIn` and left the recipient free to be anyone.
  assert.equal(args.length, 3);
  assert.deepEqual(args[2], { condition: ParamCondition.EQUAL, value: SELF });
  assert.equal(args[0], null, "word 0 is the tuple pointer");
  assert.equal(args[1], null, "word 1 is the path pointer");

  // AND PROVE IT against viem's encoder, not against the reasoning above.
  const OTHER = "0x00000000000000000000000000000000000000ff" as const;
  const path = `0x${CASH.USDG.slice(2)}000bb8${CASH.WETH.slice(2)}000bb8${OTHER.slice(2)}` as `0x${string}`;
  const calldata = encodeFunctionData({
    abi: UNISWAP_SWAP_ROUTER_ABI,
    functionName: "exactInput",
    args: [{ path, recipient: SELF, amountIn: 1_000_000n, amountOutMinimum: 0n }],
  });
  const body = `0x${calldata.slice(10)}`;
  const wordAt = (i: number) => `0x${body.slice(2 + i * 64, 2 + (i + 1) * 64)}`;
  assert.equal(
    wordAt(2).toLowerCase(),
    pad(SELF, { size: 32 }).toLowerCase(),
    "offset 2*32 must be `recipient` — if this fails the tuple layout moved and the pin is aimed at the wrong field",
  );
  // The neighbours too, so a shift in EITHER direction fails rather than aliases.
  assert.equal(BigInt(wordAt(3)), 1_000_000n, "word 3 is amountIn");
  assert.equal(BigInt(wordAt(1)), 128n, "word 1 is the path OFFSET, not a value");

  // The permission and the grant marker must move together, exactly like
  // allowUniswapV4 and GRANT_V4. Both signers mint this unconditionally now.
  assert.equal(
    grantHasMultihop({ grantFeatures: ["transfer", "tradeable-v2", "multihop"] }),
    true,
    "a grant signed today claims it",
  );
  assert.equal(
    grantHasMultihop({ grantFeatures: ["transfer", "tradeable-v2"] }),
    false,
    "one signed before this does not — the worker keeps routing it single-hop",
  );
});

test("the routers are narrowed to the two swap entrypoints, and Rialto is absent by default", () => {
  assert.equal(find(UNISWAP.swapRouter02, "exactInputSingle").length, 1);
  assert.equal(find(UNISWAP.swapRouter02, "exactInput").length, 1);
  assert.equal(find(UNISWAP.swapRouter02).length, 2, "and nothing else on that router");
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
  // DEFAULT wall: 1 USDG approve + N stock approves + swapRouter02 ×2
  // (exactInputSingle and exactInput) + vault deposit + vault withdraw. No USDG
  // transfer, no Rialto and no v4 — all three are opt-in. This count dropped
  // from stockCount + 6 when Permit2 and the UniversalRouter stopped being
  // granted unconditionally, and rose by one when the multi-hop route was
  // granted rather than quoted-and-reverted.
  assert.equal(list.length, stockCount + 5, "an unexpected permission count means something was added or lost");
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

test("the V4 ADAPTER opt-in: one permission, both legs pinned to the owner's asset list, at proven offsets", () => {
  const ADAPTER = "0x00000000000000000000000000000000000000d4" as const;
  const CUSTOM = { symbol: "WIF", address: "0x00000000000000000000000000000000000000e7", decimals: 9 } as const;

  // Absent by default — the closed position, like every opt-in here.
  assert.equal(find(ADAPTER).length, 0, "no adapter permission without the opt-in");

  const withAdapter = buildCallPermissions(CAPS, SELF, {
    v4AdapterAddress: ADAPTER,
    extraTokens: [CUSTOM],
  }) as unknown as Perm[];
  const mine = withAdapter.filter((p) => p.target.toLowerCase() === ADAPTER);
  assert.equal(mine.length, 1, "exactly one call permission on the adapter");
  const [swap] = mine;
  assert.equal(swap!.functionName, "swapExactIn");
  assert.equal(swap!.valueLimit, 0n);

  // The adapter joined the SPENDER set, so the existing approves can name it —
  // zero new approve entries. Check the USDG approve's ONE_OF actually grew.
  const usdgApprove = withAdapter.find(
    (p) => p.target.toLowerCase() === CASH.USDG.toLowerCase() && p.functionName === "approve",
  )!;
  const spenderCond = (usdgApprove.args as { value: string[] }[])[0]!;
  assert.ok(
    spenderCond.value.map((a) => a.toLowerCase()).includes(ADAPTER),
    "the adapter must be an allowed spender, or it can never pull tokenIn",
  );

  // BOTH LEGS PINNED — the strictness v3 never had. tokenIn and tokenOut are
  // ONE_OF over USDG + tradeable stocks + the owner's extras, derived in the
  // same call as the approve targets so the two sets cannot drift. This is
  // what turns "a stolen key swaps the bankroll into a token it minted for
  // gas" into "both legs must be assets the OWNER named".
  const args = swap!.args as (null | { condition: number; value: string | string[] })[];
  assert.equal(args.length, 8, "eight declared args, eight policy slots — all static, no pointer words");
  for (const i of [0, 1] as const) {
    const cond = args[i] as { condition: number; value: string[] };
    assert.equal(cond.condition, ParamCondition.ONE_OF, `arg ${i} must be pinned`);
    const set = cond.value.map((a) => a.toLowerCase());
    assert.ok(set.includes(CASH.USDG.toLowerCase()), "cash is an asset");
    assert.ok(set.includes(CUSTOM.address.toLowerCase()), "the owner's own token is an asset");
    assert.ok(!set.includes("0x00000000000000000000000000000000000000ff"), "an unnamed token is not");
  }
  for (const i of [2, 3, 4, 5, 6, 7]) assert.equal(args[i], null, `arg ${i} stays unconstrained — see wall.ts for why each`);

  // AND PROVE THE OFFSETS against viem's encoder, not against the reasoning.
  // All eight params are static, so this is the one signature where the flat
  // args[i] -> word i mapping is EXACT — but that is precisely the claim that
  // must fail loudly if the contract's signature ever changes shape.
  const calldata = encodeFunctionData({
    abi: V4SELFSWAP_ABI,
    functionName: "swapExactIn",
    args: [
      CASH.USDG as `0x${string}`,
      CUSTOM.address as `0x${string}`,
      3000,
      60,
      "0x00000000000000000000000000000000000000aa",
      1_000_000n,
      999n,
      1_800_000_000n,
    ],
  });
  const body = calldata.slice(10);
  const word = (i: number) => `0x${body.slice(i * 64, (i + 1) * 64)}`;
  assert.equal(word(0).toLowerCase(), pad(CASH.USDG as `0x${string}`, { size: 32 }).toLowerCase(), "word 0 = tokenIn");
  assert.equal(word(1).toLowerCase(), pad(CUSTOM.address as `0x${string}`, { size: 32 }).toLowerCase(), "word 1 = tokenOut");
  assert.equal(
    word(4).toLowerCase(),
    pad("0x00000000000000000000000000000000000000aa", { size: 32 }).toLowerCase(),
    "word 4 = hooks",
  );
  assert.equal(BigInt(word(5)), 1_000_000n, "word 5 = amountIn");
  assert.equal(BigInt(word(6)), 999n, "word 6 = minAmountOut");
  assert.equal(BigInt(word(7)), 1_800_000_000n, "word 7 = deadline");
});

test("the adapter opt-in is INDEPENDENT of the legacy v4 route, and a junk address throws", () => {
  const ADAPTER = "0x00000000000000000000000000000000000000d4" as const;
  const base = perms().length;

  // Adapter alone: +1 permission (its call), no Permit2, no UniversalRouter.
  const adapterOnly = buildCallPermissions(CAPS, SELF, { v4AdapterAddress: ADAPTER }) as unknown as Perm[];
  assert.equal(adapterOnly.length, base + 1);
  assert.equal(
    adapterOnly.filter((p) => p.target.toLowerCase() === UNISWAP.universalRouter.toLowerCase()).length,
    0,
    "the adapter route does not smuggle the UniversalRouter back in",
  );

  // Legacy flag alone: unchanged from before the adapter existed (+3).
  const legacy = buildCallPermissions(CAPS, SELF, { allowUniswapV4: true }) as unknown as Perm[];
  assert.equal(legacy.length, base + 2, "the legacy Permit2+UniversalRouter set is untouched");

  // Both: strictly additive, no interference.
  const both = buildCallPermissions(CAPS, SELF, {
    v4AdapterAddress: ADAPTER,
    allowUniswapV4: true,
  }) as unknown as Perm[];
  assert.equal(both.length, base + 3);

  // A malformed address must throw at build time — a permission whose target
  // is garbage is a route that looks granted and can never match, sealed into
  // a signature nobody can amend.
  for (const bad of ["0x1234", "not-an-address", ""]) {
    assert.throws(
      () => buildCallPermissions(CAPS, SELF, { v4AdapterAddress: bad as never }),
      /not an address/,
      `"${bad}" must be refused before it becomes policy`,
    );
  }
});
