/** Owner-signed embedded enrollment. No browser session or Privy identity is invented. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { toCallPolicy, toTimestampPolicy } from "@zerodev/permissions/policies";
import { getActionSelector } from "@zerodev/sdk";
import {
  accountsMatch, buildWallPolicies, carriesOwnerKey, grantWallOptions, STOCK_TOKENS,
  type Derivation, type MerrymenSettings, type StoredGrant,
} from "@merrymen/core";
import {
  canonicalJson, partnerEnrollmentMessage, partnerGrantDigest,
  type PartnerEnrollmentClaim, type PartnerEnrollmentSettings,
} from "../../../packages/core/src/partner-enrollment";
import type { GrantStore } from "../../../worker/src/grant-store";
import type { SettingsStore } from "../../../worker/src/settings-store";
import type { IdentityStore } from "../../../worker/src/identity-store";
import { getPartnerStore, type PartnerConnection, type PartnerStore } from "./partner-store";
import { onlyFields, PartnerError, requirePartnerScope, type PartnerPrincipal } from "./partner-bridge";

export const PARTNER_ENROLLMENT_TTL_MS = 5 * 60_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY = /^0x[0-9a-fA-F]{64}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const CHAINS = new Set([4663, 46630]);
const SYMBOLS = new Set(STOCK_TOKENS.map(t => t.symbol));
const CONSENT_SCOPES = new Set(["read:agents", "chat:agents"]);
const fail = (status: number, code: string, message: string): never => { throw new PartnerError(status, code, message); };

export interface PartnerEnrollmentDependencies {
  store: PartnerStore;
  grants: Pick<GrantStore, "get" | "put" | "tenantForAccount">;
  settings: Pick<SettingsStore, "get" | "put">;
  identities: Pick<IdentityStore, "ensure">;
  now: () => number;
  secret: () => string;
  derive: (owner: Address, chainId: number) => Promise<Derivation>;
  recover: (args: { message: string; signature: Hex }) => Promise<Address>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail(400, "bad_request", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
function asAddress(value: unknown, label: string): Address {
  if (typeof value !== "string" || !ADDRESS.test(value) || value.toLowerCase() === ZERO) return fail(400, "invalid_grant", `${label} must be a nonzero wallet address`);
  return value.toLowerCase() as Address;
}
function chainId(value: unknown): number {
  if (typeof value !== "number" || !CHAINS.has(value)) return fail(400, "unsupported_chain", "Only Robinhood Chain and its testnet are supported");
  return value;
}
function safeSettings(value: unknown): PartnerEnrollmentSettings {
  const body = object(value, "settings");
  onlyFields(body, ["name", "strategy", "basket_symbols", "live_trading_enabled"]);
  if (typeof body.name !== "string" || !body.name.trim() || body.name.trim().length > 24 || /[\u0000-\u001f]/.test(body.name)) return fail(400, "invalid_settings", "Agent name must contain 1–24 characters");
  if (body.strategy !== "steady-basket" && body.strategy !== "llm-strategist") return fail(400, "invalid_settings", "Choose steady-basket or llm-strategist");
  if (!Array.isArray(body.basket_symbols) || !body.basket_symbols.length || body.basket_symbols.length > 10 || body.basket_symbols.some(s => typeof s !== "string" || !SYMBOLS.has(s))) {
    return fail(400, "invalid_settings", "basket_symbols must contain 1–10 supported stock symbols");
  }
  if (typeof body.live_trading_enabled !== "boolean") return fail(400, "invalid_settings", "live_trading_enabled must be an explicit boolean");
  return { name: body.name.trim(), strategy: body.strategy, basket_symbols: [...new Set(body.basket_symbols as string[])], live_trading_enabled: body.live_trading_enabled };
}
function secretDefault(): string {
  const secret = process.env.MERRYMEN_PARTNER_BRIDGE_SECRET ?? "";
  if (Buffer.byteLength(secret) < 32) return fail(503, "upstream_unavailable", "Partner enrollment is not configured");
  return secret;
}
function signToken(claim: PartnerEnrollmentClaim, secret: string): string {
  const encoded = Buffer.from(canonicalJson(claim)).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(`partner-enrollment-v1:${encoded}`).digest("base64url")}`;
}
function readToken(raw: unknown, secret: string, now: number): PartnerEnrollmentClaim {
  if (typeof raw !== "string" || raw.length > 8192) return fail(401, "invalid_challenge", "Invalid enrollment challenge");
  const parts = raw.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return fail(401, "invalid_challenge", "Invalid enrollment challenge");
  const expected = createHmac("sha256", secret).update(`partner-enrollment-v1:${parts[0]}`).digest();
  const presented = Buffer.from(parts[1], "base64url");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return fail(401, "invalid_challenge", "Invalid enrollment challenge");
  let claim: PartnerEnrollmentClaim;
  try { claim = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as PartnerEnrollmentClaim; }
  catch { return fail(401, "invalid_challenge", "Invalid enrollment challenge"); }
  if (!claim || claim.v !== 1 || !Number.isSafeInteger(claim.expires_at) || claim.expires_at <= now || claim.expires_at > now + PARTNER_ENROLLMENT_TTL_MS || !/^[a-f0-9]{48}$/.test(claim.nonce)) {
    return fail(401, "challenge_expired", "Enrollment challenge expired; request and sign a fresh challenge");
  }
  return claim;
}
function connectionContext(principal: PartnerPrincipal, connection: PartnerConnection): string[] {
  requirePartnerScope(principal, "write:agents");
  if (connection.partnerId !== principal.app_id) return fail(404, "not_found", "No such agent");
  if (connection.status === "revoked") return fail(409, "connection_revoked", "This agent connection has been revoked");
  const scopes = [...new Set(connection.scopes)].sort();
  if (!scopes.includes("read:agents") || scopes.some(scope => !CONSENT_SCOPES.has(scope))) return fail(400, "invalid_scopes", "Agent consent must include read:agents and optionally chat:agents");
  if (scopes.some(scope => !principal.scopes.includes(scope))) return fail(403, "forbidden_scope", "This key does not carry all of the requested agent scopes");
  return scopes;
}

/** Validate both metadata and the session key actually used by the worker. */
function validGrant(input: unknown, now: number): StoredGrant {
  const body = object(input, "grant");
  if ("demoOwnerPrivateKey" in body || carriesOwnerKey(body)) return fail(422, "owner_key_forbidden", "Owner private keys must stay in the owner's wallet");
  onlyFields(body, ["smartAccount", "owner", "sessionKeyAddress", "serialized", "caps", "grantedAt", "expiresAt", "chainId", "grantFeatures", "grantTokens", "v4AdapterAddress", "ponsAdapterAddress", "ponsClassVaultAddress", "ponsClassVaultFactoryAddress", "binding", "demoSessionPrivateKey"]);
  const owner = asAddress(body.owner, "owner");
  const smartAccount = asAddress(body.smartAccount, "smartAccount");
  const sessionKeyAddress = asAddress(body.sessionKeyAddress, "sessionKeyAddress");
  chainId(body.chainId);
  if (typeof body.demoSessionPrivateKey !== "string" || !KEY.test(body.demoSessionPrivateKey)) return fail(400, "invalid_grant", "The grant needs its session key");
  let derivedSession: Address;
  try { derivedSession = privateKeyToAccount(body.demoSessionPrivateKey as Hex).address.toLowerCase() as Address; }
  catch { return fail(400, "invalid_grant", "The session key is invalid"); }
  if (derivedSession === owner) return fail(422, "owner_key_forbidden", "The session key must be different from the owner key");
  if (derivedSession !== sessionKeyAddress) return fail(400, "invalid_grant", "The session key does not match sessionKeyAddress");
  const caps = object(body.caps, "grant caps");
  onlyFields(caps, ["perTradeUsdg", "dailyUsdg", "expiryDays", "maxDrawdownPct", "maxOpsPerDay"]);
  for (const field of ["perTradeUsdg", "dailyUsdg", "expiryDays", "maxDrawdownPct", "maxOpsPerDay"]) {
    if (typeof caps[field] !== "number" || !Number.isFinite(caps[field]) || Number(caps[field]) < 1) return fail(400, "invalid_grant", `${field} must be at least 1`);
  }
  if (Number(caps.perTradeUsdg) > Number(caps.dailyUsdg) || Number(caps.maxDrawdownPct) > 100 || !Number.isSafeInteger(caps.expiryDays) || Number(caps.expiryDays) > 365 || !Number.isSafeInteger(caps.maxOpsPerDay)) {
    return fail(400, "invalid_grant", "The grant limits are inconsistent or outside supported bounds");
  }
  const seconds = Math.floor(now / 1000);
  if (!Number.isSafeInteger(body.grantedAt) || !Number.isSafeInteger(body.expiresAt) || Number(body.grantedAt) <= 0 || Number(body.grantedAt) > seconds + 60 || Number(body.expiresAt) <= seconds || Number(body.expiresAt) !== Number(body.grantedAt) + Number(caps.expiryDays) * 86_400) {
    return fail(400, "invalid_grant", "The grant expiry must match its signed duration and remain in the future");
  }
  if (typeof body.serialized !== "string" || body.serialized.length < 20 || body.serialized.length > 240_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(body.serialized)) return fail(400, "invalid_grant", "Invalid serialized permission or permission too large for embedded activation");
  let params: Record<string, unknown>;
  try { params = object(JSON.parse(Buffer.from(body.serialized, "base64").toString("utf8")), "serialized permission"); }
  catch { return fail(400, "invalid_grant", "The serialized permission cannot be read"); }
  onlyFields(params, ["permissionParams", "action", "validityData", "accountParams", "enableSignature", "privateKey", "isPreInstalled"]);
  if (params.privateKey !== body.demoSessionPrivateKey) return fail(400, "invalid_grant", "The serialized permission carries a different session key");
  // ABI rules legitimately contain bytes32 values, so the outer grant's broad
  // raw-key detector cannot scan this decoded object. Recognize the owner's
  // actual key by its derived address instead; reject custody-named fields too.
  const inspect = (value: unknown, key = ""): void => {
    if (/(?:owner.*(?:key|secret)|mnemonic|seed.?phrase|private.?key)/i.test(key)) return fail(422, "owner_key_forbidden", "The serialized permission contains unexpected key material");
    if (typeof value === "string") {
      const candidate = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(value);
      if (candidate) {
        let candidateAddress: string | null = null;
        try { candidateAddress = privateKeyToAccount(`0x${candidate[1]}`).address.toLowerCase(); } catch { /* An ABI word need not be a valid secret scalar. */ }
        if (candidateAddress === owner) return fail(422, "owner_key_forbidden", "The serialized permission contains the owner private key");
      }
    } else if (Array.isArray(value)) value.forEach(v => inspect(v));
    else if (value && typeof value === "object") Object.entries(value).forEach(([k, v]) => inspect(v, k));
  };
  Object.entries(params).forEach(([key, value]) => { if (key !== "privateKey") inspect(value, key); });
  const action = object(params.action, "permission action");
  onlyFields(action, ["selector", "address"]);
  const validity = object(params.validityData, "permission validity");
  onlyFields(validity, ["validAfter", "validUntil"]);
  if (params.isPreInstalled !== false || action.address !== ZERO || action.selector !== getActionSelector("0.7") || Number(validity.validAfter) !== 0 || Number(validity.validUntil) !== 0) {
    return fail(400, "invalid_grant", "Embedded enrollment requires the standard owner-enabled Kernel permission action");
  }
  const account = object(params.accountParams, "serialized account");
  onlyFields(account, ["initCode", "accountAddress"]);
  if (asAddress(account.accountAddress, "serialized account address") !== smartAccount || typeof account.initCode !== "string" || !/^0x[0-9a-fA-F]+$/.test(account.initCode)) return fail(400, "invalid_grant", "The serialized account does not match this grant");
  const permission = object(params.permissionParams, "serialized permission parameters");
  onlyFields(permission, ["policies", "permissionId"]);
  if (!Array.isArray(permission.policies) || permission.policies.length > 8) return fail(400, "invalid_grant", "The permission policies are missing or invalid");
  const policies = permission.policies.map(p => {
    const record = object(p, "permission policy");
    onlyFields(record, ["policyParams"]);
    const policy = object(record.policyParams, "permission policy parameters");
    if (policy.type === "timestamp") onlyFields(policy, ["type", "policyAddress", "policyFlag", "validAfter", "validUntil"]);
    else if (policy.type === "call") onlyFields(policy, ["type", "policyAddress", "policyFlag", "policyVersion", "permissions"]);
    else return fail(400, "invalid_grant", "This embedded grant carries an unsupported permission policy");
    return policy;
  });
  if (!policies.some(p => p.type === "call") || !policies.some(p => p.type === "timestamp" && Number(p.validUntil) === body.expiresAt && Number(p.validAfter) === body.grantedAt)) {
    return fail(400, "invalid_grant", "The permission must carry a call policy and the grant's exact expiry");
  }
  if (body.grantTokens !== undefined && (!Array.isArray(body.grantTokens) || body.grantTokens.length > 50 || body.grantTokens.some(a => typeof a !== "string" || !ADDRESS.test(a)))) return fail(400, "invalid_grant", "Invalid granted token addresses");
  const featureSet = new Set(["tradeable-v2", "v4-adapter", "pons-adapter", "pons-class"]);
  if (!Array.isArray(body.grantFeatures) || !body.grantFeatures.includes("tradeable-v2") || body.grantFeatures.some(f => typeof f !== "string" || !featureSet.has(f))) return fail(400, "invalid_grant", "The embedded permission must use the current supported wall features");
  for (const [field, marker] of [["v4AdapterAddress", "v4-adapter"], ["ponsAdapterAddress", "pons-adapter"], ["ponsClassVaultAddress", "pons-class"], ["ponsClassVaultFactoryAddress", "pons-class"]]) {
    if (body[field] !== undefined) asAddress(body[field], field);
    if ((body[field] !== undefined) !== body.grantFeatures.includes(marker)) return fail(400, "invalid_grant", "Permission adapter metadata does not match its feature markers");
  }
  // A hash signed by the owner authenticates the submitted bytes; it does not
  // prove those bytes implement the limits advertised beside them. Rebuild the
  // canonical wall and compare encoded policies, including recipient pins and
  // per-trade caps. ABI metadata can differ without changing those bytes.
  try {
    const expected = buildWallPolicies({
      caps: caps as unknown as StoredGrant["caps"], smartAccount, now: Number(body.grantedAt),
      ...grantWallOptions(body as unknown as StoredGrant),
      v4AdapterAddress: body.v4AdapterAddress as Address | undefined,
      ponsAdapterAddress: body.ponsAdapterAddress as Address | undefined,
      ponsClassVaultAddress: body.ponsClassVaultAddress as string | undefined,
      ponsClassVaultFactoryAddress: body.ponsClassVaultFactoryAddress as string | undefined,
    }).policies;
    const submitted = policies.map(p => p.type === "call" ? toCallPolicy(p as never) : toTimestampPolicy(p as never));
    if (expected.length !== submitted.length || expected.some((p, i) => p.getPolicyInfoInBytes().toLowerCase() !== submitted[i].getPolicyInfoInBytes().toLowerCase() || p.getPolicyData().toLowerCase() !== submitted[i].getPolicyData().toLowerCase())) {
      return fail(400, "invalid_wall", "The serialized permission does not implement the advertised Merrymen limits");
    }
  } catch (error) {
    if (error instanceof PartnerError) throw error;
    return fail(400, "invalid_wall", "The serialized permission policies cannot be verified");
  }
  if (typeof params.enableSignature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(params.enableSignature)) return fail(400, "invalid_grant", "The owner-signed permission enable signature is missing");
  // A legacy/Privy binding, if present in the input, is not evidence for this
  // flow. Do not persist unverified DIDs or repurpose their security model.
  const { binding: _binding, ...grant } = body;
  void _binding;
  return { ...grant, owner, smartAccount, sessionKeyAddress } as unknown as StoredGrant;
}

