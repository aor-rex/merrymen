/**
 * Deploy PonsClassVaultFactoryV2 — the factory whose vaults hold ONE CEILING PER
 * QUOTE ASSET.
 *
 *   $env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"     # shell-only; close it after
 *   $env:MERRYMEN_V2_SEED = "USDG:250,NVDA:25"     # USD per quote, not raw
 *   npm run deploy:classfactoryv2:testnet
 *   npm run deploy:classfactoryv2:mainnet
 *
 * THROUGH THE NPM SCRIPT, NOT `npx hardhat run`. hardhat.config.ts is ESM+TS and
 * the bare CLI has no loader for it; the script entries carry `--import tsx`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEED IS WRITTEN IN DOLLARS AND SEALED IN RAW UNITS, AND THIS SCRIPT IS
 * WHERE THE TRANSLATION HAPPENS.
 *
 * The vault compares a raw `quoteIn` against a raw number for that exact
 * address. It reads no price and no ERC-8056 share multiplier, ever — that is
 * the rule. So the conversion from "twenty-five dollars of NVDA" into a share
 * count has to happen exactly once, off chain, before anything is sealed, and
 * it has to be done from the same trusted sources the rest of the system uses:
 * the token's own Chainlink feed and its own `uiMultiplier()`. Both are read
 * live, here, and both are printed with their arithmetic so the operator can
 * see the number they are actually sealing rather than a number a script chose.
 *
 * A FEED THAT IS STALE, A MULTIPLIER THAT WILL NOT READ, OR A PAUSED TOKEN
 * STOPS THE DEPLOY. A cap sized from a weekend price is a cap nobody agreed to,
 * and Chainlink's equity feeds run 24/5 — so this script must be run inside US
 * market hours, and it says so rather than quietly using the last print.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THE SEED IS, AND WHAT IT IS NOT
 *
 * It is a FLEET-WIDE, deliberately conservative BIRTH ceiling: the floor under
 * which the route is usable with no ceremony at all, because a vault is created
 * inside the same UserOperation as its first buy and that batch reverts whole,
 * so there is no second transaction to seal caps in. It is NOT any one owner's
 * risk allowance. An owner refines their own vault afterwards with
 * `setQuoteCaps`, which never moves the vault's address.
 *
 * The asymmetry is deliberate: a birth default that is too LOW costs a refusal
 * an owner can fix, and one that is too HIGH is a ceiling nobody agreed to.
 *
 * READ docs/owner-runbook-class-v2.md BEFORE RUNNING THIS.
 */
import hre from "hardhat";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { concat, encodeAbiParameters, keccak256 } from "viem";
import { MAX_CAP, UI_ONE, rawCapFor } from "./lib/quote-caps";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWN_CHAINS: Record<number, string> = {
  46630: "Robinhood Chain testnet",
  4663: "Robinhood Chain MAINNET — real funds",
};

/**
 * The quote assets this script will seal, cross-referenced against
 * packages/core/src/tokens.ts (CASH, STOCK_TOKENS, CASH_FEEDS).
 *
 * DUPLICATED RATHER THAN IMPORTED, because contracts/ does not depend on
 * packages/ and a deploy script that reaches across the repo is a deploy script
 * that fails differently in CI than in a shell. The duplication is made safe by
 * checking every address ON CHAIN below — decimals, feed, multiplier, pause —
 * so a stale paste fails at deploy time instead of being sealed into a factory.
 */
const QUOTES: Record<string, { address: `0x${string}`; feed: `0x${string}` | null; decimals: number }> = {
  USDG: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", feed: null, decimals: 6 },
  NVDA: { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", decimals: 18 },
  SPY: { address: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", feed: "0x319724394D3A0e3669269846abE664Cd621f9f6A", decimals: 18 },
  META: { address: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", feed: "0x7C38C00C30BEe9378381E7B6135d7283356D71b1", decimals: 18 },
  GOOGL: { address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", feed: "0xF6f373a037c30F0e5010d854385cA89185AE638b", decimals: 18 },
};

/** The worker's own staleness rule, restated: a feed older than this is stale. */
const FEED_STALE_AFTER_SEC = 2 * 3600;

const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;
const STOCK_ABI = [
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "tokenPaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;
const CHAINLINK_ABI = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint80" },
      { type: "int256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint80" },
    ],
  },
] as const;
const FACTORY_ABI = [
  { type: "function", name: "FACTORY_VERSION", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "vaultFor", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "vaultInitCodeHash", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "seedQuoteSet",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }, { type: "uint256[]" }],
  },
] as const;

