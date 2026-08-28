"use client";

/**
 * The permission wall — creating an agent account and granting it a scoped key.
 *
 * NO EXTERNAL WALLET OWNS THE FUNDS. The account's owner key is generated in
 * the browser — you create the wallet, back up its owner key, and fund the
 * account address. Hosted adds ONE wallet popup on top of that, and only to
 * link the account to your login (see step 5); the wallet never owns the
 * account and never signs a trade. The flow (all counterfactual — nothing is
 * deployed until the agent's first trade):
 *  1. A fresh OWNER keypair is generated → it's the Kernel account's sudo
 *     validator (ECDSA). The smart-account address derives from it.
 *  2. A fresh SESSION keypair is generated for the agent.
 *  3. The session key is wrapped in a permission validator whose policies are
 *     enforced BY THE ACCOUNT CONTRACT on every UserOp:
 *       - call policy: only approve(USDG→allowed targets) with capped amounts,
 *         only vault.deposit with capped assets, only the Rialto router
 *       - rate limit: bounded ops per day
 *       - timestamp: hard expiry
 *  4. The owner key signs the grant locally (no popup); the serialized grant is
 *     what the worker uses to act. Revocation = expiry (or nonce invalidation).
 *  5. HOSTED ONLY — the account is bound to the signed-in tenant by two
 *     signatures over one server-issued nonce: the wallet authorizes the pair
 *     (intent) and the owner key co-signs it (possession). Both personal_sign,
 *     so no chain switch is ever required. Without step 5 the server has no way
 *     to tell whose account this is, because `owner` is a key minted here and
 *     can never equal the signed-in wallet.
 *
 * TESTNET DEMO CAVEATS (labeled in the UI): both private keys are kept in
 * localStorage so you can inspect and back them up; production owner keys live
 * in a Turnkey TEE and never touch a browser. Whoever holds the owner key
 * controls the funds — the UI forces a backup before funding. Drawdown breaker
 * is worker-enforced until the breaker contract ships (Phase 2).
 */

import { createPublicClient, erc20Abi, http, parseAbi, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createKernelAccount } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import {
  serializePermissionAccount,
  toPermissionValidator,
} from "@zerodev/permissions";
import { toECDSASigner } from "@zerodev/permissions/signers";
import {
  CallPolicyVersion,
  ParamCondition,
  toCallPolicy,
  toRateLimitPolicy,
  toTimestampPolicy,
} from "@zerodev/permissions/policies";
import {
  CASH,
  MORPHO,
  RIALTO,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  UNISWAP,
  UNISWAP_SWAP_ROUTER_ABI,
  PERMIT2_ABI,
  UNIVERSAL_ROUTER_ABI,
  buildWallPolicies,
  WALL_POLICY_FLAG,
  usableExtraTokens,
  chainForId,
  robinhoodTestnet,
  GRANT_MULTIHOP,
  GRANT_V4,
  GRANT_V4_ADAPTER,
  bindingMessage,
  TRADEABLE_V2,
  USDG_DECIMALS,
  type CustomToken,
  type GrantCaps,
  type StoredGrant,
} from "@merrymen/core";
import { findInjectedProvider, requestAccount } from "./wallet";

export type { GrantCaps, StoredGrant };

/** Testnet gas faucet — where users top up the account's native balance. */
export const FAUCET_URL = "https://faucet.testnet.chain.robinhood.com";

const VAULT_ABI = parseAbi([
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
]);

export type Grant = StoredGrant;

const STORAGE_KEY = "merrymen.grant.v1";

export function loadGrant(): Grant | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Grant) : null;
  } catch {
    return null;
  }
}

export function clearGrant(): void {
  localStorage.removeItem(STORAGE_KEY);
}

const usdgUnits = (v: number) => BigInt(Math.round(v * 10 ** USDG_DECIMALS));

