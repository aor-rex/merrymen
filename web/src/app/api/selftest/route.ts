/**
 * Ask the worker to run its pipeline probe, and report what came back.
 *
 * WHY THIS EXISTS. `merrymen selftest` is a CLI flag, and hosted spawns the
 * worker without it (orchestrator.ts) — so the one command designed to answer
 * "can this agent actually transact" was unreachable for every hosted tenant.
 * That is how a fleet-wide arming failure stayed invisible for hours: the only
 * way to find out was to read container logs by hand.
 *
 * THE WEB PROCESS CANNOT RUN IT. The worker is a separate process — a separate
 * container, hosted — with no HTTP server and no IPC. So this enqueues and the
 * worker's tick drains. Everything the dashboard has ever told the worker has
 * gone through a store the other side polls; this is that pattern, not a new
 * transport.
 *
 * WHAT IT IS NOT. Not an order path. The only `kind` written here is a literal,
 * so a compromised session cannot use this to make the agent trade. When chat
 * orders land they go through the same channel with their own validation and
 * their own wall check — the channel is deliberately dumb.
 */
import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { homePaths, merrymenHome } from "@merrymen/home";
import { isHostedMode } from "@merrymen/core";
import { tenantOf } from "@/lib/auth";
import { getGrantStore } from "@merrymen/grant-store";
import { writeCommand } from "@merrymen/command-files";
import { withReadDb } from "@/lib/ledger";

export const dynamic = "force-dynamic";

/**
 * Which AGENT this request may act for.
 *
 * THE TENANT IS NOT THE AGENT. `tenantOf` returns the signed-in browser
 * wallet; `agent_id` throughout this ledger is the ERC-4337 SMART ACCOUNT —
 * `ensureAgent` returns `grant.smartAccount`, and the worker claims against
 * that. Writing the tenant address into `agent_id` produced a row no worker
 * would ever match, a POST that returned 200, and a status that read 'queued'
 * forever. Caught in review.
 *
 * Resolved through the GRANT STORE, keyed on the authenticated tenant. Not
 * through `agents.owner_address` the way the feed and scoreboard routes do —
 * hosted, `owner_address` is the browser-GENERATED grant owner and is never
 * the tenant, so that lookup would find nothing here.
 */
async function agentFor(req: Request): Promise<`0x${string}` | null> {
  if (isHostedMode()) {
    // The caller cannot name the agent — only the session decides, so one
    // tenant can never probe (or spend the gas of) another's.
    const tenant = tenantOf(req);
    if (!tenant) return null;
    const grant = await getGrantStore().get(tenant);
    return (grant?.smartAccount as `0x${string}`) ?? null;
  }
  // Self-hosted has no auth; the localhost middleware is the perimeter, exactly
  // as it is for /api/settings. The agent is whichever grant is on disk.
  try {
    const g = JSON.parse(await readFile(homePaths.grant(), "utf8")) as { smartAccount?: string };
    return (g.smartAccount as `0x${string}`) ?? null;
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const agent = await agentFor(req);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  // The id is generated HERE rather than accepted from the caller: an id a
  // client chooses is an id a client can collide with somebody else's.
  const id = crypto.randomUUID();

  // SELF-HOSTED SKIPS THE DATABASE ENTIRELY. The web process and the worker
  // share one MERRYMEN_HOME, so the command can be dropped straight into the
  // directory the worker drains — no table, no ferry, no shared handle.
  if (!isHostedMode()) {
    try {
      writeCommand(merrymenHome(), { id, kind: "selftest", at: Date.now() });
      return NextResponse.json({ id, queued: true });
    } catch (e) {
      return NextResponse.json(
        { error: `couldn't queue it: ${e instanceof Error ? e.message : String(e)}` },
        { status: 503 },
      );
    }
  }

  // Hosted: the orchestrator is the only process that can reach both the
  // shared database and a child's home, so it ferries. See command-files.ts.
  const ok = await withReadDb(async (db) => {
    if (!db) return false;
    try {
      await db
        .prepare("INSERT INTO agent_commands (id, agent_id, kind, created_at) VALUES (?, ?, ?, ?)")
        // Milliseconds — see the schema note. The column has no default, so
        // forgetting it is a write error rather than a silently-wrong unit.
        .run(id, agent, "selftest", Date.now());
      return true;
    } catch {
      return false;
    }
  });

  if (!ok) {
    return NextResponse.json(
      {
        error:
          "couldn't queue it — the ledger is unreachable, which usually means this agent's worker has never run",
      },
      { status: 503 },
    );
  }
  return NextResponse.json({ id, queued: true });
}

/** What happened to the most recent probe. Polled by the button that queued it. */
export async function GET(req: Request) {
  const agent = await agentFor(req);
  if (!agent) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const row = await withReadDb(async (db) => {
    if (!db) return null;
    try {
      return ((await db
        .prepare(
          `SELECT id, kind, created_at, claimed_at, done_at, result FROM agent_commands
            WHERE agent_id = ? AND kind = 'selftest' ORDER BY created_at DESC LIMIT 1`,
        )
        .get(agent)) ?? null) as Record<string, unknown> | null;
    } catch {
      return null;
    }
  });

  if (!row) return NextResponse.json({ state: "none" });
  const done = row.done_at !== null && row.done_at !== undefined;
  const claimed = row.claimed_at !== null && row.claimed_at !== undefined;
  return NextResponse.json({
    id: String(row.id),
    // Three states, not two. "queued" and "running" look identical to someone
    // watching a spinner, but they mean different things when it stops changing:
    // queued-forever is a worker that is not draining at all, running-forever is
    // a probe that hung.
    state: done ? "done" : claimed ? "running" : "queued",
    result: row.result === null || row.result === undefined ? null : String(row.result),
    at: Number(row.created_at),
  });
}
