/**
 * THE PRICE A CALL WAS MADE AT REACHES THE FEED, OR THE CALL STILL DOES.
 *
 * `mark_usd` and `mcap_usd` are written with the decision row, at decision
 * time, in the same INSERT — which is the only kind of column this block may
 * carry (see the ON CONFLICT note in ledger-mirror.ts: a decision reaches the
 * shared ledger once, exactly as first written).
 *
 * The other half is the ledger that does not have them yet. The mirror reads a
 * child's sqlite READ-ONLY, so it cannot migrate one; a child ledger opened
 * before its own worker has run the ALTER would fail a SELECT that names the
 * new columns, and the decisions copy would stall — silently, since a stalled
 * table and an idle one print the same line. So the new columns are read when
 * they are there and the row is copied without them when they are not.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { wrapSqlite } from "./db";
import { MIRROR_STATE_DDL, mirrorTenant } from "./ledger-mirror";

const DECISIONS = (marks: boolean) =>
  `CREATE TABLE decisions (id TEXT PRIMARY KEY, agent_id TEXT, source TEXT, strategy TEXT, provider TEXT, model TEXT,
     symbol TEXT, action TEXT, size_usdg REAL, reason TEXT, dropped_rule TEXT, signals_json TEXT, hold_kind TEXT,
     evidence_json TEXT, provenance TEXT, display_name TEXT, ${marks ? "mark_usd REAL, mcap_usd REAL," : ""} at INTEGER);`;

function child(marks: boolean) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DECISIONS(marks));
  if (marks) {
    raw.exec(`INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, display_name, mark_usd, mcap_usd, at)
              VALUES ('d1', '0xagent', 'brain', 'T3139F043B88', 'buy', 5, 'flow turned', 'JUGGERNAUT', 0.00042, 3100000, 9)`);
  } else {
    raw.exec(`INSERT INTO decisions (id, agent_id, source, symbol, action, size_usdg, reason, display_name, at)
              VALUES ('d1', '0xagent', 'brain', 'T3139F043B88', 'buy', 5, 'flow turned', 'JUGGERNAUT', 9)`);
  }
  return wrapSqlite(raw);
}

function shared() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DECISIONS(true) + MIRROR_STATE_DDL);
  return wrapSqlite(raw);
}

describe("a decision's mark rides the mirror", () => {
  it("COPIES mark_usd AND mcap_usd with the row they were written in", async () => {
    const dest = shared();
    const r = await mirrorTenant({ tenant: "0xten", child: child(true), shared: dest });
    assert.equal(r.copied.decisions, 1);
    assert.equal(r.failed?.decisions, undefined);
    const got = (await dest.prepare("SELECT mark_usd, mcap_usd, display_name FROM decisions WHERE id = 'd1'").get()) as Record<string, unknown>;
    assert.equal(got.mark_usd, 0.00042);
    assert.equal(got.mcap_usd, 3100000);
    assert.equal(got.display_name, "JUGGERNAUT");
  });

  it("A CHILD LEDGER WITHOUT THE COLUMNS STILL COPIES ITS DECISIONS — with no mark, never a stall", async () => {
    const dest = shared();
    const r = await mirrorTenant({ tenant: "0xten", child: child(false), shared: dest });
    assert.equal(r.failed?.decisions, undefined, `the copy failed: ${r.failed?.decisions}`);
    assert.equal(r.copied.decisions, 1);
    const got = (await dest.prepare("SELECT mark_usd, mcap_usd, display_name FROM decisions WHERE id = 'd1'").get()) as Record<string, unknown>;
    assert.equal(got.mark_usd, null, "absent, not zero");
    assert.equal(got.mcap_usd, null);
    assert.equal(got.display_name, "JUGGERNAUT", "and everything else it had still arrives");
  });
});