/** An address, abbreviated for a sentence a person has to read. */
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Mint a grant for a given OWNER key: derive the Kernel account, generate a
 * fresh session key, wrap it in the policy validator, and seal the grant.
 *
 * The account address derives from the owner key alone (the sudo ECDSA
 * validator + factory + index) — the session/permission plugin is enabled at
 * UserOp time and does NOT affect the address. That's what makes restore work:
 * the same owner key always reproduces the same smart account, so an existing
 * funded wallet can be re-armed with a brand-new session key.
 */
async function mintGrant(
  ownerPrivateKey: `0x${string}`,
  caps: GrantCaps,
  onStatus: (status: string) => void,
  chainId: number,
  /**
   * Owner-added tokens to bake into the call policy alongside the built-in
   * tradable set. Passing them is what actually lets the agent SELL them —
   * adding a token in settings does nothing until a grant covering it is signed.
   */
  extraTokens: readonly CustomToken[] = [],
  /**
   * The deployed V4SelfSwap adapter to seal into the wall, or absent for no
   * v4 route. Per-chain and per-deploy — the caller reads it from /settings
   * for the chain being signed. The marker and the permission are minted
   * together below, or not at all.
   */
  v4AdapterAddress?: `0x${string}`,
  /**
   * Whether this deployment is the hosted service, from GET /api/auth/session.
   *
   * PASSED IN, NOT DETECTED. `isHostedMode()` reads process.env, and this module
   * is `"use client"` — Next inlines only NEXT_PUBLIC_* into the browser bundle
   * and next.config.mjs declares no `env` block, so it evaluated to `false` in
   * every browser no matter how the server was configured. That silently
   * attached the owner key to every hosted POST, which the server then refused
   * with a 422 nobody could see. The runtime endpoint is the only signal the
   * client can trust.
   */
  hostedAs?: Address,
): Promise<MintedGrant> {
  // Testnet is the sandbox; mainnet (4663) is real funds — the UI gates that
  // choice behind an explicit consent step. Note: the call-policy addresses
  // below (UNISWAP/RIALTO/MORPHO/USDG) are MAINNET deployments — the wall is
  // real on mainnet and inert on testnet, where those contracts don't exist
  // and swaps no-route by design.
  const chain = chainForId(chainId);
  const publicClient = createPublicClient({ chain, transport: http() });

  const entryPoint = getEntryPoint("0.7");
  const kernelVersion = KERNEL_V3_3;

  const ownerAccount = privateKeyToAccount(ownerPrivateKey);
  const owner = ownerAccount.address;

  onStatus("deriving your smart account…");
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion,
  });

  const sessionPrivateKey = generatePrivateKey();
  const sessionAccount = privateKeyToAccount(sessionPrivateKey);
  const sessionSigner = await toECDSASigner({ signer: sessionAccount });

  // THE ACCOUNT ADDRESS, BEFORE THE WALL — because the wall now pins value to
  // it. The Kernel address derives from the SUDO validator alone; the
  // permission plugin is enabled at UserOp time and does not affect it (the
  // same fact that makes restore work). So derive the sudo-only account first,
  // pin the swap recipient / vault receiver to it, and assert below that the
  // full account came out identical.
  const sudoOnlyAccount = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion,
    plugins: { sudo: ecdsaValidator },
  });

  // THE WALL now lives in packages/core/src/wall.ts, so the phone app signs the
  // IDENTICAL permission set rather than a second copy that could drift from this
  // one with nothing failing when it did. worker/src/wall.test.ts pins its shape.
  // Uniswap v4 is OFF — see WallOptions.allowUniswapV4. This flag and the
  // GRANT_V4 marker below MUST move together: the marker is what the worker
  // reads to decide whether to route through v4, and until now it claimed a
  // capability the wall granted regardless of it. Deriving both from one
  // constant is what stops them drifting apart again.
  const allowUniswapV4: boolean = false;
  const { policies, now, expiresAt } = buildWallPolicies({
    caps,
    smartAccount: sudoOnlyAccount.address,
    extraTokens,
    allowUniswapV4,
    v4AdapterAddress,
  });

  const permissionValidator = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion,
    signer: sessionSigner,
    policies,
    // Execute, but never sign. Without this the session key can produce
    // ERC-1271 signatures — which a CALL policy cannot constrain — and a
    // signed Permit2 transfer drains the account with no UserOp at all.
    // See WALL_POLICY_FLAG in packages/core/src/wall.ts.
    flag: WALL_POLICY_FLAG,
  });

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion,
    plugins: {
      sudo: ecdsaValidator,
      regular: permissionValidator,
    },
  });

  // THE PREMISE, CHECKED. The wall pins the swap recipient and vault receiver
  // to the sudo-only address derived above, which is only correct because the
  // permission plugin does not change the account address. If that ever stops
  // being true, every pin would point at an account that doesn't exist and the
  // agent would be unable to trade — or worse, at someone else's. Fail here,
  // loudly, before a grant is sealed, rather than discovering it on-chain.
  if (account.address.toLowerCase() !== sudoOnlyAccount.address.toLowerCase()) {
    throw new Error(
      `refusing to seal this grant: the permission plugin changed the account address ` +
        `(${sudoOnlyAccount.address} → ${account.address}), so the wall's recipient pins are wrong.`,
    );
  }

  onStatus("sealing the permission grant…");
  const serialized = await serializePermissionAccount(account, sessionPrivateKey);

  const grant: Grant = {
    smartAccount: account.address,
    owner,
    sessionKeyAddress: sessionAccount.address,
    serialized,
    caps,
    grantedAt: now,
    expiresAt,
    chainId: chain.id,
    // TRADEABLE_V2 says this signature carries the WIDE stock allowlist. Without
    // it the worker assumes the legacy three — because a grant signed before the
    // list grew genuinely only has those three in its call policy, and crediting
    // it with more is how a position gets bought and never sold.
    // GRANT_MULTIHOP is unconditional because buildCallPermissions grants
    // `exactInput` unconditionally — the two must move together, or the worker
    // either declines a route it could take or takes one that reverts.
    // NO "transfer" HERE, and that is not an omission. This list carried it
    // unconditionally while buildWallPolicies was called without
    // withdrawalAddresses — so the wall emitted no transfer permission at all
    // and the worker was told it had one. /transfer then built a UserOp the
    // chain refused: gas spent on a revert whose reason said nothing.
    //
    // The marker is minted BY THE PERMISSION. It belongs here only if a
    // destination is registered above, and until this signer offers that,
    // money leaves through the owner key (`merrymen recover`) — which is what
    // /grant already tells the owner, and which no wall can block.
    // GRANT_V4_ADAPTER is minted ONLY when the permission was — marker and
    // wall move together, the same lockstep rule as GRANT_V4 above. The sealed
    // address rides with it because the marker alone is a claim, not evidence.
    grantFeatures: [
      TRADEABLE_V2,
      GRANT_MULTIHOP,
      ...(allowUniswapV4 ? [GRANT_V4] : []),
      ...(v4AdapterAddress ? [GRANT_V4_ADAPTER] : []),
    ],
    ...(v4AdapterAddress ? { v4AdapterAddress: v4AdapterAddress.toLowerCase() } : {}),
    // What this signature ACTUALLY covers — the worker compares it against the
    // owner's configured tokens and says so when they've drifted apart.
    // Same filter the wall itself applied, so what we RECORD as covered and what
    // the policy actually covers cannot disagree — the worker compares this
    // against the owner's configured tokens and warns when they've drifted.
    grantTokens: usableExtraTokens(extraTokens).map((t) => t.address.toLowerCase()),
    demoSessionPrivateKey: sessionPrivateKey,
    // THE CUSTODY LINE. Self-hosted keeps the owner key on the grant object: it
    // is a localhost round-trip to a 0600 file on the user's own machine, which
    // is not a leak, and it is what the local `merrymen recover` reads. HOSTED
    // omits it entirely — the grant that goes to the server is session-key-only
    // (the shape the mobile signer has always used), so the server is never
    // custodian of a single owner key. The owner key still lives in this
    // browser's localStorage below, which is what makes client-side recovery
    // work with no server involvement.
    ...(hostedAs ? {} : { demoOwnerPrivateKey: ownerPrivateKey }),
  };

  // HOSTED: prove this account belongs to the signed-in wallet before offering
  // it. The owner key was generated right here, so `owner` can never equal the
  // tenant and the server cannot authorize on it — two signatures over one
  // server-issued nonce stand in for that. See bindingMessage in packages/core.
  if (hostedAs) {
    onStatus("linking this wallet to your account…");
    const binding = await signBinding({
      owner,
      smartAccount: account.address,
      chainId,
      ownerAccount,
      tenant: hostedAs,
    });
    grant.binding = binding;
  }

  // localStorage ALWAYS gets the full grant WITH the owner key — hosted or not.
  // This is the browser's own copy, the root of client-side recovery, and it
  // never crosses the network. Losing it is the same as losing the key, which
  // is why the UI forces a backup before funding.
  //
  // ARCHIVE FIRST. This is a single key, so writing it destroys whatever grant
  // was here — and for a hosted grant that blob is the ONLY copy of its owner
  // key, never shown to the user and never sent anywhere. Overwriting it
  // silently strands any funds in the old account, so the outgoing grant is
  // copied aside under its own address, the same safety net archiveCurrentGrant
  // gives the self-hosted file (web/src/app/api/grants/route.ts).
  archivePreviousGrant();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...grant, demoOwnerPrivateKey: ownerPrivateKey }));

  // Hand the grant to the worker. Self-hosted: a localhost file handoff.
  // Hosted: an authenticated POST of the session-key-only grant to the tenant's
  // own store. In hosted mode the browser sends its session cookie so the
  // server can bind the grant to the authenticated wallet.
  onStatus("handing the grant to the worker…");
  return { grant, handoff: await postGrant(grant) };
}

