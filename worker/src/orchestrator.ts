/**
 * The hosted supervisor — one worker child per tenant.
 *
 * merrymen's worker keeps ~35 pieces of per-agent state (the `active` handle, the
 * money counters, the price/HWM caches, the discovery cursors) as locals INSIDE
 * main()'s closure, and only four true module globals (the sqlite handle, the
 * mainnet client, the grant-store cache, the ensureHome latch) — all per-process.
 * So a fresh PROCESS per tenant makes every one of them tenant-correct by
 * construction, with no in-process multiplexing to get wrong. That is the whole
 * tenancy model: this file fans main() out, one OS process at a time.
 *
 * WHAT IT DOES
 *  - reconcile: read the grant store, spawn a child for every tenant that has a
 *    grant and isn't running, stop the child of any tenant whose grant is gone
 *    (the kill switch);
 *  - each child gets its OWN MERRYMEN_HOME (…/children/<tenant>) with the tenant's
 *    session-key-only grant written to grant.json, and a curated env that carries
 *    the platform's house keys (bundler/RPC/LLM) but NOT the orchestrator-only
 *    secrets (the store DEK, the session secret, the database URL);
 *  - watchdog: a child whose heartbeat goes stale past a generous threshold is
 *    SIGKILLed and restarted — a JS timeout can't reclaim a spinning tick, only
 *    the OS can;
 *  - crash backoff, and a fleet-halt file that stands the whole band down.
 *
 * MULTI-REPLICA SAFETY. Before arming a tenant this takes a per-tenant Postgres
 * advisory lease (tenant-lease.ts) and holds it for the child's whole life, so a
 * second orchestrator replica can never also arm the same tenant and double its
 * daily spend. Without a shared database the lease is a no-op hold (one process
 * by construction). A lease that goes unhealthy — its connection dropped, so
 * Postgres released the lock — stands the child down rather than let it trade
 * unprotected.
 *
 * NOT YET (Phase B, before real funds): in-flight-UserOp reconciliation on
 * restart, so a SIGKILL between submit and ledger-write doesn't under-count
 * spend. That lives in the WORKER's arm path (it needs the chain client and the
 * ledger, which the child already has), and runs before the child seeds its
 * budget counters — noted at store.ts's fail-closed write and at the arm site.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { merrymenHome } from "./home";
import { getGrantStore } from "./grant-store";
import { getSettingsStore } from "./settings-store";
import { acquireTenantLease, type TenantLease } from "./tenant-lease";
import { isHostedMode, type MerrymenSettings } from "../../packages/core/src/index";
import { makePgDb, translateSchema } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant, openChildLedger } from "./ledger-mirror";
import { applyLedgerSchema } from "./store";

/** How often to re-read the store for tenants added or killed. */
const RECONCILE_MS = 15_000;
/** A child with no fresh heartbeat for this many seconds is wedged → SIGKILL. */
const WATCHDOG_STALE_SEC = 180;
/** Don't watchdog a child until it's had a chance to write its first beat. */
const WATCHDOG_GRACE_SEC = 90;
/** Cap a child's heap well below the container so an OOM kills the offender, not the box. */
const CHILD_MAX_OLD_SPACE_MB = 384;
/** Give up restarting a child that keeps dying right after start. */
const MAX_RESTARTS = 8;

/** The worker entrypoint each child runs — the same main() the CLI supervises. */
const WORKER_ENTRY = path.join(fileURLToPath(new URL(".", import.meta.url)), "index.ts");
/** Repo root (…/worker/src → up two), the cwd children need to resolve tsx + deps. */
const ROOT = path.join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

/**
 * Env vars the orchestrator holds that a CHILD must NEVER see. The house keys
 * (bundler/RPC/LLM) are deliberately NOT here — hosted mode WANTS them injected,
 * that is the whole point of house-keys-server-only. What a child has no business
 * holding is the material that decrypts OTHER tenants' stored session keys (the
 * DEK), forges any tenant's session (the signing secret), or reaches the shared
 * grant database (the URL). Strip those; forward everything else so the child
 * still has PATH and the OS essentials node needs to run.
 */
