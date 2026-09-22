import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { agentNameForSlug, type MerrymenSettings } from "@merrymen/core";
import { wrapSqlite } from "../../../worker/src/db";
import { ledgerHasAgent, nameNewAgent, type FirstNameInputs } from "./first-name";

const SLUG = "7y2kq0m4c1x9h3tb";
const ACCOUNT = "0x00000000000000000000000000000000000000a1";

function inputs(over: Partial<FirstNameInputs> & { stored?: MerrymenSettings | null } = {}) {
  const writes: MerrymenSettings[] = [];
  const stored = "stored" in over ? over.stored : { strategy: "trencher", paperTradingEnabled: true };
  const base: FirstNameInputs = {
    slug: SLUG,
    account: ACCOUNT,
    prior: { accounts: [] },
    settings: {
      get: async () => (stored === null ? null : { ...stored }),
      put: async (s) => {
        writes.push(s);
      },
    },
    ledgerHasAgent: async () => false,
  };
  return { args: { ...base, ...over }, writes };
}

describe("a brand-new agent with no name is given one", () => {
  it("the slug's generated name is written into settings, and nothing else there moves", async () => {
    const { args, writes } = inputs();
    const out = await nameNewAgent(args);
    assert.deepEqual(out, { named: agentNameForSlug(SLUG) });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0], { strategy: "trencher", paperTradingEnabled: true, agentName: agentNameForSlug(SLUG) });
  });

  it("a tenant with no settings at all still gets a name", async () => {
    const { args, writes } = inputs({ stored: null });
    await nameNewAgent(args);
    assert.deepEqual(writes, [{ agentName: agentNameForSlug(SLUG) }]);
  });

  it("an identity minted at sign-in with no accounts yet is still new", async () => {
    // The Privy path creates the identity before any agent exists.
    const { args, writes } = inputs({ prior: { accounts: [] } });
    await nameNewAgent(args);
    assert.equal(writes.length, 1);
    const fresh = inputs({ prior: null });
    await nameNewAgent(fresh.args);
    assert.equal(fresh.writes.length, 1);
  });
});

describe("an agent that already has a name, or might, is never renamed", () => {
  it("a name the owner chose is kept", async () => {
    const { args, writes } = inputs({ stored: { agentName: "Shogun" } });
    assert.deepEqual(await nameNewAgent(args), { skipped: "has-name" });
    assert.deepEqual(writes, []);
  });

  it("a tenant that has held an account before is not new, whatever settings say", async () => {
    // A chat rename lives in the soul, not in settings — so an empty agentName
    // on a re-grant does NOT mean nobody named this agent. Writing here would
    // let the worker's reconcile stamp a generated name over the owner's own.
    const { args, writes } = inputs({ prior: { accounts: ["0x00000000000000000000000000000000000000a0"] } });
    assert.deepEqual(await nameNewAgent(args), { skipped: "not-new" });
    assert.deepEqual(writes, []);
  });

  it("an account the ledger already knows is not new either", async () => {
    // An account from before the identity store has a row, a soul and maybe a
    // name, and no identity record to say so.
    const { args, writes } = inputs({ prior: null, ledgerHasAgent: async () => true });
    assert.deepEqual(await nameNewAgent(args), { skipped: "not-new" });
    assert.deepEqual(writes, []);
  });

  it("anything unread is a reason NOT to write — renaming is the harm, not the absence", async () => {
    for (const [why, over] of [
      ["identity unread", { prior: undefined }],
      ["ledger unread", { ledgerHasAgent: async () => null }],
      ["settings unread", { settings: { get: async () => { throw new Error("store down"); }, put: async () => {} } }],
    ] as const) {
      const { args, writes } = inputs(over as Partial<FirstNameInputs>);
      assert.deepEqual(await nameNewAgent(args), { skipped: "unread" }, why);
      assert.deepEqual(writes, [], why);
    }
  });

  it("no slug, no name — a blank seed would name every such agent the same", async () => {
    const { args, writes } = inputs({ slug: "" });
    assert.deepEqual(await nameNewAgent(args), { skipped: "no-slug" });
    assert.deepEqual(writes, []);
  });
});

describe("whether the ledger already knows an account", () => {
  async function withLedger(sql: string, fn: (run: <T>(f: (db: import("../../../worker/src/db").Db | null) => Promise<T>) => Promise<T>) => Promise<void>) {
    const raw = new DatabaseSync(":memory:");
    const db = wrapSqlite(raw);
    await db.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT); ${sql}`);
    try {
      await fn((f) => f(db));
    } finally {
      raw.close();
    }
  }

  it("finds a row whatever case the address was stored in", async () => {
    await withLedger(`INSERT INTO agents VALUES ('0x00000000000000000000000000000000000000A1','Robin');`, async (run) => {
      assert.equal(await ledgerHasAgent(run, ACCOUNT), true);
      assert.equal(await ledgerHasAgent(run, "0x00000000000000000000000000000000000000b2"), false);
    });
  });

  it("no ledger to read is unknown, not 'no row'", async () => {
    assert.equal(await ledgerHasAgent((f) => f(null), ACCOUNT), null);
    assert.equal(await ledgerHasAgent(async () => { throw new Error("pool down"); }, ACCOUNT), null);
  });
});