/**
 * Produce the two signatures that bind this account to the signed-in wallet.
 *
 * The nonce comes from /api/auth/challenge — the same server-issued,
 * origin-bound, expiring, single-use nonce the login uses. Reused deliberately
 * rather than adding a second nonce system: the two messages are textually
 * distinct (see bindingMessage), so a nonce spent on one can never be replayed
 * as the other, and there is one piece of nonce machinery to get right.
 *
 * The wallet signature is the only popup in the whole flow. The owner
 * co-signature is local and silent — it exists to prove the browser actually
 * holds the key it is vouching for, without which the server's remaining checks
 * are just arithmetic over public addresses.
 *
 * `personal_sign` for both, which is why this works at all: it carries no
 * domain and no chainId, so no wallet is asked to switch to (or even know
 * about) Robinhood Chain. Phantom cannot connect to dApps on 4663 at all, and
 * still signs this fine.
 */
async function signBinding(args: {
  owner: Address;
  smartAccount: Address;
  chainId: number;
  ownerAccount: ReturnType<typeof privateKeyToAccount>;
  /** The wallet the session belongs to — what the server will check against. */
  tenant: Address;
}): Promise<NonNullable<Grant["binding"]>> {
  const ch = (await fetch("/api/auth/challenge", { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error("couldn't start the account link — please sign in again.");
    return r.json();
  })) as { origin: string; nonce: string };

  const message = bindingMessage({
    origin: ch.origin,
    nonce: ch.nonce,
    owner: args.owner,
    smartAccount: args.smartAccount,
    chainId: args.chainId,
  });

  const provider = findInjectedProvider();
  if (!provider) {
    throw new Error("No wallet found in this browser to authorize the agent — sign in again from a browser with your wallet.");
  }
  const account = await requestAccount(provider);
  // CHECK BEFORE PROMPTING. The wallet's ACTIVE account is whatever the user
  // last selected, which is not necessarily the one they signed in with — and
  // the server checks the signature against the session. Without this they
  // approve a signature and only then get a 403 naming a wallet mismatch they
  // cannot act on. Catch it while it is still a sentence about switching
  // accounts, not a failed grant.
  if (account.toLowerCase() !== args.tenant.toLowerCase()) {
    throw new Error(
      `Your wallet is on ${short(account)} but you signed in as ${short(args.tenant)}. ` +
        `Switch back to that account in your wallet, or sign out and in again.`,
    );
  }
  const walletSignature = (await provider.request({
    method: "personal_sign",
    // [message, address] — the order Onboarding.tsx's sign-in already uses.
    params: [message, account],
  })) as `0x${string}`;

  // Local, no popup: the generated owner key vouches for itself.
  const ownerSignature = await args.ownerAccount.signMessage({ message });

  return { nonce: ch.nonce, walletSignature, ownerSignature };
}