const CHILD_SECRET_STRIP = ["MERRYMEN_STORE_DEK", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;

/** Where a tenant's child keeps its own ~/.merrymen — isolated from every other. */
export function childHome(tenant: string): string {
  return path.join(merrymenHome(), "children", tenant.toLowerCase());
}

/** The fleet-halt marker: present = stop every child and spawn none. Operator-only. */
export function fleetHaltFile(): string {
  return path.join(merrymenHome(), "FLEET_HALT");
}

/**
 * TELEGRAM BOT COLLISION GUARD. A Telegram bot accepts exactly ONE long-poll
 * getUpdates loop per token — two children polling the same token would steal
 * each other's updates, and one tenant's bot could surface another's replies.
 * Each hosted tenant brings their OWN bot; if two ever share a token, only the
 * first (by the caller's iteration order) keeps it and the rest get Telegram
 * stripped rather than clobbering. Mutates `settings` and returns true when it
 * stripped a duplicate.
 */
export function dedupeBotToken(settings: MerrymenSettings, seen: Set<string>): boolean {
  const token = settings.telegramBotToken;
  if (!token) return false;
  if (seen.has(token)) {
    delete settings.telegramBotToken;
    return true;
  }
  seen.add(token);
  return false;
}

/**
 * A child's env: the orchestrator's env, minus the child-secret keys, plus this
 * tenant's home and the hosted flag. Inheriting (rather than allowlisting) keeps
 * the OS essentials and the injected house keys; the strip is what makes it safe.
 */
export function childEnv(tenant: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of CHILD_SECRET_STRIP) delete env[k];
  env.MERRYMEN_HOSTED = "1";
  env.MERRYMEN_HOME = childHome(tenant);
  return env;
}

interface Child {
  proc: ChildProcess;
  tenant: `0x${string}`;
  startedAt: number;
  restarts: number;
}

const children = new Map<string, Child>();
/**
 * The advisory lease held for each tenant we are running, keyed by lowercased
 * tenant. Acquired in reconcile() BEFORE the first spawn and held across crash
 * restarts (never re-acquired per process — a restart must not open a window for
 * another replica). Released only when the tenant is no longer wanted (kill
 * switch), when its lease goes unhealthy, or on shutdown.
 */
const leases = new Map<string, TenantLease>();
let stopping = false;

function log(msg: string): void {
  console.log(`[orchestrator] ${msg}`);
}

/** Release and forget a tenant's lease. Best-effort; safe if none is held. */
async function releaseLease(tenant: string): Promise<void> {
  const lease = leases.get(tenant);
  if (!lease) return;
  leases.delete(tenant);
  try {
    await lease.release();
  } catch {
    /* best-effort — a dropped connection has already released the lock */
  }
}

/** Read a child's heartbeat `at` (unix seconds), or null if it hasn't beaten yet. */
function heartbeatAt(tenant: string): number | null {
  try {
    const hb = JSON.parse(readFileSync(path.join(childHome(tenant), "heartbeat.json"), "utf8")) as { at?: number };
    return typeof hb.at === "number" ? hb.at : null;
  } catch {
    return null;
  }
}

/** Write the tenant's session-key-only grant into its child's grant.json. */
async function writeGrantForChild(tenant: `0x${string}`): Promise<boolean> {
  const grant = await getGrantStore().get(tenant);
  if (!grant) return false;
  const home = childHome(tenant);
  mkdirSync(home, { recursive: true });
  // grant.json holds the SESSION key (the store already refused any owner key),
  // so keep it owner-only. chmod is a POSIX no-op that throws on Windows — the
  // container is Linux, and self-hosted never runs the orchestrator.
  writeFileSync(path.join(home, "grant.json"), JSON.stringify(grant, null, 2), { encoding: "utf8", mode: 0o600 });
  return true;
}

/**
 * Hand the child the tenant's OWN settings.json from the store — their strategy,
 * basket, custom tokens, sizing, their Telegram bot. No-op if the tenant has
 * saved nothing yet (the child then runs the safe defaults). Refreshed every
 * reconcile so a config change propagates: the worker re-reads settings.json each
 * tick, and mergeSettings strips house keys + forces the RCE flags off, so what
 * the tenant stored can only ever be their own legitimate configuration.
 */
async function writeSettingsForChild(tenant: `0x${string}`, seenBotTokens?: Set<string>): Promise<void> {
  try {
    const settings = await getSettingsStore().get(tenant);
    if (!settings) return;
    if (seenBotTokens && settings.telegramBotToken && dedupeBotToken(settings, seenBotTokens)) {
      log(`${tenant}: telegram bot token already claimed by another tenant — telegram disabled for this child`);
    }
    const home = childHome(tenant);
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, "settings.json"), JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    /* best-effort — the child falls back to defaults */
  }
}

