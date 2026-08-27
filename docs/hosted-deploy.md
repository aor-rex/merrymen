# Deploying hosted merrymen on Railway (testnet slice)

The hosted stack is **three Railway pieces from one repo**:

| Piece | What it is | Start command |
|---|---|---|
| **web** | the Next.js dashboard + API (SIWE auth, grant/settings intake) | `npm run start:web` (the image default) |
| **orchestrator** | the process-per-tenant supervisor (spawns one worker child per tenant) | `npm run start:orchestrator` |
| **Postgres** | the shared grant + settings store | Railway's managed Postgres plugin |

Both services build from the **same `Dockerfile`** (one image, two start commands). Every secret is injected at **runtime** by Railway — nothing is baked into the image.

---

## 1. Provision Postgres
Add Railway's **Postgres** plugin to the project. It exposes `DATABASE_URL`; reference it from both services (Railway's `${{Postgres.DATABASE_URL}}`). The grant/settings tables are created on first use — no migration step for the slice.

## 2. Generate the two server secrets
Run locally and keep the output safe (a password manager, not a file in the repo):

```bash
# MERRYMEN_SESSION_SECRET — signs session cookies + auth nonces (>= 32 chars)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
# MERRYMEN_STORE_DEK — the 32-byte data-encryption key that seals session keys
# and settings at rest (base64). web SEALS with it, the orchestrator UNSEALS.
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## 3. House keys (testnet)
The orchestrator injects these into each child; a tenant never sets them (they are stripped server-side). For the testnet slice:
- **Bundler** — `MERRYMEN_BUNDLER_API_KEY` (a **Pimlico** key). The worker builds the URL per chain as `https://api.pimlico.io/v2/<chainId>/rpc?apikey=…`; Pimlico supports Robinhood testnet **46630** (listed as `robinhood-testnet`). Get a key at <https://dashboard.pimlico.io> (free tier is fine for the slice). Alternatively set `MERRYMEN_BUNDLER_URL` to a full 4337 RPC from any bundler that supports 46630.
- **RPC** — `MERRYMEN_RPC_TESTNET`. The public endpoint is **`https://rpc.testnet.chain.robinhood.com`** (already the chain's built-in default in `packages/core/src/chain.ts`; set it explicitly, or point at a private endpoint for reliability). `MERRYMEN_RPC_MAINNET` = `https://rpc.mainnet.chain.robinhood.com` for 4663 later.
- **LLM** (optional, for the strategist) — `GROQ_API_KEY` (free tier) or `ANTHROPIC_API_KEY`.
- **Gas** — the smart account self-pays (no paymaster in the wall by default), so each armed tenant's smart account needs testnet ETH on 46630 from the Robinhood Chain faucet (see <https://docs.robinhood.com/chain/>).

## 4. Environment, per service

**Shared (both web and orchestrator):**
| Var | Value |
|---|---|
| `MERRYMEN_HOSTED` | `1` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `MERRYMEN_STORE_DEK` | the base64 DEK from step 2 |

**web only:**
| Var | Value |
|---|---|
| `MERRYMEN_SESSION_SECRET` | the secret from step 2 |
| `MERRYMEN_PUBLIC_ORIGIN` | the web service's public URL, e.g. `https://merrymen.up.railway.app` — auth binds signatures to it |
| `PORT` | set by Railway automatically; `start:web` honours it |

**orchestrator only** (the house keys from step 3):
| Var | Value |
|---|---|
| `MERRYMEN_BUNDLER_API_KEY` *(or `MERRYMEN_BUNDLER_URL`)* | Pimlico key / full bundler URL |
| `MERRYMEN_RPC_TESTNET` | testnet 46630 RPC |
| `GROQ_API_KEY` *(optional)* | strategist brain |

> The orchestrator must NOT get `MERRYMEN_SESSION_SECRET`, and the web service does not need the house keys. The DEK is the one secret both hold. Children get the house keys but never the DEK / session secret / `DATABASE_URL` (the supervisor strips them at fork).

## 5. Create the two services
1. **web** — new service from this repo. It uses `railway.json` as-is (Dockerfile build, `start:web`, healthcheck `/api/version`). Set the web env above.
2. **orchestrator** — a second service from the same repo. Override the **start command** to `npm run start:orchestrator` and disable its healthcheck (it serves no HTTP). Set the orchestrator env above. It needs **no public domain**.

## 6. Deploy & verify
- Web comes up at `MERRYMEN_PUBLIC_ORIGIN`; `GET /api/version` returns 200.
- Open the dashboard, **sign in** (SIWE — your wallet signs a free challenge), create/**sign a testnet grant** (session-key-only; the owner key never leaves your browser).
- The orchestrator logs `... spawned (pid …)` for your tenant within ~15s and writes `children/<you>/grant.json` (session key only) + `settings.json`.
- **Fund** the smart account on testnet (ETH for gas). The child arms and trades on 46630.

## 7. Known limits of the slice (closed in Phase B)
- **The dashboard feed now reads the shared Postgres** — the ledger→Postgres port (B2) has landed, so `/api/feed` and `/api/scoreboard` show a child's live numbers in hosted mode. (`pg` is a runtime-only dependency the `Dockerfile` installs into the image; it is deliberately absent from `package.json` so self-hosted stays lean.)
- **Telegram + `merrymen export` are still SQLite-only.** The Telegram read commands (`/status`, `/pnl`, `/trades`, `/report`), the trade-ping notifier, the Virtuals streamer, and the audit CLI still open a child's local SQLite file, so they read **empty** on a hosted deploy (blind, never another tenant's data — every content query is agent-scoped). Trading, the wall, and the dashboard are unaffected; routing these readers through the Postgres driver is A6/Telegram-multi-tenant. Watch the child logs for Telegram until then.
- **Keep web at ONE replica.** Auth nonces are in-memory; multiple web replicas would let a nonce replay across them. Multi-replica needs the KV-backed nonce store (B4/Railway hardening).
- **Single orchestrator replica.** The per-tenant Postgres advisory lease (so two orchestrators never both trade a tenant) is Phase B; run exactly one orchestrator until it lands.
- **Testnet only.** Before real funds: the mainnet re-audit + a two-funded-tenant testnet run (see `docs/hosted-platform-plan.md`).