/** Where a superseded grant is parked, keyed by the account it controls. */
const ARCHIVE_PREFIX = "merrymen.grant.archive.";

/**
 * Copy the grant currently in localStorage aside before it is overwritten.
 *
 * Best-effort and deliberately silent: this must never be able to stop someone
 * creating a wallet. Keyed by smart account, so re-creating over the same
 * account just refreshes its copy while a different account gets its own slot.
 */
function archivePreviousGrant(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const prev = JSON.parse(raw) as Partial<Grant>;
    if (typeof prev?.smartAccount !== "string") return;
    localStorage.setItem(`${ARCHIVE_PREFIX}${prev.smartAccount.toLowerCase()}`, raw);
  } catch {
    /* unreadable or storage full — never block the create */
  }
}

/**
 * Hand a signed grant to the server, and REPORT WHAT IT SAID.
 *
 * This used to be a bare `await fetch(...)` inside a `try {} catch {}`, and the
 * comment explained only why a failure must not lose the grant — which is true,
 * and is handled by the localStorage write above. What it missed is that a
 * rejected POST does not throw: `fetch` resolves normally for 401/403/422/500,
 * so the catch never ran and nothing ever read `res.ok`. Every server refusal
 * looked identical to success, and the caller happily reported a wallet the
 * server had thrown away. That is why hosted onboarding could be broken for
 * every tester with nobody able to say more than "it doesn't work".
 *
 * So: never throw (the grant is safe in localStorage either way), but always
 * return what happened, and prefer the server's OWN message — it is the only
 * text that can say which of the six hosted checks refused this grant.
 */
