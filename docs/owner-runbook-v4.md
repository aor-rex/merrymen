# Owner runbook — memecoins and new pairs via the v4 adapter

Everything the software can do is done and committed. This file is the part
only you can do, in the order it has to happen. Each step names what it
unblocks; nothing here is optional if the goal is "trade all, including new
pairs."

## Already done for you (no action)

- `V4SelfSwap` contract written, tested (20 tests), attacked, and verified
  against mainnet by simulation. The recipient is `msg.sender` in bytecode.
- Wall permission, grant marker, worker mirror, execution path, discovery
  PoolKey capture, and routing over discovered (hooked) pools — all committed
  with tests (975 worker tests green).
- Settings profile for a memecoin-primary run:
  `basketSymbols ["QQQ"]`, `buyPerTickUsdg 50`, `idleFloorUsdg 200`,
  `scoutEnabled true`, `scoutBudgetUsdg 100`, `scoutPerTokenUsdg 25`,
  `minPoolLiquidityUsdg 10000`, `maxPriceDivergenceBps 2000`,
  `slippageBps 300`, `maxImpactBps 300`.
- The renew button on `/grant` is now trustworthy: it fetches settings at
  click time and signs on the chain the page shows.

## Step 1 — Bitquery API key

Discovery is how merrymen SEES new pairs (they launch through hooks on v4;
the hook address can only be learned from the Initialize event, and Bitquery
indexes those). Without a key, discovery stays silently off.

- Get a key at bitquery.io (free tier is fine to start).
- Paste it into `/settings` → `bitqueryApiKey`. Nothing else to configure;
  `discoveryEnabled` is already on.

## Step 2 — Deploy the adapter (twice)

Deployment spends real gas from a real key, so it is yours to run. The key is
read from the environment and never logged; the script prints only addresses.

In PowerShell, from `contracts/`:

```powershell
$env:MERRYMEN_DEPLOYER_PRIVATE_KEY = "0x…"   # a funded EOA; close this shell after
npx hardhat run scripts/deploy-v4selfswap.ts --network robinhoodTestnet
npx hardhat run scripts/deploy-v4selfswap.ts --network robinhood
```

- Testnet gas: free at https://faucet.testnet.chain.robinhood.com
- Mainnet gas: a small amount of ETH on chain 4663.
- The two runs print two DIFFERENT addresses. That is correct (independent
  nonces). The script refuses wrong chains, missing keys, and a missing
  PoolManager, and verifies the deploy before printing success.
- Paste the MAINNET address into `/settings` → "v4 adapter contract".
  (Use the testnet address only if you sign a testnet grant to rehearse.)

## Step 3 — Name your memecoins

A token must be in your settings AT SIGNING TIME to be tradeable — the
sell-approve permission is sealed into the signature (the no-exit rule).

- `/settings` → "your own tokens": symbol, contract address, and **exact**
  decimals for each token you want to trade now. Wrong decimals mis-value the
  holding by orders of magnitude.
- Tick the same symbols into the basket list, in the same save. In
  `customTokens` = watched and sellable; in `basketSymbols` = actually traded.

## Step 4 — Re-sign on mainnet

- Open `/grant` → **restore a funded wallet** tab.
- Click the **mainnet · 4663** pill and tick the acknowledgement.
- Paste your owner key (the one you backed up), **check this wallet** — it
  must show `0xbC78E8…75D7`. A different address means the wrong key.
- Set "most it can spend on one trade" to at least 60 (your tick is 50; zero
  headroom invites `per-trade-cap` edge rejections).
- Sign. Then verify `~/.merrymen/grant.json` contains:
  - `"chainId": 4663`
  - `"grantTokens": [...]` listing your memecoin addresses
  - `"v4-adapter"` in `grantFeatures`, and `"v4AdapterAddress"` = the mainnet
    adapter you pasted in step 2.

If any of those is missing, the settings save and the signature crossed —
hard-reload `/grant` and sign again.

## Step 5 — Fund the smart account

Send to your smart account (same address as before — it derives from your
owner key):

1. **ETH first** — the account self-pays gas, and the first operation also
   pays to deploy the account.
2. **USDG** — your trading capital. `idleFloorUsdg` is 200, so keep the
   deposit under ~250 or raise that setting, or the first tick sweeps the
   excess into Morpho and spends most of the daily cap doing it.
3. The scout budget (100 USDG of it) is money you have decided you can lose:
   quarantined positions are carried at cost and the drawdown breaker cannot
   protect them. That is the honest price of trading the unpriceable.

## Step 6 — Prove it

```bash
merrymen preflight
```
Expect **0 blockers**. Then:

```bash
merrymen selftest
```
It must print **PASSED** — it now exits non-zero for anything less, and green
means the grant, the wall, the bundler and the ledger all work.

Memecoin pools trade 24/7, so no market-hours window applies to them (the
stock leg still needs US market hours).

## From then on — each new token

1. Discovery announces the launch in your feed/Telegram (with the pool's
   liquidity and FDV, and — for hooked pools — the key that makes it
   routable).
2. `/settings`: add it (symbol, address, decimals) and tick it into the
   basket.
3. `/grant`: click **renew the key (free)**. One click; it now reads your
   fresh settings and signs on the chain the page shows.

That re-sign-per-token loop is structural, not an inconvenience to engineer
away: the wall cannot widen itself, which is the product's core promise. Two
minutes per token is what "the chain enforces the wall" costs.

## What the wall now guarantees on v4

- Output of every adapter swap lands in YOUR account — not a policy
  condition, a fact of the bytecode.
- Both legs of every adapter swap must be assets you named at signing.
- No Permit2, no UniversalRouter, no standing approvals: each trade approves
  exactly its own input amount, consumed by the swap.
- A hooked pool that won't quote the exit is never entered; an empty fill
  reverts rather than reporting success; a mis-settle reverts by name.
