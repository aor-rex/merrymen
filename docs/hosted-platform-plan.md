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

## Commit order (dependency-sorted)

- [x] **1. Wallet-native auth** (`218535a`) — SIWE challenge/verify, HMAC
  sessions, `MERRYMEN_HOSTED` flag, middleware. The boundary everything
  authorizes against.
- [ ] **2. The custody boundary.** In hosted mode the web signer stops writing
  `demoOwnerPrivateKey` and POSTs the session-key-only shape (the mobile
  `signGrant.ts` template). `/api/grants` rejects any owner-key/mnemonic payload
  and asserts `grant.owner === tenant`. Move recovery client-side; delete the
  server sweep. Boot assertion: hosted mode refuses to start if any grant record
  holds an owner key.
- [ ] **3. Per-tenant state store (Postgres).** Port the file/SQLite state
  (grant + archive, settings, ledger, heartbeat, paused) to Postgres over
  `DATABASE_URL`; schema is already `agent_id`-keyed. Web routes derive
  home/filter per-request from the authenticated tenant instead of a
  module-load constant. Session keys encrypted at rest.
- [ ] **4. House keys + rate limits.** Groq + Pimlico as server secrets, injected
  where the code already builds them (`pimlicoBundlerUrl`, `resolveLlm`); hosted
  settings strip/ignore tenant-supplied bundler/llm/rpc fields (invert
  precedence). Per-tenant token buckets with a surfaced THROTTLED state.
- [ ] **5. Process-per-tenant orchestrator.** A supervisor that leases tenants
  via `pg_try_advisory_lock` and runs one worker child per active grant with its
  own `MERRYMEN_HOME` + injected house keys. Idempotent restart from Postgres.
- [ ] **6. Telegram multi-tenant.** One bot, one cursor, route by from-id;
  agent-mode off by default on hosted infra.
- [ ] **7. Railway config.** Services (web, orchestrator), Postgres, env groups,
  build. `MERRYMEN_PUBLIC_ORIGIN`, `MERRYMEN_SESSION_SECRET`, house keys as
  sealed secrets.
- [ ] **8. Hosted-mode copy.** The front page's "keys never leave your machine"
  becomes true-but-scoped: the OWNER key never leaves; the server holds a
  capped, revocable session key — say exactly that.

## Verification gates

- Every commit: `npx tsc -p web`/`-p worker`, `npm test`.
- Before ANY live deploy: a full adversarial re-audit of the custody boundary
  and tenant isolation (the same fan-out that produced this plan), plus a
  testnet multi-tenant run proving two funded tenants never cross.