/**
 * Turn a refusal into something the reader can ACT on.
 *
 * The server's own strings are accurate but written for whoever is reading the
 * route — "not signed in" is true and tells a user nothing about what to do
 * next. Each hosted check gets a sentence naming the fix; anything unmapped
 * falls through to the server's text, which is still better than the silence
 * this replaced. The raw message is kept on the end where it adds detail, so a
 * bug report can still quote the exact check that refused.
 */
export function refusalMessage(status: number, serverError?: string): string {
  switch (status) {
    case 401:
      return "Sign in with your wallet first — a hosted agent is bound to the wallet you sign in with.";
    case 422:
      // carriesOwnerKey. Today this is reachable from this very client, which is
      // a bug on our side, not something the reader did wrong — say so.
      return "This wallet can't be armed on the hosted service yet: the grant still carries its owner key. That's a bug on our side, not yours.";
    case 403:
      return "This agent wallet isn't owned by the wallet you signed in with, so the server won't arm it.";
    case 503:
      return "Couldn't verify the account on-chain just now — try again in a moment.";
    default:
      return serverError ?? `the server refused the grant (${status})`;
  }
}

async function postGrant(grant: Grant): Promise<GrantHandoff> {
  try {
    const res = await fetch("/api/grants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(grant),
    });
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: refusalMessage(res.status, body.error) };
  } catch {
    // A genuine network failure, as opposed to a refusal. Still not fatal — the
    // grant is in localStorage and `re-arm` can push it again later.
    return { ok: false, error: "couldn't reach the server to hand over the grant — it's saved in this browser, try re-arming." };
  }
}

/**
 * Create a BRAND-NEW agent wallet: a fresh owner key is generated in-browser
 * (this is the account's sudo signer and the root of fund custody — no external
 * wallet, nothing to connect), then a grant is sealed on it.
 */
