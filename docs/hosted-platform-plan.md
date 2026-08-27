# Hosted merrymen — the multi-tenant platform build

Turning the self-hosted single-tenant app into a live, multi-tenant service on
Railway that anyone can use from a URL. Owner decision: **live from day one,
fully hard-gated** — every phase-1 constraint from the security audit in place
before real funds.

## The audit, in one line

Deploying the current code to a public URL has **three independent fund-loss
paths**: (1) the dashboard uploads the owner key to the server; (2) `/api/recover`
sweeps to any address with no login; (3) the worker's single global `active`
agent cross-drives tenants. The DB is already multi-tenant (every table keyed by
`smart_account`), the mobile signer already proves session-key-only grants work,
and the on-chain wall is sound — a leaked *session* key is value-churn, never
theft. The bones are right; the single-tenant *wrapper* is the whole job.

## Phase-1 hard constraints (non-negotiable, from the audit)

1. **Owner key NEVER on the server.** Session-key-only grants; recovery fully
   client-side. `/api/grants` rejects any payload carrying an owner key.
2. **No server-side recover/sweep.** Delete it; recovery runs in the browser.
3. **SIWE auth on every mutating route.** Tenant = recovered address; authorize
   on it, never on self-declared `grant.owner`.
4. **Process-per-tenant**, not shared-process. `active` + ~47 module globals
   stay single-tenant, correct by construction. In-process multiplex is a later,
   separately-audited phase.
5. **Per-tenant Postgres advisory leasing** — exactly one worker trades a tenant;
   no replica trades everyone.
6. **All fund-critical state in Postgres** before live funds (Railway FS is
   ephemeral — a redeploy strands funded accounts).
7. **House keys server-only + unreadable by tenants**, per-tenant rate limits,
   explicit THROTTLED state (never silent paper-mode degrade).
8. **Session keys encrypted at rest.** Never weaken the wall's no-transfer
   permission or the ERC-1271 block — they are what keep a leaked session key
   from becoming theft.
9. **Chain binding** — refuse to arm if the RPC/bundler chain ≠ grant.chainId.
10. **Telegram agent-mode/auto-shell OFF** on hosted infra; single getUpdates
    cursor routing by from-id → tenant; notifier targets the tenant's own chat.

## Reconciled with the wall-narrowing audit (2026-08-27)

An earlier design pass (`docs/hosted-worker-design.md`, pre-P2) called wall
narrowing "step zero". That is now **done** and verified in `wall.ts`:
`NOT_FOR_VALIDATE_SIG` (off-chain signing), swap/vault recipients pinned to
`self`, USDG transfer absent by default, Permit2 opt-in + the recipient-in-
bytecode V4 adapter. So "a leaked session key is value-churn, never theft" is
accurate. But that audit surfaced fund-safety work BEYOND the original 8-commit
list — tenant-scoped reads, RCE gates on the strategy loader, first-arm identity
proof, in-flight reconciliation — now folded in below. Owner decisions:
ledger → full Postgres port; sequencing → **testnet vertical slice first**. The
full ordered plan lives in the plan file; this is the tracking checklist.

## Commit order (dependency-sorted)

Foundation (done): SIWE auth (`218535a`), custody boundary (`2b8285c`),
per-tenant encrypted grant store (`94cd881`).

### Phase A — testnet vertical slice
- [x] **A1. One home map** (`537d734`) — web + worker share one `homePaths` via
  `@merrymen/home`; the drifted `web/src/lib/home.ts` is deleted.
- [x] **A2. Tenant-scope reads + fail-close spend writes** (the one-way door) —
  worker reads (`8bef933`): every telegram read + notifier/streamer cursor
  scoped to the process's own agent, hosted never falls back to the global
  guess; web (`13e4898`): feed + scoreboard resolve the agent from the SIWE
  tenant, DatabaseSync degrades instead of 500; writes (`7edc5e4`): addTrade/
  setAgentHwm/addFeeAccrual report failure so a dropped fill keeps spend counted.
- [x] **A3. House keys server-only + settings route locked down** (`ec59d03`) —
  house-key precedence inverted (env wins hosted); `PUT /api/settings` gated
  (401 + strips house-key & RCE fields). Verified over HTTP. *(Per-tenant token
  buckets + THROTTLED moved to B3, where the keys are actually shared.)*
- [x] **A4. RCE hard-off hosted** (`082d917`) — strategy loader fails closed to
  steady-basket; PC/agent/auto-shell forced off in config + rejected at the
  route. Verified over HTTP (non-builtin strategy 400, RCE fields stripped).
- [x] **A5. Orchestrator (single tenant on testnet)** — `trench_positions`
  CREATE TABLE, a today-bug (`1a0190c`); the supervisor (`95f6d7b`): reconcile
  spawns/stands-down one worker child per tenant, curated env (house keys in,
  DEK/secret/db-url stripped), heartbeat watchdog + SIGKILL, crash backoff,
  FLEET_HALT. Live-verified: spawns a child with its own home + session-only
  grant, custody boundary holds through the fork. **Deferred to B:** the Postgres
  advisory lease + in-flight reconciliation (single-replica/testnet until then).
- [ ] **A6. Telegram multi-tenant.** One bot, one cursor, route by from-id;
  per-tenant notifier state.

### Phase B — hardening + durability before real funds
- [ ] **B1. First-arm identity proof** (recover from `enableSignature` /
  recompute counterfactual) — closes agent-id squatting.
- [ ] **B2. Ledger → Postgres** behind `getDb()`; async-ify the 15 sync exports;
  retention + per-tenant quota.
- [ ] **B3. Gas DRY state + per-tenant bundler accounting.**
- [ ] **B4. Railway config + multi-replica nonce store (KV).**
- [ ] **B5. Hosted-mode copy** — "owner key never leaves; server holds a capped
  session key"; kill UI says "stopped & deleted, expires on <date>".

### Phase C — mainnet
- [ ] Re-audit + two-funded-tenant testnet run, then flip to 4663.

## Verification gates

- Every commit: `npx tsc -p web`/`-p worker`, `npm test`.
- Before ANY live deploy: a full adversarial re-audit of the custody boundary
  and tenant isolation (the same fan-out that produced this plan), plus a
  testnet multi-tenant run proving two funded tenants never cross.