export function createPartnerEnrollmentService(overrides: Partial<PartnerEnrollmentDependencies> = {}) {
  const store = () => overrides.store ?? getPartnerStore();
  const now = overrides.now ?? Date.now;
  const secret = overrides.secret ?? secretDefault;
  const recover = overrides.recover ?? recoverMessageAddress;
  const grants = async () => overrides.grants ?? (await import("../../../worker/src/grant-store")).getGrantStore();
  const settings = async () => overrides.settings ?? (await import("../../../worker/src/settings-store")).getSettingsStore();
  const identities = async () => overrides.identities ?? (await import("../../../worker/src/identity-store")).getIdentityStore();
  const derive = overrides.derive ?? (async (owner, chain) => (await import("./derive-account")).deriveKernelAccountAddress(owner, chain));

  return {
    async challenge(principal: PartnerPrincipal, connection: PartnerConnection, input: unknown) {
      const scopes = connectionContext(principal, connection);
      const body = object(input, "challenge request");
      onlyFields(body, ["owner", "smart_account", "chain_id", "grant_hash", "settings"]);
      if (typeof body.grant_hash !== "string" || !HASH.test(body.grant_hash)) return fail(400, "invalid_grant", "grant_hash must be a keccak256 digest");
      const owner = asAddress(body.owner, "owner");
      if (connection.tenant && connection.tenant !== owner) return fail(409, "connection_already_linked", "This agent belongs to a different owner");
      const claim: PartnerEnrollmentClaim = {
        v: 1, app_id: principal.app_id, app_name: principal.name,
        agent_id: connection.id, external_user_id: connection.externalUserId,
        owner, smart_account: asAddress(body.smart_account, "smart_account"), chain_id: chainId(body.chain_id),
        grant_hash: body.grant_hash.toLowerCase() as Hex, settings: safeSettings(body.settings), scopes,
        nonce: randomBytes(24).toString("hex"), expires_at: now() + PARTNER_ENROLLMENT_TTL_MS,
      };
      return { claim, message: partnerEnrollmentMessage(claim), challenge_token: signToken(claim, secret()) };
    },

    async activate(principal: PartnerPrincipal, connection: PartnerConnection, input: unknown) {
      const scopes = connectionContext(principal, connection);
      const body = object(input, "activation request");
      onlyFields(body, ["grant", "challenge_token", "signature"]);
      const claim = readToken(body.challenge_token, secret(), now());
      if (claim.app_id !== principal.app_id || claim.agent_id !== connection.id || claim.external_user_id !== connection.externalUserId || canonicalJson(claim.scopes) !== canonicalJson(scopes)) {
        return fail(403, "challenge_context_mismatch", "This authorization was signed for a different app, user, agent, or set of scopes");
      }
      if (typeof body.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) return fail(400, "invalid_signature", "An owner wallet signature is required");
      let digest: Hex;
      try { digest = partnerGrantDigest(body.grant); } catch { return fail(400, "invalid_grant", "Grant must contain JSON values only"); }
      if (digest !== claim.grant_hash) return fail(403, "grant_digest_mismatch", "The grant differs from the exact permission the owner authorized");
      const grant = validGrant(body.grant, now());
      if (grant.owner !== claim.owner || grant.smartAccount !== claim.smart_account || grant.chainId !== claim.chain_id) return fail(403, "grant_context_mismatch", "The grant owner, account, or chain differs from this authorization");
      let signer: Address;
      try { signer = await recover({ message: partnerEnrollmentMessage(claim), signature: body.signature as Hex }); }
      catch { return fail(401, "invalid_signature", "The owner signature could not be verified"); }
      if (signer.toLowerCase() !== claim.owner) return fail(403, "wrong_owner", "This authorization was not signed by the grant's owner");
      let derived: Derivation;
      try { derived = await derive(grant.owner, grant.chainId); }
      catch { return fail(503, "derivation_unavailable", "The account derivation could not be verified; retry when the chain is available"); }
      if (!derived.ok) return fail(503, "derivation_unavailable", derived.why);
      if (!accountsMatch(derived, grant.smartAccount).ok) return fail(403, "account_mismatch", "The agent wallet does not derive from this owner");
      // Consume outside the long enrollment transaction: a later write failure
      // must not roll back single-use authorization and reopen a signed token.
      if (!await store().consumeNonce(`enrollment:${claim.nonce}`, Math.ceil(claim.expires_at / 1000))) return fail(409, "challenge_used", "This enrollment authorization has already been used");

      return store().withEnrollmentLock(grant.owner, async () => {
        const current = await store().byId(principal.app_id, connection.id);
        if (!current) return fail(404, "not_found", "No such agent");
        const currentScopes = connectionContext(principal, current);
        if (current.externalUserId !== claim.external_user_id || canonicalJson(currentScopes) !== canonicalJson(claim.scopes) || (current.tenant && current.tenant !== grant.owner)) return fail(409, "connection_changed", "The agent connection changed; request a fresh authorization");
        const occupied = await store().byTenant(principal.app_id, grant.owner);
        if (occupied && occupied.id !== current.id) return fail(409, "wallet_already_linked", "This wallet is already linked to another user of this app");
        const grantStore = await grants();
        const holder = await grantStore.tenantForAccount(grant.smartAccount);
        if (holder && holder.toLowerCase() !== grant.owner) return fail(409, "account_already_claimed", "This account already belongs to a different Merrymen login");
        const ownGrant = await grantStore.get(grant.owner);
        if (ownGrant && ownGrant.owner.toLowerCase() !== grant.owner) return fail(409, "owner_model_mismatch", "This login already has an agent owned by a different wallet; use that owner's recovery and setup flow");
        const settingsStore = await settings();
        const previous = await settingsStore.get(grant.owner) ?? {};
        const safe: MerrymenSettings = {
          ...previous, agentName: claim.settings.name, strategy: claim.settings.strategy,
          basketSymbols: claim.settings.basket_symbols, paperTradingEnabled: true, liveTradingEnabled: false,
        };
        try {
          // Keep the old permission in paper mode until the replacement has
          // been durably installed and the partner's consent has been bound.
          await settingsStore.put(grant.owner, safe);
          await (await identities()).ensure(grant.owner, grant.smartAccount);
          await grantStore.put(grant.owner, grant);
          const bound = await store().bindAuthorized(current.id, principal.app_id, grant.owner, claim.scopes);
          if (claim.settings.live_trading_enabled) await settingsStore.put(grant.owner, { ...safe, liveTradingEnabled: true });
          return { connection: bound, smartAccount: grant.smartAccount, chainId: grant.chainId };
        } catch (error) {
          if (error instanceof PartnerError || (error && typeof error === "object" && "status" in error && "code" in error)) throw error;
          return fail(503, "enrollment_storage_failed", "Enrollment could not be fully saved. Request a fresh challenge and retry; inspect agent status before continuing");
        }
      });
    },
  };
}
