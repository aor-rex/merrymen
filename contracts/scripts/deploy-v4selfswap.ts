/**
 * Deploy V4SelfSwap — the one contract that makes Uniswap v4 constrainable by
 * the permission wall.
 *
 * RUN BY THE OWNER, deliberately. Deployment spends real gas from a real key,
 * and this repo's agent never handles owner keys or moves funds on its own.
 * The key is read from the environment by hardhat.config.ts and is never
 * logged, written, or echoed by this script — only the ADDRESS it derives to.
 *
 *   $env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"   # shell-only; close it after
 *   npx hardhat run scripts/deploy-v4selfswap.ts --network robinhoodTestnet
 *   npx hardhat run scripts/deploy-v4selfswap.ts --network robinhood
 *
 * The two runs produce two DIFFERENT addresses (independent nonces per chain).
 * Paste each into /settings as `v4AdapterAddress` on the machine that signs
 * grants for that chain, then RE-SIGN the grant — the address is sealed into
 * the signature, so the setting alone changes nothing.
 */
import hre from "hardhat";

/**
 * The canonical Uniswap v4 PoolManager, same address on 46630 and 4663
 * (verified live on both, 2026-08-26). Pinned here rather than imported
 * because the contracts package deliberately has no dependency on
 * packages/core — cross-reference: packages/core/src/protocols.ts
 * UNISWAP.v4PoolManager. If these ever disagree, the post-deploy check
 * below is what catches it.
 */
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951" as const;

/** The only chains this should ever touch. Anything else is a mistake. */
const KNOWN_CHAINS: Record<number, string> = {
  46630: "Robinhood Chain testnet",
  4663: "Robinhood Chain MAINNET — real funds",
};

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  if (!(chainId in KNOWN_CHAINS)) {
    throw new Error(
      `refusing to deploy to unknown chain ${chainId} — this script only knows ` +
        `Robinhood Chain testnet (46630) and mainnet (4663). Check --network.`,
    );
  }

  const wallets = await hre.viem.getWalletClients();
  if (wallets.length === 0) {
    throw new Error(
      "no deployer account. Set MERRYMEN_DEPLOYER_PRIVATE_KEY in this shell " +
        "(it is read by hardhat.config.ts and never logged), then re-run.",
    );
  }
  const deployer = wallets[0]!.account.address;
  console.log(`chain    : ${chainId} (${KNOWN_CHAINS[chainId]})`);
  console.log(`deployer : ${deployer}`);

  // Fail BEFORE gas is spent when the PoolManager is not where we think it is.
  // The constructor checks too (NotAContract), but a refusal here is free.
  const pmCode = await publicClient.getCode({ address: POOL_MANAGER });
  if (pmCode === undefined || pmCode === "0x") {
    throw new Error(`PoolManager ${POOL_MANAGER} has no code on chain ${chainId} — wrong chain or wrong registry.`);
  }

  const balance = await publicClient.getBalance({ address: deployer });
  console.log(`balance  : ${Number(balance) / 1e18} ETH`);
  if (balance === 0n) {
    throw new Error("deployer has no ETH — fund it first (testnet: https://faucet.testnet.chain.robinhood.com).");
  }

  console.log("deploying V4SelfSwap…");
  const adapter = await hre.viem.deployContract("V4SelfSwap", [POOL_MANAGER]);

  // POST-VERIFY, against the chain rather than against hope: the code must be
  // there, and the immutable must point at the PoolManager we named. A deploy
  // that silently bound to the wrong singleton would revert on every swap —
  // better to learn that here than from the first live trade.
  const code = await publicClient.getCode({ address: adapter.address });
  if (code === undefined || code === "0x") {
    throw new Error(`deploy reported ${adapter.address} but there is no code there — inspect the transaction.`);
  }
  const bound = (await adapter.read.poolManager()) as string;
  if (bound.toLowerCase() !== POOL_MANAGER.toLowerCase()) {
    throw new Error(`adapter is bound to ${bound}, expected ${POOL_MANAGER} — do NOT use this deployment.`);
  }

  console.log("");
  console.log(`✓ V4SelfSwap deployed at ${adapter.address}`);
  console.log(`  code           : ${(code.length - 2) / 2} bytes`);
  console.log(`  poolManager()  : ${bound}`);
  console.log("");
  console.log("next steps:");
  console.log(`  1. paste ${adapter.address} into /settings as "v4 adapter contract" (v4AdapterAddress)`);
  console.log("  2. RE-SIGN the grant at /grant — the address is sealed into the signature,");
  console.log("     so the setting alone changes nothing");
  console.log("  3. unset MERRYMEN_DEPLOYER_PRIVATE_KEY / close this shell");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
