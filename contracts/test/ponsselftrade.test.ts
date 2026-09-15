import { expect } from "chai";
import hre from "hardhat";
import { getAddress, parseEventLogs } from "viem";

/**
 * PonsSelfTrade — the contract that exists so the wall can say something true
 * about a bonding-curve trade.
 *
 * The CURVE MECHANICS it depends on (that a live curve carries buy/sell/token/
 * pairToken/graduated in its runtime code, that buy pulls its input from its
 * caller by transferFrom, that both sides pay a caller-named `recipient`
 * directly, and that a native-quoted curve requires msg.value == quoteIn
 * exactly) were verified against Robinhood Chain MAINNET during design, by
 * reading a live curve's bytecode and simulating a buy through eth_call. Those
 * facts are not re-litigated here and a mock could not prove them anyway.
 *
 * What IS proved here is the half that is ours, and every claim the security
 * argument rests on: the payer is the caller, the payee is the caller, the
 * adapter keeps nothing, a hostile curve that takes the money and pays nothing
 * is REFUSED rather than silently absorbed, a graduated curve is refused by
 * name, native-quoted curves are refused by name, and the whole thing cannot be
 * re-entered.
 */

/**
 * The error name, from EITHER place hardhat puts it — a decoded `data.errorName`
 * on the simulate error, or the message text. Same helper as
 * v4selfswap.test.ts, for the same reason: a parameterless custom error decodes
 * into the message while a parameterised one surfaces only as "an unknown RPC
 * error", so reading one of them makes tests pass for the wrong reason.
 */
function errorNameOf(e: unknown): string {
  const walk = (x: unknown): string | undefined => {
    const o = x as { data?: { errorName?: string }; cause?: unknown };
    return o?.data?.errorName ?? (o?.cause ? walk(o.cause) : undefined);
  };
  const decoded = walk(e);
  if (decoded) return decoded;
  const text = String((e as Error)?.message ?? e);
  return /custom error '(\w+)\(/.exec(text)?.[1] ?? text;
}

const MAX = 2n ** 255n;
const FOREVER = 2n ** 48n;

async function setup() {
  const [wallet] = await hre.viem.getWalletClients();
  const account = wallet!.account.address;
  const publicClient = await hre.viem.getPublicClient();

  const quote = await hre.viem.deployContract("PonsMockERC20");
  const token = await hre.viem.deployContract("PonsMockERC20");
  const curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
  const adapter = await hre.viem.deployContract("PonsSelfTrade");

  // The account holds quote; the curve holds inventory to pay out.
  await quote.write.mint([account, 1_000_000n]);
  await token.write.mint([curve.address, 10_000_000n]);
  await quote.write.mint([curve.address, 10_000_000n]);
  // The standing allowance the wall caps — the adapter's only spending power.
  await quote.write.approve([adapter.address, MAX]);
  await token.write.approve([adapter.address, MAX]);

  return { account, publicClient, quote, token, curve, adapter };
}

async function revertName(
  adapter: { address: `0x${string}`; abi: readonly unknown[] },
  args: readonly unknown[],
  account: `0x${string}`,
): Promise<string> {
  const publicClient = await hre.viem.getPublicClient();
  try {
    await publicClient.simulateContract({
      address: adapter.address,
      abi: adapter.abi as never,
      functionName: "tradeExactIn",
      args: args as never,
      account,
    });
    return "";
  } catch (e) {
    return errorNameOf(e);
  }
}

