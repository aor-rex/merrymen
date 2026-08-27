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
 * NOT YET (Phase B, before real funds): the per-tenant Postgres advisory lease
 * (so two orchestrator replicas never both trade a tenant) and in-flight-UserOp
 * reconciliation on restart (so a SIGKILL between submit and ledger-write doesn't
 * under-count spend). Both are noted at their call sites. This supervisor is
 * single-replica + testnet until they land.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { merrymenHome } from "./home";
import { getGrantStore } from "./grant-store";
import { isHostedMode } from "../../packages/core/src/index";

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
let stopping = false;

function log(msg: string): void {
  console.log(`[orchestrator] ${msg}`);
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

async function spawnChild(tenant: `0x${string}`, restarts = 0): Promise<void> {
  if (stopping) return;
  // PHASE B: take a per-tenant Postgres advisory lease here, BEFORE arming, so a
  // second orchestrator replica can never also run this tenant — and reconcile
  // any in-flight UserOp from the last run in the same step, so a restart doesn't
  // under-count spend. Single-replica + testnet until then.
  if (!(await writeGrantForChild(tenant))) {
    log(`${tenant}: no grant in the store — not spawning`);
    return;
  }
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
  // Spawn any tenant with a grant that isn't running.
  for (const tenant of tenants) {
    if (!children.has(tenant.toLowerCase())) await spawnChild(tenant.toLowerCase() as `0x${string}`);
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
    setTimeout(() => process.exit(0), 1_000);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // The main loop: honour a fleet-halt, else reconcile + watchdog every tick.
  for (;;) {
    if (stopping) return;
    if (haltRequested()) {
      if (children.size > 0) {
        log("FLEET_HALT present — standing every child down");
        for (const t of [...children.keys()]) killChild(t);
      }
    } else {
      await reconcile();
      watchdog();
    }
    await new Promise((r) => setTimeout(r, RECONCILE_MS));
  }
}

// Run when invoked directly (`tsx worker/src/orchestrator.ts`); importing it for
// tests does not trip this, so the pure helpers above stay unit-testable.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  void runOrchestrator();
}
