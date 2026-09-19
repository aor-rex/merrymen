import assert from "node:assert/strict";
import { test } from "node:test";
import { loadLive } from "./live";

test("the client retains unlinked and paper board entries instead of silently filtering them", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => new Response(JSON.stringify(String(input).includes("/api/leaderboard") ? {
    source: "sqlite", agents: [
      {slug: "paper-agent", name: "Paper", mode: "paper", filledPaper: 4, landed: 0, pnlBps: null, unrankedWhy: "paper"},
      {slug: null, name: "Unlinked", mode: "idle", landed: 0, pnlBps: null, unrankedWhy: "inactive"},
    ],
  } : {tokens: [], theses: [], rows: []}), {status: 200});
  try {
    const live = await loadLive();
    assert.equal(live.agents.length, 2);
    assert.equal(live.agents[0].filledPaper, 4);
    assert.equal(live.agents[0].mode, "paper");
    assert.equal(live.agents[1].profileAvailable, false);
    assert.equal(live.agents[1].name, "Unlinked");
  } finally { globalThis.fetch = original; }
});