function parseSeed(raw: string): { symbol: string; usd: number }[] {
  const out: { symbol: string; usd: number }[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [symbol, usdText] = part.split(":").map((s) => s.trim());
    if (!symbol || !usdText) throw new Error(`MERRYMEN_V2_SEED entry "${part}" is not SYMBOL:USD`);
    if (!(symbol in QUOTES)) {
      throw new Error(`MERRYMEN_V2_SEED names ${symbol}, which this script has no address for. Known: ${Object.keys(QUOTES).join(", ")}`);
    }
    const usd = Number(usdText);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error(`${symbol}: "${usdText}" is not a positive dollar figure`);
    // A REPEATED SYMBOL IS A TYPO, NEVER AN INTENTION, and it used to be the
    // cheapest way to brick a factory for ever: two entries resolve to one
    // address, the vault constructor refuses a duplicate, and every deploy()
    // reverts for every owner. The factory now refuses it too, so this is the
    // second of three fences — but it is the one that says which symbol.
    if (out.some((q) => q.symbol === symbol)) {
      throw new Error(`MERRYMEN_V2_SEED names ${symbol} twice. Two entries for one asset is one asset.`);
    }
    out.push({ symbol, usd });
  }
  if (out.length === 0) throw new Error("MERRYMEN_V2_SEED is empty — a factory with no seed mints vaults that can buy nothing");
  if (!out.some((q) => q.symbol === "USDG")) {
    // Every existing agent's route is USDG. A seed without it ships a factory
    // whose vaults cannot do the thing the fleet already does.
    throw new Error("MERRYMEN_V2_SEED must include USDG — every current class entry is funded in it");
  }
  if (out.length > 8) throw new Error("the vault tracks at most 8 quotes (MAX_QUOTES)");
  return out;
}