describe("PonsSelfTrade", () => {
  describe("the invariant: paid from the caller, delivered to the caller", () => {
    it("buys, and the tokens land on the ACCOUNT — never on the adapter", async () => {
      const { account, quote, token, curve, adapter } = await setup();
      await adapter.write.tradeExactIn([curve.address, quote.address, token.address, 1_000n, 1n, FOREVER]);

      expect(await token.read.balanceOf([account])).to.equal(2_000n); // rate 2:1
      expect(await quote.read.balanceOf([account])).to.equal(999_000n);
      // The whole product, asserted: the adapter is a pipe, not a pocket.
      expect(await token.read.balanceOf([adapter.address])).to.equal(0n);
      expect(await quote.read.balanceOf([adapter.address])).to.equal(0n);
    });

    it("sells the same way, in the other direction", async () => {
      const { account, quote, token, curve, adapter } = await setup();
      await token.write.mint([account, 5_000n]);
      await adapter.write.tradeExactIn([curve.address, token.address, quote.address, 5_000n, 1n, FOREVER]);

      expect(await quote.read.balanceOf([account])).to.equal(1_010_000n); // 1,000,000 + 10,000
      expect(await token.read.balanceOf([adapter.address])).to.equal(0n);
      expect(await quote.read.balanceOf([adapter.address])).to.equal(0n);
    });

    it("leaves NO standing allowance to the curve", async () => {
      // A residual approval would let the curve move the adapter's assets in
      // some later transaction. The adapter holds nothing, so there is normally
      // nothing to take — but an allowance that outlives its call is a licence,
      // and this contract's whole value is not handing out licences.
      const { quote, token, curve, adapter } = await setup();
      await adapter.write.tradeExactIn([curve.address, quote.address, token.address, 1_000n, 1n, FOREVER]);
      expect(await quote.read.allowance([adapter.address, curve.address])).to.equal(0n);
    });

    it("returns the residue when a curve takes less than it was approved for", async () => {
      // Otherwise the difference sits in the adapter forever: there is no
      // rescue function, deliberately, so anything stranded is gone.
      const { account, quote, token, curve, adapter } = await setup();
      await curve.write.setTakeFraction([60n]);
      await adapter.write.tradeExactIn([curve.address, quote.address, token.address, 1_000n, 1n, FOREVER]);

      expect(await quote.read.balanceOf([adapter.address])).to.equal(0n, "nothing may strand in the adapter");
      // 1,000 pulled, 600 taken, 400 handed back.
      expect(await quote.read.balanceOf([account])).to.equal(999_400n);
    });

    it("emits the trade with what the account ACTUALLY gained", async () => {
      const { account, publicClient, quote, token, curve, adapter } = await setup();
      const hash = await adapter.write.tradeExactIn([
        curve.address, quote.address, token.address, 1_000n, 1n, FOREVER,
      ]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const [log] = parseEventLogs({ abi: adapter.abi, eventName: "SelfTrade", logs: receipt.logs });
      expect(getAddress(log!.args.account)).to.equal(getAddress(account));
      expect(log!.args.amountOut).to.equal(2_000n);
    });
  });

  describe("a curve is untrusted, and the adapter does not take its word", () => {
    it("REFUSES a curve that takes the input and pays nothing", async () => {
      // The claim the threat model rests on. A hostile curve returns a huge
      // amountOut and sends nothing; the adapter measures the ACCOUNT's balance
      // rather than believing the return value, so this reverts and the whole
      // transaction — including the pull — is undone.
      const { account, quote, token, adapter } = await setup();
      const hostile = await hre.viem.deployContract("MockHostileCurve", [token.address, quote.address]);
      const name = await revertName(
        adapter, [hostile.address, quote.address, token.address, 1_000n, 1n, FOREVER], account,
      );
      expect(name).to.equal("NoOutput");
    });

    it("refuses when the gain is under the floor, even when the CURVE accepts it", async () => {
      // A curve that ignores the floor it was handed and underpays. The
      // guarantee has to be the adapter's: the curve is the party with an
      // interest in the answer, and asking it to grade its own work is not a
      // check. Here it takes 1,000, pays 10, and claims uint128 max.
      const { account, quote, token, adapter } = await setup();
      const liar = await hre.viem.deployContract("MockHostileCurve", [token.address, quote.address]);
      await token.write.mint([liar.address, 1_000_000n]);
      await liar.write.setPayBps([100n]); // 1% of the input
      const name = await revertName(
        adapter, [liar.address, quote.address, token.address, 1_000n, 5_000n, FOREVER], account,
      );
      expect(name).to.equal("InsufficientOutput");
    });

    it("cannot be re-entered while it holds the input", async () => {
      const { account, quote, token, adapter } = await setup();
      const reentrant = await hre.viem.deployContract("MockReentrantCurve", [token.address, quote.address]);
      await reentrant.write.setAdapter([adapter.address]);
      const name = await revertName(
        adapter, [reentrant.address, quote.address, token.address, 1_000n, 1n, FOREVER], account,
      );
      expect(name).to.equal("Reentrant");
    });
  });

  describe("refusals that name what is wrong", () => {
    it("refuses a NATIVE-quoted curve by name", async () => {
      // 53.6% of launches. Refused deliberately and explicitly, so the worker
      // can quarantine on the reason instead of seeing an anonymous failure.
      const { account, quote, token, adapter } = await setup();
      const native = await hre.viem.deployContract("MockPonsCurve", [
        token.address, "0x0000000000000000000000000000000000000000",
      ]);
      const name = await revertName(
        adapter, [native.address, quote.address, token.address, 1_000n, 1n, FOREVER], account,
      );
      expect(name).to.equal("NativeQuoteNotSupported");
    });

    it("refuses a GRADUATED curve, whose reserves look perfectly healthy", async () => {
      const { account, quote, token, curve, adapter } = await setup();
      await curve.write.setGraduated([true]);
      const name = await revertName(
        adapter, [curve.address, quote.address, token.address, 1_000n, 1n, FOREVER], account,
      );
      expect(name).to.equal("CurveGraduated");
    });

    it("refuses assets that are not the two sides of THIS curve", async () => {
      // Without this, a direction could be inferred from the caller's claim and
      // acted on against a different market.
      const { account, quote, token, curve, adapter } = await setup();
      const other = await hre.viem.deployContract("PonsMockERC20");
      const name = await revertName(
        adapter, [curve.address, quote.address, other.address, 1_000n, 1n, FOREVER], account,
      );
      expect(name).to.equal("AssetsDoNotMatchCurve");
    });

    it("refuses an expired deadline", async () => {
      const { account, quote, token, curve, adapter } = await setup();
      const name = await revertName(
        adapter, [curve.address, quote.address, token.address, 1_000n, 1n, 1n], account,
      );
      expect(name).to.equal("Expired");
    });

    it("refuses zero, identical assets, and a non-contract", async () => {
      const { account, quote, token, curve, adapter } = await setup();
      expect(await revertName(
        adapter, [curve.address, quote.address, token.address, 0n, 1n, FOREVER], account,
      )).to.equal("ZeroAmount");
      expect(await revertName(
        adapter, [curve.address, quote.address, quote.address, 1_000n, 1n, FOREVER], account,
      )).to.equal("IdenticalAssets");
      expect(await revertName(
        adapter, [curve.address, "0x000000000000000000000000000000000000dEaD", token.address, 1_000n, 1n, FOREVER], account,
      )).to.equal("NotAContract");
    });
  });

  describe("the ERC-20s this chain is actually full of", () => {
    it("works with a token that refuses a non-zero to non-zero approval", async () => {
      // USDT-shaped. The adapter zeroes before setting, so this passes; a plain
      // `approve(amount)` would revert on the second trade of the same pair.
      const [wallet] = await hre.viem.getWalletClients();
      const account = wallet!.account.address;
      const quote = await hre.viem.deployContract("PonsMockStickyApprovalERC20");
      const token = await hre.viem.deployContract("PonsMockERC20");
      const curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
      const adapter = await hre.viem.deployContract("PonsSelfTrade");
      await quote.write.mint([account, 10_000n]);
      await token.write.mint([curve.address, 100_000n]);
      await quote.write.approve([adapter.address, MAX]);

      await adapter.write.tradeExactIn([curve.address, quote.address, token.address, 1_000n, 1n, FOREVER]);
      // The second trade is the one that would fail on a naive approve.
      await adapter.write.tradeExactIn([curve.address, quote.address, token.address, 1_000n, 1n, FOREVER]);
      expect(await token.read.balanceOf([account])).to.equal(4_000n);
    });
  });

  describe("the contract has no reach beyond one caller", () => {
    it("has no owner, no pause, no upgrade and no rescue", async () => {
      // Asserted against the ABI rather than promised in a comment. A rescue
      // function is a "send assets to an address" function, and not having one
      // is the point of the contract.
      const { adapter } = await setup();
      const names = (adapter.abi as { type: string; name?: string }[])
        .filter((e) => e.type === "function")
        .map((e) => e.name);
      expect(names).to.deep.equal(["tradeExactIn"]);
      for (const banned of ["owner", "pause", "upgradeTo", "rescue", "sweep", "withdraw"]) {
        expect(names).to.not.include(banned);
      }
    });

    it("is NOT payable, which is what lets the wall keep valueLimit at zero", async () => {
      const { adapter } = await setup();
      const fn = (adapter.abi as { type: string; name?: string; stateMutability?: string }[])
        .find((e) => e.type === "function" && e.name === "tradeExactIn");
      expect(fn!.stateMutability).to.equal("nonpayable");
      // And there is no receive/fallback to take ETH another way.
      const kinds = (adapter.abi as { type: string }[]).map((e) => e.type);
      expect(kinds).to.not.include("receive");
      expect(kinds).to.not.include("fallback");
    });

    it("cannot spend one caller's allowance on behalf of another", async () => {
      // The adapter pulls only from msg.sender, so a standing allowance is not
      // a licence anyone else can use.
      const wallets = await hre.viem.getWalletClients();
      const [a, b] = wallets;
      const quote = await hre.viem.deployContract("PonsMockERC20");
      const token = await hre.viem.deployContract("PonsMockERC20");
      const curve = await hre.viem.deployContract("MockPonsCurve", [token.address, quote.address]);
      const adapter = await hre.viem.deployContract("PonsSelfTrade");
      await quote.write.mint([a!.account.address, 10_000n]);
      await token.write.mint([curve.address, 100_000n]);
      await quote.write.approve([adapter.address, MAX]); // approved by A only

      // B trades with no balance and no approval of its own. A's money is not
      // reachable: the pull names msg.sender, which is B.
      const name = await revertName(
        adapter, [curve.address, quote.address, token.address, 1_000n, 1n, FOREVER], b!.account.address,
      );
      expect(name).to.equal("TransferFailed");
      expect(await quote.read.balanceOf([a!.account.address])).to.equal(10_000n);
    });
  });
});
