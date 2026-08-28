import assert from "node:assert/strict";
import test from "node:test";
import { classifyBalance, nativeSweep, sweepList } from "./recover";
import { CASH, MORPHO, STOCK_TOKENS } from "../../packages/core/src/index";

/**
 * The escape hatch, which had no tests at all.
 *
 * `merrymen recover` is what an owner runs when everything else has failed —
 * after a kill switch, after a lost session key, when the funded address turns
 * out to be a smart account their wallet cannot see. It swept a token list
 * frozen at ship time, which meant it stranded two whole categories of money:
 * every token the owner added themselves (including every quarantined scout
 * buy), and the Morpho vault position — which is where the idle-cash sweep puts
 * most of the float on the FIRST tick. An agent doing exactly what it is
 * designed to do was reported by recovery as an empty account.
 */

const addr = (n: string) => `0x${n.repeat(40).slice(0, 40)}` as const;

test("the builtin floor includes the vault — a fully-parked agent is not an empty one", () => {
  const list = sweepList();
  const targets = list.map((t) => t.address.toLowerCase());
  assert.ok(targets.includes(CASH.USDG.toLowerCase()), "cash");
  assert.ok(
    targets.includes(MORPHO.steakhouseUsdgVault.toLowerCase()),
    "the vault — steady-basket parks idle cash there on the first tick, so for most of a run this " +
      "IS the account. Leaving it out made recovery report 'empty' for a wallet that was fully invested.",
  );
  for (const t of STOCK_TOKENS) {
    assert.ok(targets.includes(t.address.toLowerCase()), `${t.symbol} must be sweepable`);
  }
});

test("owner-added tokens are swept — that is the whole defect", () => {
  const mine = { symbol: "WIF", address: addr("a"), decimals: 9 };
  const list = sweepList([mine]);
  const found = list.find((t) => t.address.toLowerCase() === mine.address.toLowerCase());
  assert.ok(found, "an owner-added token must reach the sweep");
  assert.equal(found.decimals, 9, "at ITS decimals, not a guessed 18 — the amount is shown to the owner");
});

test("malformed entries are dropped rather than trusted", () => {
  // settings.json is read off disk by one caller, so the shape is re-checked
  // here. A bad address in an atomic sweep fails the whole recovery.
  const list = sweepList([
    { symbol: "OK", address: addr("b"), decimals: 18 },
    { symbol: "BAD", address: "0xnothex", decimals: 18 },
    { symbol: "WORSE", address: addr("c"), decimals: 999 },
    { symbol: "", address: addr("d"), decimals: 18 },
    null,
    "not even an object",
  ]);
  const extras = list.slice(sweepList().length);
  assert.equal(extras.length, 1, "only the valid one survives");
  assert.equal(extras[0]!.symbol, "OK");
});

test("a builtin cannot be shadowed — not by address, and not by symbol either", () => {
  // Address-only dedupe would let a hostile or typo'd entry put a SECOND row
  // labelled 'AAPL' in the sweep confirmation, on the one screen where the
  // owner is agreeing to move real money and has only the symbol to go on.
  const aapl = STOCK_TOKENS.find((t) => t.symbol === "AAPL") ?? STOCK_TOKENS[0]!;
  const baseline = sweepList().length;
  const list = sweepList([
    { symbol: aapl.symbol, address: addr("e"), decimals: 18 }, // symbol collision
    { symbol: "ALIAS", address: aapl.address, decimals: 18 }, // address collision
  ]);
  assert.equal(list.length, baseline, "neither may be added");
  assert.equal(
    list.filter((t) => t.symbol.toUpperCase() === aapl.symbol.toUpperCase()).length,
    1,
    "exactly one row may ever carry a given symbol",
  );
  const real = list.find((t) => t.symbol === aapl.symbol);
  assert.equal(real!.address.toLowerCase(), aapl.address.toLowerCase(), "and it is the curated address that wins");
});

test("duplicates among the owner's own entries collapse", () => {
  const t = { symbol: "DUPE", address: addr("f"), decimals: 6 };
  const list = sweepList([t, { ...t }, { symbol: "OTHER", address: t.address, decimals: 6 }]);
  assert.equal(list.filter((x) => x.address.toLowerCase() === t.address.toLowerCase()).length, 1);
});

test("the list is capped, because the sweep is ONE atomic operation", () => {
  // An unbounded call list is one that runs out of gas and moves nothing at
  // all — the worst possible outcome for an escape hatch.
  const many = Array.from({ length: 200 }, (_, i) => ({
    symbol: `T${i}`,
    address: `0x${i.toString(16).padStart(40, "0")}`,
    decimals: 18,
  }));
  const list = sweepList(many);
  assert.ok(list.length <= sweepList().length + 50, `capped, got ${list.length}`);
  assert.ok(list.length > sweepList().length, "…but not to zero");
});

test("no argument behaves exactly like an empty one", () => {
  assert.deepEqual(sweepList(), sweepList([]));
});