async function main() {
  const publicClient = await hre.viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  if (!(chainId in KNOWN_CHAINS)) {
    throw new Error(`refusing to deploy to unknown chain ${chainId}. Check --network.`);
  }

  const [deployer] = await hre.viem.getWalletClients();
  if (!deployer) throw new Error("no deployer — set MERRYMEN_DEPLOYER_PRIVATE_KEY in this shell.");
  if ((await publicClient.getBalance({ address: deployer.account.address })) === 0n) {
    throw new Error(`deployer ${deployer.account.address} holds no ETH on ${KNOWN_CHAINS[chainId]}.`);
  }

  const seed = parseSeed(process.env.MERRYMEN_V2_SEED ?? "");
  const now = Math.floor(Date.now() / 1000);

  console.log(`deploying PonsClassVaultFactoryV2 to ${KNOWN_CHAINS[chainId]} (${chainId})`);
  console.log(`  from ${deployer.account.address}`);
  console.log("");
  console.log("  sizing each seed cap from its live feed and share multiplier:");

  const quotes: `0x${string}`[] = [];
  const caps: bigint[] = [];
  for (const { symbol, usd } of seed) {
    const q = QUOTES[symbol]!;

    // The address is checked against the chain, not trusted from the table.
    const dp = Number(
      await publicClient.readContract({ address: q.address, abi: ERC20_ABI, functionName: "decimals" }),
    );
    if (dp !== q.decimals) {
      throw new Error(`${symbol} at ${q.address} reports ${dp} decimals, not ${q.decimals} — wrong address, or the table is stale.`);
    }

    if (q.feed === null) {
      // USDG is a dollar: price exactly 1.0, multiplier exactly 1.0, nothing to
      // read and nothing to go stale. SAME FUNCTION as every other quote, so the
      // short-circuit cannot drift into being a second, different rule.
      const raw = rawCapFor(usd, dp, 100_000_000n, UI_ONE);
      // THE SAME TWO GUARDS THE STOCK BRANCH APPLIES. This branch skipped them
      // because "it is a dollar, what could go wrong" — and an absurd figure
      // would have sealed a cap past the vault's uint96 slot, which the factory
      // accepts and the vault refuses, bricking every deploy.
      if (raw === 0n) throw new Error(`${symbol}: ${usd} rounds to zero raw units.`);
      if (raw > MAX_CAP) throw new Error(`${symbol}: ${usd} is ${raw} raw, past the vault's uint96 slot.`);
      console.log(`    ${symbol.padEnd(6)} ${String(usd).padStart(6)}  →  ${raw} raw (${dp}dp, a dollar by definition)`);
      quotes.push(q.address);
      caps.push(raw);
      continue;
    }

    const round = (await publicClient.readContract({
      address: q.feed,
      abi: CHAINLINK_ABI,
      functionName: "latestRoundData",
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    const price8 = round[1];
    const updatedAt = Number(round[3]);
    if (price8 <= 0n) throw new Error(`${symbol}: its feed answered ${price8}. Refusing to size a cap on that.`);
    const age = now - updatedAt;
    if (age > FEED_STALE_AFTER_SEC) {
      throw new Error(
        `${symbol}: its Chainlink feed last printed ${Math.round(age / 60)} minutes ago, past the ${FEED_STALE_AFTER_SEC / 3600}h rule. ` +
          `Equity feeds run 24/5 — run this inside US market hours. A cap sized from a weekend price is a cap nobody agreed to.`,
      );
    }

    const uiMultiplier = (await publicClient.readContract({
      address: q.address,
      abi: STOCK_ABI,
      functionName: "uiMultiplier",
    })) as bigint;
    if (uiMultiplier <= 0n) throw new Error(`${symbol}: uiMultiplier answered ${uiMultiplier}.`);
    const paused = (await publicClient.readContract({
      address: q.address,
      abi: STOCK_ABI,
      functionName: "tokenPaused",
    })) as boolean;
    if (paused) throw new Error(`${symbol} is PAUSED by its issuer right now. Not sealing a cap for it.`);

    const raw = rawCapFor(usd, dp, price8, uiMultiplier);
    if (raw === 0n) throw new Error(`${symbol}: $${usd} rounds to zero raw units at this price.`);
    if (raw > MAX_CAP) throw new Error(`${symbol}: ${usd} is ${raw} raw, past the vault's uint96 slot.`);
    console.log(
      `    ${symbol.padEnd(6)} $${String(usd).padStart(6)}  →  ${raw} raw  ` +
        `($${(Number(price8) / 1e8).toFixed(2)}/share, multiplier ${uiMultiplier === UI_ONE ? "1.0" : uiMultiplier.toString()}, ` +
        `feed ${Math.round(age / 60)}m old)`,
    );
    quotes.push(q.address);
    caps.push(raw);
  }

  console.log("");
  console.log(`  every vault this factory makes is BORN with those ${caps.length} ceilings, and no others.`);
  console.log("");

  const factory = await hre.viem.deployContract("PonsClassVaultFactoryV2", [quotes, caps]);
  const code = await publicClient.getCode({ address: factory.address });
  if (!code || code === "0x") throw new Error(`deployment reported success but ${factory.address} has no code.`);

  // ── THE THREE CHECKS THAT MUST PASS BEFORE ANYONE SIGNS AGAINST THIS ──────
  const version = await publicClient.readContract({ address: factory.address, abi: FACTORY_ABI, functionName: "FACTORY_VERSION" });
  if (Number(version) !== 2) throw new Error(`FACTORY_VERSION answered ${version}, not 2 — do NOT use this deployment.`);

  // The wall pins a vault address at signing time and the vault is created
  // later. If prediction and production ever disagreed, every class permission
  // would name a contract that never comes into existence — and a CALL to a
  // codeless address SUCCEEDS with empty returndata, so the failure would be a
  // silent no-op reported as a landed trade.
  const probe = deployer.account.address;
  const predicted = (await publicClient.readContract({
    address: factory.address, abi: FACTORY_ABI, functionName: "vaultFor", args: [probe],
  })) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(predicted) || /^0x0{40}$/i.test(predicted)) {
    throw new Error(`vaultFor returned ${predicted} — do NOT use this deployment.`);
  }

  // And the bytecode it will CREATE2 with is the bytecode in this working tree.
  // FACTORY_VERSION is a number any contract could return; this is the artifact.
  const artifact = await hre.artifacts.readArtifact("PonsClassVaultV2");
  const localHash = keccak256(
    concat([
      artifact.bytecode as `0x${string}`,
      encodeAbiParameters([{ type: "address" }, { type: "address[]" }, { type: "uint256[]" }], [probe, quotes, caps]),
    ]),
  );
  const onChainHash = await publicClient.readContract({
    address: factory.address, abi: FACTORY_ABI, functionName: "vaultInitCodeHash", args: [probe],
  });
  if (onChainHash !== localHash) {
    throw new Error(
      `the factory will CREATE2 bytecode this working tree did not compile.\n` +
        `  on chain: ${onChainHash}\n  local:    ${localHash}\n` +
        `Do NOT use this deployment — it was built from a different commit.`,
    );
  }
  // THE GATE WORTH MORE THAN THE OTHER THREE, because it exercises the path
  // instead of restating it. The three checks above all pass on a factory that
  // can never produce a vault: the bytecode is correct and only the constructor
  // ARGUMENTS are poisoned, so the init code hash matches, vaultFor answers a
  // real address, and FACTORY_VERSION answers 2. Only calling deploy finds out.
  //
  // Simulated, not sent. It must not actually create the probe's vault — that
  // would consume the CREATE2 address for an owner who never asked for one.
  let simulated: `0x${string}`;
  try {
    const sim = await publicClient.simulateContract({
      address: factory.address,
      abi: [{ type: "function", name: "deploy", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "address" }] }] as const,
      functionName: "deploy",
      args: [probe],
      account: deployer.account,
    });
    simulated = sim.result as `0x${string}`;
  } catch (e) {
    throw new Error(
      `the factory deployed, but deploy() REVERTS — for this owner and therefore for every owner.\n` +
        `  ${e instanceof Error ? e.message.split("\n")[0] : String(e)}\n` +
        `The seed is the only thing passed to a vault, so this is the seed. Do NOT record this address; ` +
        `there is no setter and no admin, so the factory cannot be corrected — fix the seed and redeploy.`,
    );
  }
  if (simulated.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error(`deploy() would produce ${simulated} but vaultFor predicts ${predicted}. Do NOT use this deployment.`);
  }

  console.log(`  vaultFor(${probe.slice(0, 10)}…) → ${predicted}`);
  console.log(`  init code hash matches the local artifact`);
  console.log(`  deploy() simulates to the same address, so this factory can actually make a vault`);

  const file = path.join(__dirname, "..", "deployments.json");
  let book: Record<string, Record<string, unknown>> = {};
  try {
    book = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* first deployment on this chain */
  }
  const chainKey = String(chainId);
  book[chainKey] = {
    ...(book[chainKey] ?? {}),
    PonsClassVaultFactoryV2: {
      address: factory.address,
      deployedAt: new Date().toISOString(),
      codeBytes: (code.length - 2) / 2,
      // WHAT WAS SEALED, recorded beside the address: the caps are not readable
      // as dollars on chain, and "what did we seed, and at what price" is the
      // first question anyone asks six months later.
      seed: seed.map(({ symbol, usd }, i) => ({ symbol, usd, address: quotes[i], capRaw: caps[i]!.toString() })),
      vaultInitCodeHash: onChainHash,
    },
  };
  writeFileSync(file, JSON.stringify(book, null, 2) + "\n");

  console.log("");
  console.log(`✓ PonsClassVaultFactoryV2 deployed at ${factory.address}`);
  console.log(`  recorded in contracts/deployments.json under chain ${chainKey} — COMMIT THIS`);
  console.log(`  code : ${(code.length - 2) / 2} bytes`);
  console.log("");
  console.log("next steps — docs/owner-runbook-class-v2.md has them in full:");
  console.log("  1. put this address in PONS_CLASS_VAULT_FACTORY_V2 in packages/core/src/protocols.ts");
  console.log("     and LEAVE the v1 constant alone — a v1 vault may still hold a position");
  console.log("  2. flatten the v1 vault first: SELL the open position, then sweep the residue");
  console.log("  3. RE-SIGN at /grant. The v2 vault is a different address; the wall seals it");
  console.log("  4. prove the USDG route on the new vault before any non-USDG quote is used");
  console.log("  5. unset MERRYMEN_DEPLOYER_PRIVATE_KEY / close this shell");
  console.log("");
  console.log("what this does NOT unlock:");
  console.log("  - native-ETH-quoted curves. Still refused by name, still valueLimit 0 everywhere.");
  console.log("  - a non-USDG entry. The vault would now ACCEPT one, and nothing else would:");
  console.log("    the wall still pins the buy's quote word to USDG, the producer still refuses a");
  console.log("    non-USDG candidate, and the ledger still books quoteIn as USDG at 6dp.");
  console.log("  - any provenance guarantee from the chain. Nothing on chain vouches for a class");
  console.log("    token; the worker's factory-filtered launch feed is still the only check.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
