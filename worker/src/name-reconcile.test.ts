import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createNameReconciler, type NameRoster } from "./name-reconcile";
import { ensureSoul, getName, setName } from "./soul";

/**
 * Run against the REAL soul in a throwaway home, not a fake seat: the whole
 * point of the reconcile is that it converges with what setName/getName
 * actually do to a name, and a fake would agree with whatever this file
 * assumed.
 */
let home: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.MERRYMEN_HOME;
  home = mkdtempSync(path.join(os.tmpdir(), "mm-name-reconcile-"));
  process.env.MERRYMEN_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.MERRYMEN_HOME;
  else process.env.MERRYMEN_HOME = prev;
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const identityFile = () => path.join(home, "soul", "IDENTITY.md");

function roster(agentId: string | null = "0xagent") {
  const rows: { id: string; name: string }[] = [];
  const warns: { id: string; message: string }[] = [];
  const logs: string[] = [];
  let resolved = 0;
  const r: NameRoster = {
    agentId: async () => {
      resolved++;
      return agentId;
    },
    setAgentName: async (id, name) => {
      rows.push({ id, name });
    },
    warn: async (id, message) => {
      warns.push({ id, message });
    },
    log: (line) => logs.push(line),
  };
  return { r, rows, warns, logs, resolvedCount: () => resolved };
}

const reconciler = () => createNameReconciler({ ensureSoul, getName, setName });

describe("the configured name reaches the soul and the roster", () => {
  it("a new name is written to the soul and mirrored onto the agent's row", async () => {
    const reconcile = reconciler();
    const { r, rows } = roster();
    assert.equal(await reconcile("Amber Heron", r), "renamed");
    assert.equal(getName(), "Amber Heron");
    assert.deepEqual(rows, [{ id: "0xagent", name: "Amber Heron" }]);
  });

  it("converges: the next tick with the same name writes nothing and resolves no agent", async () => {
    // Guarded on a real difference, so a normal tick costs one file read. The
    // agent id is resolved lazily because resolving it is an upsert.
    const reconcile = reconciler();
    await reconcile("Amber Heron", roster().r);
    const before = statSync(identityFile()).mtimeMs;
    const second = roster();
    assert.equal(await reconcile("Amber Heron", second.r), "unchanged");
    assert.equal(second.resolvedCount(), 0);
    assert.deepEqual(second.rows, []);
    assert.equal(statSync(identityFile()).mtimeMs, before);
  });

  it("compares in the soul's own shape, so spacing or composition never rewrites every tick", async () => {
    // The soul stores NFC with whitespace collapsed. Comparing the raw
    // configured value would make `want !== getName()` true forever for
    // "Little  John" or a decomposed "José" — an identity-file rewrite every
    // tick that logs nothing because setName says ok.
    const reconcile = reconciler();
    await reconcile("José", roster().r);
    const decomposed = "José";
    const spaced = roster();
    assert.equal(await reconcile(`  ${decomposed}  `, spaced.r), "unchanged");
    assert.deepEqual(spaced.rows, []);
    await reconcile("Little John", roster().r);
    const collapsed = roster();
    assert.equal(await reconcile("Little   John", collapsed.r), "unchanged");
    assert.deepEqual(collapsed.rows, []);
  });

  it("nothing configured leaves the soul's own name alone", async () => {
    // A chat rename lives in the soul; an empty setting must not stamp over it.
    const reconcile = reconciler();
    setName("Shogun");
    for (const configured of [undefined, "", "   "]) {
      const { r, rows } = roster();
      assert.equal(await reconcile(configured, r), "unchanged");
      assert.deepEqual(rows, []);
    }
    assert.equal(getName(), "Shogun");
  });

  it("with no agent to key the row on, the soul still takes the name", async () => {
    // A killed agent has no grant and no armed handle. The soul is what chat
    // answers with, so it moves anyway; the row follows at the next arm.
    const reconcile = reconciler();
    const { r, rows } = roster(null);
    assert.equal(await reconcile("Quiet Wren", r), "renamed");
    assert.equal(getName(), "Quiet Wren");
    assert.deepEqual(rows, []);
  });
});

describe("a name the soul refuses is never a silent refusal", () => {
  it("the owner is told what was refused, why, and what the agent is still called", async () => {
    const reconcile = reconciler();
    await reconcile("Amber Heron", roster().r);
    const { r, warns, rows } = roster();
    assert.equal(await reconcile("007", r), "refused");
    assert.equal(getName(), "Amber Heron", "the soul keeps its last good name");
    assert.deepEqual(rows, []);
    assert.equal(warns.length, 1);
    assert.equal(warns[0]!.id, "0xagent");
    assert.match(warns[0]!.message, /"007"/);
    assert.match(warns[0]!.message, /at least one letter/);
    assert.match(warns[0]!.message, /Amber Heron/);
  });

  it("said once per refused value, not once per tick", async () => {
    // The reconcile runs every tick. An undeduped warn would bury the owner's
    // event feed in one sentence, which is its own way of hiding everything
    // else the wall said.
    const reconcile = reconciler();
    const first = roster();
    await reconcile("007", first.r);
    for (let i = 0; i < 5; i++) {
      const again = roster();
      assert.equal(await reconcile("007", again.r), "refused");
      assert.deepEqual(again.warns, []);
      assert.deepEqual(again.logs, []);
      assert.equal(again.resolvedCount(), 0, "a repeat does not even upsert the agent row");
    }
    assert.equal(first.warns.length, 1);
    // A DIFFERENT bad value is a different refusal and is said again.
    const other = roster();
    await reconcile("2024", other.r);
    assert.equal(other.warns.length, 1);
  });

  it("a refusal before there was an agent to tell is told once there is one", async () => {
    const reconcile = reconciler();
    const nobody = roster(null);
    await reconcile("007", nobody.r);
    assert.deepEqual(nobody.warns, []);
    assert.equal(nobody.logs.length, 1, "the operator log still has it");
    const armed = roster("0xnew");
    await reconcile("007", armed.r);
    assert.equal(armed.warns.length, 1);
    assert.equal(armed.warns[0]!.id, "0xnew");
  });

  it("fixing the name and then breaking it again announces the new refusal", async () => {
    const reconcile = reconciler();
    await reconcile("007", roster().r);
    await reconcile("Bold Otter", roster().r);
    const again = roster();
    await reconcile("007", again.r);
    assert.equal(again.warns.length, 1);
  });

  it("going back to the current name and then to the bad one again is told again", async () => {
    // Setting the name the agent already has converges without a write; the
    // refusal memory must still clear there, or the second "007" is silent.
    const reconcile = reconciler();
    await reconcile("Amber Heron", roster().r);
    await reconcile("007", roster().r);
    assert.equal(await reconcile("Amber Heron", roster().r), "unchanged");
    const again = roster();
    await reconcile("007", again.r);
    assert.equal(again.warns.length, 1);
  });

  it("the identity file is untouched by a refusal", async () => {
    const reconcile = reconciler();
    await reconcile("Amber Heron", roster().r);
    const before = readFileSync(identityFile(), "utf8");
    await reconcile("99.5", roster().r);
    assert.equal(readFileSync(identityFile(), "utf8"), before);
  });
});