export async function createAgentWallet(
  caps: GrantCaps,
  onStatus: (status: string) => void,
  chainId: number = robinhoodTestnet.id,
  extraTokens: readonly CustomToken[] = [],
  v4AdapterAddress?: `0x${string}`,
  hostedAs?: Address,
): Promise<MintedGrant> {
  onStatus("minting your agent's owner key…");
  return mintGrant(generatePrivateKey(), caps, onStatus, chainId, extraTokens, v4AdapterAddress, hostedAs);
}

/**
 * RESTORE an existing agent wallet from its backed-up owner key — the way back
 * in after a kill switch, a discarded grant, or a new machine. The same owner
 * key re-derives the SAME smart account, so a wallet you already funded comes
 * back to life with a brand-new session key and whatever caps you pick now.
 * Nothing moves on-chain; no funds are touched.
 *
 * This is also the RE-SIGN path for widening the tradable set: adding a token in
 * settings can't reach into an already-signed key, so covering it means minting
 * a new grant over the same account. Same address, same funds, new wall.
 */
export async function restoreAgentWallet(
  ownerPrivateKey: `0x${string}`,
  caps: GrantCaps,
  onStatus: (status: string) => void,
  chainId: number = robinhoodTestnet.id,
  extraTokens: readonly CustomToken[] = [],
  v4AdapterAddress?: `0x${string}`,
  hostedAs?: Address,
): Promise<MintedGrant> {
  onStatus("re-deriving your smart account from the owner key…");
  return mintGrant(ownerPrivateKey, caps, onStatus, chainId, extraTokens, v4AdapterAddress, hostedAs);
}

/**
 * What the server said when the signed grant was handed over.
 *
 * Separate from the grant itself because the two succeed independently: the
 * grant is signed and in localStorage regardless, while the handoff can be
 * refused (not signed in, carries an owner key, owner isn't the tenant…). The
 * UI must be able to show a wallet AND say the server rejected it, which is
 * exactly the state a desynced browser is in.
 */
export interface GrantHandoff {
  ok: boolean;
  /** The server's own message, shown verbatim — it names which check refused. */
  error?: string;
}

/** A freshly signed grant plus the outcome of handing it to the server. */
export interface MintedGrant {
  grant: Grant;
  handoff: GrantHandoff;
}

export interface OwnerPreview {
  /** The smart account this owner key controls — where your funds actually are. */
  smartAccount: Address;
  /** The owner key's own EOA — what MetaMask would show (usually empty). */
  owner: Address;
}

/**
 * Read-only: which smart account does this owner key control? Lets the restore
 * flow show the derived address (and its balances) so the user can confirm it's
 * the funded wallet they meant BEFORE anything is signed or armed.
 */
export async function previewOwnerAccount(
  ownerPrivateKey: `0x${string}`,
  chainId: number = robinhoodTestnet.id,
): Promise<OwnerPreview> {
  const chain = chainForId(chainId);
  const publicClient = createPublicClient({ chain, transport: http() });
  const ownerAccount = privateKeyToAccount(ownerPrivateKey);
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint: getEntryPoint("0.7"),
    kernelVersion: KERNEL_V3_3,
  });
  // sudo-only derivation — the permission plugin doesn't change the address.
  const account = await createKernelAccount(publicClient, {
    entryPoint: getEntryPoint("0.7"),
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });
  return { smartAccount: account.address, owner: ownerAccount.address };
}

/** Live on-chain balances of the account address — for the "fund it" step. */
export interface Funding {
  gasWei: bigint;
  usdgUnits: bigint;
  usdg: number;
}

export async function readFunding(smartAccount: Address, chainId: number = robinhoodTestnet.id): Promise<Funding> {
  const publicClient = createPublicClient({ chain: chainForId(chainId), transport: http() });
  const [gasWei, usdgUnits] = await Promise.all([
    publicClient.getBalance({ address: smartAccount }).catch(() => 0n),
    publicClient
      .readContract({
        address: CASH.USDG as Address,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [smartAccount],
      })
      .then((v) => v as bigint)
      .catch(() => 0n),
  ]);
  return { gasWei, usdgUnits, usdg: Number(usdgUnits) / 10 ** USDG_DECIMALS };
}
