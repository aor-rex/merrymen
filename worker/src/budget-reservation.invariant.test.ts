import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * NOTHING MAY LEAVE A BUDGET RESERVATION BEHIND.
 *
 * processIntent takes an optimistic reservation before the await-heavy part of
 * a trade — `reserveBudget()` bumps `inFlightOps` / `inFlightSpentUsdg`, which
 * `spentToday()` and `opsTodayCount()` add to the settled counters that
 * checkPolicy is then judged against. The reservation is supposed to be
 * released either by `recordTrade` (which refreshes the settled halves first,
 * so the written row is counted before the reservation is dropped) or by the
 * execution catch.
 *
 * The failure this file exists to prevent: an exit path between the two that
 * reaches NEITHER. `refreshBudget` rebuilds only the settled halves — its own
 * comment says it "never touches the in-flight halves" — and the only code that
 * clears a stale reservation runs at arm time, which syncGrant skips whenever
 * the grant is unchanged. So a single missed release is permanent for the life
 * of the arm, and because the intent is re-proposed every tick it compounds
 * once per tick. It ratchets the agent toward `ops-cap` and `daily-cap`, and
 * NEITHER of those carries the exit exemption the drawdown breaker was given —
 * so a big enough leak blocks the sell that would clear the position. Slow,
 * silent, and it ends with the agent unable to get out.
 *
 * That is not hypothetical: the Rialto router-migration skip did exactly this
 * with a bare `return;` from inside the execution try, and two paper-rail
 * windows could do it via a throwing store write.
 *
 * index.ts is a single ~2400-line main() with no exports, so there is no seam
 * to unit-test this through. It is scanned as TEXT instead, the same idiom
 * imports.test.ts already uses on the same file. A structural test on
 * unreachable code beats no test on load-bearing code.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = readFileSync(`${HERE}index.ts`, "utf8");

/** Every reservation site, so a new one added later is covered automatically. */
const RESERVE = /^\s*reserveBudget\(/gm;

test("every reserveBudget site exists at all — the scan is not vacuous", () => {
  const sites = SRC.match(RESERVE) ?? [];
  assert.ok(
    sites.length >= 3,
    `expected at least the 3 known reserveBudget sites, found ${sites.length} — ` +
      "if the reservation mechanism was renamed or removed, this whole file is now checking nothing",
  );
});

test("no branch returns between reserveBudget and a release", () => {
  // PATH-SENSITIVE, deliberately. The obvious version of this test — walk
  // forward from the reservation and set a `released` flag on the first
  // recordTrade — is worse than useless: the flag is sticky across sibling
  // branches, so the no-route branch's recordTrade masks every leak after it.
  // Written that way it PASSES on the exact code that shipped the Rialto leak.
  //
  // So instead: for each `return;` inside processIntent's reserved region, walk
  // BACKWARD by brace depth to the start of its own enclosing block, and
  // require a release inside that block. `recordTrade({` releases (it calls
  // refreshBudget then releaseBudget), as does an explicit `releaseBudget()`.
  const lines = SRC.split("\n");
  const firstReserve = lines.findIndex((l) => /^\s*reserveBudget\(/.test(l));
  assert.ok(firstReserve > 0, "sanity: found the first reservation by line");
  const endOfFn = lines.findIndex((l, i) => i > firstReserve && /^\s*function heartbeat\(/.test(l));
  assert.ok(endOfFn > firstReserve, "sanity: found the end of processIntent");

  /** The innermost block containing `at`, found by counting braces backwards. */
  const enclosingBlock = (at: number): string => {
    let depth = 0;
    for (let i = at; i >= 0; i--) {
      const l = lines[i]!;
      for (const ch of [...l].reverse()) {
        if (ch === "}") depth++;
        else if (ch === "{") {
          if (depth === 0) return lines.slice(i, at + 1).join("\n");
          depth--;
        }
      }
    }
    return lines.slice(0, at + 1).join("\n");
  };

  let checked = 0;
  for (let i = firstReserve; i < endOfFn; i++) {
    if (!/^\s*return;\s*$/.test(lines[i]!)) continue;
    const block = enclosingBlock(i);
    // A block that takes no reservation of its own and sits under a finally is
    // covered by it; the finally test below pins that separately.
    if (/\bfinally\s*\{/.test(block)) continue;
    checked++;
    assert.ok(
      /\brecordTrade\(\{/.test(block) || /\breleaseBudget\(\)/.test(block),
      `worker/src/index.ts:${i + 1} returns from a branch that neither records a trade nor ` +
        "releases the budget reservation. That leaks an op into inFlightOps for the LIFE OF THE " +
        "ARM — nothing but a re-arm reclaims it, and it compounds once per tick because the same " +
        "intent is re-proposed. Record a row (a 'rejected' row is budget-neutral on both rails and " +
        "is what the ledger is for) or release explicitly.",
    );
  }
  assert.ok(checked > 0, "sanity: the scan actually examined some returns rather than skipping them all");
});

test("the execution try carries a finally, because a return inside it runs neither catch nor recordTrade", () => {
  // The specific structural fact the Rialto leak turned on. The catch already
  // released, but a `return` skips a catch entirely — only a finally survives
  // every exit.
  const tail = SRC.slice(SRC.indexOf("reserveBudget(countsSpend ? notional : 0n)"));
  assert.match(
    tail,
    /\}\s*finally\s*\{[\s\S]{0,1400}releaseBudget\(\)/,
    "the live execution try/catch must end in a finally that releases the reservation",
  );
});

test("the Rialto router-migration skip records a row rather than returning bare", () => {
  // The original leak, pinned by name so it cannot silently come back.
  const idx = SRC.indexOf("Rialto router migrated to");
  assert.ok(idx > 0, "sanity: the router-migration branch still exists");
  const branch = SRC.slice(idx, idx + 2000);
  const ret = branch.indexOf("\n          return;");
  assert.ok(ret > 0, "sanity: the branch still returns");
  assert.match(
    branch.slice(0, ret),
    /recordTrade\(\{[\s\S]*?reject_rule:\s*"router-migrated"/,
    "the skip must write a rejected row before returning — that is what releases the reservation",
  );
});