async function spawnChild(tenant: `0x${string}`, restarts = 0): Promise<void> {
  if (stopping) return;
  // The advisory lease is a precondition, taken by reconcile() before the FIRST
  // spawn and held across restarts — so this path (including the crash-restart
  // that re-enters here) never re-acquires it, which would open a window for
  // another replica. Refuse to arm without a healthy lease: a restart that finds
  // the lease gone must not trade unprotected.
  const lease = leases.get(tenant);
  if (!lease || !lease.healthy()) {
    log(`${tenant}: no healthy lease — not spawning (another replica may hold it)`);
    return;
  }
  if (!(await writeGrantForChild(tenant))) {
    log(`${tenant}: no grant in the store — not spawning`);
    return;
  }
  await writeSettingsForChild(tenant);
  const proc = spawn(
    process.execPath,
    [`--max-old-space-size=${CHILD_MAX_OLD_SPACE_MB}`, "--import", "tsx", WORKER_ENTRY],
    { cwd: ROOT, env: childEnv(tenant), stdio: ["ignore", "pipe", "pipe"] },
  );
  const child: Child = { proc, tenant, startedAt: Date.now(), restarts };
  children.set(tenant, child);
  const tag = `[${tenant.slice(0, 8)}]`;
  const pipe = (stream: NodeJS.ReadableStream | null, sink: NodeJS.WriteStream) =>
    stream?.on("data", (c: Buffer) =>
      String(c)
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .forEach((l) => sink.write(`${tag} ${l}\n`)),
    );
  pipe(proc.stdout, process.stdout);
  pipe(proc.stderr, process.stderr);

  proc.on("exit", (code) => {
    children.delete(tenant);
    if (stopping) return;
    log(`${tenant} exited (${code})`);
    // A long healthy run that then dies is a fresh incident, not a crash loop.
    const freshRestarts = Date.now() - child.startedAt > 60_000 ? 0 : restarts + 1;
    if (freshRestarts > MAX_RESTARTS) {
      log(`${tenant} keeps dying right after start — giving up until the next reconcile`);
      return;
    }
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(freshRestarts, 5));
    log(`${tenant} rallying again in ${Math.round(delay / 1000)}s (restart #${freshRestarts})`);
    setTimeout(() => {
      // Only respawn if the tenant is still meant to be running (not killed meanwhile).
      if (!stopping && !children.has(tenant)) void spawnChild(tenant, freshRestarts);
    }, delay);
  });
  log(`${tenant} spawned (pid ${proc.pid})`);
}

/** Stop a child hard. SIGTERM first for a clean exit, then SIGKILL — a wedged tick only the OS can reclaim. */
function killChild(tenant: string): void {
  const child = children.get(tenant);
  if (!child) return;
  children.delete(tenant); // delete first so the exit handler treats it as intentional
  child.proc.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 3_000);
}