test("a balance that reads is a balance", async () => {
  const r = await classifyBalance({ balanceOf: async () => 42n, getCode: async () => "0xdead" });
  assert.deepEqual(r, { kind: "read", raw: 42n });
});

test("an address with NO CONTRACT is an honest zero, not an unknown", async () => {
  // The testnet case: every registry address is an undeployed mainnet address,
  // so all 27 reads fail. Classifying those as unreadable would tell an owner
  // with a genuinely empty account that 27 tokens "could not be read — that is
  // NOT a zero balance". False, alarming, unactionable.
  //
  // viem's getCode returns UNDEFINED for a codeless address (it normalises "0x"
  // away), so undefined-from-success is the case that must map to absent.
  assert.deepEqual(await classifyBalance({ balanceOf: async () => { throw new Error("0x"); }, getCode: async () => undefined }), { kind: "absent" });
  assert.deepEqual(await classifyBalance({ balanceOf: async () => { throw new Error("0x"); }, getCode: async () => "0x" }), { kind: "absent" });
});

test("a contract that IS there but will not answer is unreadable", async () => {
  const r = await classifyBalance({
    balanceOf: async () => { throw new Error("execution reverted"); },
    getCode: async () => "0x60806040",
  });
  assert.deepEqual(r, { kind: "unreadable" });
});

test("a probe that cannot even run is unreadable — never a zero", async () => {
  // The RPC-blinked case. This is the one that must never become 0n, and the
  // one the original `.catch(() => 0n)` got wrong.
  const r = await classifyBalance({
    balanceOf: async () => { throw new Error("fetch failed"); },
    getCode: async () => { throw new Error("fetch failed"); },
  });
  assert.deepEqual(r, { kind: "unreadable" });
});

test("THE COLLAPSE: a failed probe and a codeless address must not be the same value", async () => {
  // Written as its own test because getting this wrong is silent. If the probe
  // were `.catch(() => undefined)`, both of these would produce undefined and
  // classify identically — and the three-way split would be a two-way one
  // wearing a costume.
  const codeless = await classifyBalance({ balanceOf: async () => { throw new Error("x"); }, getCode: async () => undefined });
  const broken = await classifyBalance({ balanceOf: async () => { throw new Error("x"); }, getCode: async () => { throw new Error("rpc down"); } });
  assert.notDeepEqual(codeless, broken, "absent and unreadable must remain distinguishable");
  assert.equal(codeless.kind, "absent");
  assert.equal(broken.kind, "unreadable");
});

/**
 * The native-ETH sweep, and why its reserve errs large.
 *
 * ETH used to be abandoned by recovery on the reasoning that it only pays for
 * the sweep's own gas. That is true on testnet and wrong the moment someone
 * funds a real account — and worse, an account holding ETH and no tokens was
 * reported as having nothing to recover, which is the exact shape of "I funded
 * it and merrymen says it's empty".
 *
 * The reserve is the load-bearing number. Too small and the operation cannot be
 * paid for, so nothing moves at all — tokens included. Too large and some dust
 * stays. These tests pin that asymmetry.
 */

test("an account with only gas money keeps it — nothing is swept below the reserve", () => {
  const gasPrice = 1_000_000_000n; // 1 gwei
  const { sweep, reserve } = nativeSweep(500_000_000_000_000n, gasPrice); // 0.0005 ETH
  assert.equal(sweep, 0n, "must not strand the op by taking its gas money");
  assert.equal(reserve, 500_000_000_000_000n, "all of it stays");
});

test("a funded account sweeps everything above the reserve", () => {
  const gasPrice = 1_000_000_000n; // 1 gwei
  const held = 10n ** 18n; // 1 ETH
  const { sweep, reserve } = nativeSweep(held, gasPrice);
  assert.equal(sweep + reserve, held, "every wei is accounted for — swept or reserved");
  assert.ok(sweep > 0n, "a whole ETH is well clear of any sane reserve");
  // 900k gas x 1 gwei x 2 = 0.0018 ETH held back.
  assert.equal(reserve, 1_800_000_000_000_000n);
});

test("the reserve scales with gas price, so a spike cannot make the op unaffordable", () => {
  const held = 10n ** 18n;
  const cheap = nativeSweep(held, 1_000_000_000n).reserve;
  const dear = nativeSweep(held, 100_000_000_000n).reserve; // 100 gwei
  assert.ok(dear > cheap, "a dearer chain keeps more back");
  assert.equal(dear, cheap * 100n);
});

test("sweep + reserve always equals what was held, at any price", () => {
  // The invariant that matters: recovery must never invent or lose wei.
  for (const held of [0n, 1n, 10n ** 15n, 10n ** 18n, 10n ** 21n]) {
    for (const price of [0n, 1n, 10n ** 9n, 10n ** 12n]) {
      const { sweep, reserve } = nativeSweep(held, price);
      assert.equal(sweep + reserve, held, `held=${held} price=${price}`);
      assert.ok(sweep >= 0n && reserve >= 0n, "no negative legs");
    }
  }
});
