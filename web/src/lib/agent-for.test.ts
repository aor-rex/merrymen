/**
 * The dashboard must never key an agent lookup on `agents.owner_address`.
 *
 * This pins a defect that was invisible for the whole hosted deployment. Both
 * the feed and the scoreboard resolved "which agent belongs to this tenant" as:
 *
 *     SELECT smart_account FROM agents WHERE LOWER(owner_address) = <tenant>
 *
 * `owner_address` is written from `grant.owner` (worker/src/store.ts), and
 * hosted, `grant.owner` is the owner key the BROWSER generated. It is never the
 * tenant — web/src/app/api/grants/route.ts records that requiring the two to
 * match rejected every hosted grant ever submitted. So the comparison matched
 * zero rows for every hosted user.
 *
 * It failed CLOSED, which is why nobody caught it: an empty trade tape and an
 * empty scoreboard look exactly like an agent that has not traded yet. Balances
 * kept rendering because those are read from the chain directly, so the result
 * was a dashboard that looked healthy and quiet while showing none of the
 * ledger.
 *
 * The grant store is the real tenant→account index — `tenant` is its primary
 * key. web/src/lib/agent-for.ts is the only sanctioned way to ask.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.join(process.cwd(), "web", "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Load-bearing, exactly as in client-env.test.ts: the files that explain this
 * bug NAME the column, and a naive scan would flag the very comments warning
 * people off it. Only real code counts.
 */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("no web module resolves an agent through owner_address", () => {
  const offenders = walk(SRC)
    .filter((f) => /\bowner_address\b/.test(code(f)))
    .map((f) => path.relative(process.cwd(), f));

  assert.deepEqual(
    offenders,
    [],
    `These files reference agents.owner_address in real code. Hosted, that column ` +
      `holds the owner key the BROWSER generated and is never the signed-in tenant, so ` +
      `any lookup keyed on it matches zero rows and fails closed — an empty dashboard ` +
      `that reads as a quiet agent. Resolve through the grant store instead: ` +
      `hostedAgentFor() / diskAgent() in web/src/lib/agent-for.ts.\n  ${offenders.join("\n  ")}`,
  );
});