/** Bring the running set in line with the store: spawn new tenants, stop killed ones. */
export async function reconcile(): Promise<void> {
  if (stopping) return;
  const store = getGrantStore();
  let tenants: `0x${string}`[];
  try {
    tenants = await store.listTenants();
  } catch (e) {
    log(`store unreadable, skipping this reconcile: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const wanted = new Set(tenants.map((t) => t.toLowerCase()));

  // A lease whose connection dropped no longer protects its tenant — Postgres
  // has released the lock and another replica may hold it. Stand the child down
  // and drop the lease; the acquire below will try to re-take it (or find the
  // other replica now owns it). This is what makes the lock a live guarantee and
  // not just a start-time check.
  for (const [tenant, lease] of [...leases]) {
    if (!lease.healthy()) {
      log(`${tenant}: lease lost (connection dropped) — standing the child down until it can be re-leased`);
      if (children.has(tenant)) killChild(tenant);
      await releaseLease(tenant);
    }
  }

  // Spawn any wanted tenant that isn't running — but only behind a lease. Acquire
  // one first (unless we already hold it from a previous reconcile / across a
  // crash restart); if another replica holds it, skip this tenant and try again
  // next reconcile.
  for (const tenant of tenants) {
    const lc = tenant.toLowerCase() as `0x${string}`;
    if (children.has(lc)) continue;
    if (!leases.has(lc)) {
      let lease: TenantLease | null;
      try {
        lease = await acquireTenantLease(lc);
      } catch (e) {
        log(`${lc}: lease attempt failed, skipping this reconcile: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (!lease) {
        log(`${lc}: leased by another replica — not arming here`);
        continue;
      }
      leases.set(lc, lease);
    }
    await spawnChild(lc);
  }
  // Refresh every running child's settings.json so a tenant's config change
  // reaches it (the worker re-reads settings.json each tick). Cheap: one small
  // file per tenant, and unchanged content is a harmless rewrite. The shared
  // seenBotTokens set de-duplicates Telegram bots across the fleet (see the guard
  // in writeSettingsForChild).
  const seenBotTokens = new Set<string>();
  for (const tenant of children.keys()) {
    await writeSettingsForChild(tenant as `0x${string}`, seenBotTokens);
  }
  // Stop (and forget) any running child whose grant is gone — the kill switch.
  for (const tenant of [...children.keys()]) {
    if (!wanted.has(tenant)) {
      log(`${tenant} grant removed — standing it down`);
      killChild(tenant);
      try {
        rmSync(childHome(tenant), { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
  // Release any lease we still hold for a tenant that is no longer wanted — both
  // the kill-switch case above and a lease left over from a child that has since
  // exited. Holding a lease for a tenant we won't arm would block another replica
  // (or a later re-arm) for no reason.
  for (const tenant of [...leases.keys()]) {
    if (!wanted.has(tenant)) await releaseLease(tenant);
  }
}


/**
 * Carry every running child's ledger up to the shared database.
 *
 * The orchestrator is the only process that can: it holds DATABASE_URL (which
 * children deliberately do not) and it knows where each child's home is. See
 * ledger-mirror.ts for why this exists at all — without it the hosted dashboard
 * shows no tape, no positions and no reasoning, whatever the fleet is doing.
 *
 * Best-effort by design. A tenant whose ledger is mid-write or unreadable is a
 * tenant whose dashboard lags a tick; it is never a reason to stop supervising
 * the fleet, which is this process's actual job.
 */
async function mirrorLedgers(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url || children.size === 0) return;
  let shared;
  try {
    shared = await makePgDb(url);
    // The full ledger schema, not just the cursor table. Nothing else applies
    // it to the shared database — children have DATABASE_URL stripped, so their
    // initStore() opens sqlite — which meant every migration that landed in the
    // child schema silently broke the mirror's INSERT for that table until
    // somebody ran the DDL by hand. Idempotent, and it runs on the mirror's own
    // clock, so a fresh deploy heals itself.
    await applyLedgerSchema(shared);
    await shared.exec(translateSchema(MIRROR_STATE_DDL));
  } catch (e) {
    log(`ledger mirror: shared db unavailable — ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  for (const tenant of [...children.keys()]) {
    const child = openChildLedger(childHome(tenant));
    if (!child) continue;
    try {
      const r = await mirrorTenant({ tenant, child, shared });
      const n = Object.values(r.copied).reduce((a, b) => a + b, 0);
      if (n > 0) {
        const detail = Object.entries(r.copied)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
        log(`ledger mirror: ${tenant} +${n} rows (${detail})`);
      }
    } catch (e) {
      log(`ledger mirror: ${tenant} failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** SIGKILL-and-restart any child whose heartbeat has gone stale past the threshold. */
export function watchdog(nowSec = Math.floor(Date.now() / 1000)): void {
  if (stopping) return;
  for (const [tenant, child] of children) {
    const ageSec = (Date.now() - child.startedAt) / 1000;
    if (ageSec < WATCHDOG_GRACE_SEC) continue; // give it time to write its first beat
    const beat = heartbeatAt(tenant);
    const stale = beat === null || nowSec - beat > WATCHDOG_STALE_SEC;
    if (stale) {
      log(`${tenant} heartbeat stale (${beat === null ? "never beat" : `${nowSec - beat}s`}) — SIGKILL + restart`);
      const restarts = child.restarts;
      children.delete(tenant);
      try {
        child.proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      if (!stopping) void spawnChild(tenant as `0x${string}`, restarts + 1);
    }
  }
}

function haltRequested(): boolean {
  try {
    readFileSync(fleetHaltFile());
    return true;
  } catch {
    return false;
  }
}

export async function runOrchestrator(): Promise<void> {
  if (!isHostedMode()) {
    log("MERRYMEN_HOSTED is not set — the orchestrator only runs in hosted mode. Refusing to start.");
    process.exit(1);
  }
  log(`starting — home ${merrymenHome()}, worker ${WORKER_ENTRY}`);

  const stop = () => {
    stopping = true;
    log("stopping — calling the whole fleet home");
    for (const child of children.values()) child.proc.kill("SIGTERM");
    // Release every advisory lease so a restarting replica can take over at once
    // rather than waiting for our dropped connections to time out server-side.
    // Best-effort and unawaited — we exit in a second regardless.
    for (const tenant of [...leases.keys()]) void releaseLease(tenant);
    setTimeout(() => process.exit(0), 1_000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // The main loop: honour a fleet-halt, else reconcile + watchdog every tick.
  for (;;) {
    if (stopping) return;
    if (haltRequested()) {
      if (children.size > 0 || leases.size > 0) {
        log("FLEET_HALT present — standing every child down and releasing leases");
        for (const t of [...children.keys()]) killChild(t);
        // Release leases too: if only THIS replica is halted, another may take
        // the tenants over; if the whole fleet is halted, releasing is harmless.
        for (const t of [...leases.keys()]) await releaseLease(t);
      }
    } else {
      await reconcile();
      watchdog();
      await mirrorLedgers();
    }
    await new Promise((r) => setTimeout(r, RECONCILE_MS));
  }
}

// Run when invoked directly (`tsx worker/src/orchestrator.ts`); importing it for
// tests does not trip this, so the pure helpers above stay unit-testable.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void runOrchestrator();
}
