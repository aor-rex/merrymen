/**
 * EXECUTION IS DISCONNECTED BY ABSENCE, and this is what checks it.
 *
 * The shadow path's guarantee is not a flag someone can flip — it is that these
 * modules do not import or call the execution machinery at all. Connecting
 * execution later has to ADD an import, which shows up in a diff and needs a
 * reason given.
 *
 * COMMENTS ARE STRIPPED FIRST. The modules describe what they will not do, in
 * prose, using the names of the things they will not do — and the first version
 * of this check failed on its own documentation. What is under review is code.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const SHADOW_MODULES = ["brain-shadow", "brain-client", "brain-trigger", "brain-enabled"];

const FORBIDDEN_IMPORTS = ["./proposals", "./policy", "./executor", "./simulate", "./wall", "./intents"];
const FORBIDDEN_CALLS = [
  "proposalsToIntents",
  "checkPolicy",
  "simulateSwap",
  "sendUserOp",
  "buildCalldata",
  "executeIntent",
];

/** Source with comments removed, so prose about execution is not read as execution. */
function codeOnly(mod: string): string {
  const raw = readFileSync(new URL("./" + mod + ".ts", import.meta.url), "utf8");
  return raw.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

describe("the shadow path cannot reach execution", () => {
  for (const mod of SHADOW_MODULES) {
    it(mod + " imports nothing that can move money", () => {
      const code = codeOnly(mod);
      const modules = [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const bad of FORBIDDEN_IMPORTS) {
        const hit = modules.find((m) => m === bad || m.endsWith(bad.slice(1)));
        assert.equal(hit, undefined, mod + " imports " + bad + " — the shadow path must not reach execution");
      }
    });

    it(mod + " calls no execution function", () => {
      const code = codeOnly(mod);
      for (const fn of FORBIDDEN_CALLS) {
        assert.doesNotMatch(code, new RegExp("\\b" + fn + "\\s*\\("), mod + " calls " + fn);
      }
    });
  }

  it("the tick guards the shadow path and defaults to nobody", () => {
    const raw = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    assert.match(
      raw,
      /if \(shadowBrainEnabledFor\(agentId\) && cfg\.brainUrl && cfg\.brainToken/,
      "three guards: the agent is named AND the house configured a Brain",
    );
  });

  it("the tick does nothing with the outcome but log it", () => {
    // The decision is persisted inside runShadow and dropped here. If a future
    // edit routes `outcome` onward, this is the line that notices.
    const raw = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const from = raw.indexOf("const outcome = await runShadow(");
    assert.ok(from > 0, "the tick still calls runShadow");
    const block = raw.slice(from, from + 700).replace(/\/\/[^\n]*/g, " ");
    for (const fn of FORBIDDEN_CALLS) {
      assert.doesNotMatch(block, new RegExp("\\b" + fn + "\\b"), "the outcome reaches " + fn);
    }
  });
});

/**
 * ONE LEDGER TABLE, TWO REASONERS, AND ONLY ONE OF THEM MAY CLAIM A ROW.
 *
 * Brain writes shadow decisions into `decisions` under the SAME `agent_id` the
 * strategist uses. The desk's `recall` tool tells the strategist it is looking
 * at "what you proposed, what the wall did with it" — so an unfiltered read
 * hands one reasoner the other's thinking as its own history.
 *
 * On the canary, where both are enabled, that produced:
 *
 *     - buy TSLA 5 USDG: no trade came of it — you said: <Brain's thesis>
 *
 * Three lies in one line: the strategist proposed nothing; "no trade came of
 * it" says something tried and failed rather than that nothing was ever wired
 * to try; and the strategist could then publish a `strategist`-sourced thesis
 * about a buy it believed it had made — which passes the publication gate with
 * no shadow marking at all, because by then the row genuinely is a strategist
 * row. That is a laundering path, not a rendering bug.
 */
describe("one reasoner never inherits another's decisions", () => {
  it("recall excludes every shadow source", () => {
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const i = src.indexOf("recall: async () =>");
    assert.ok(i > 0, "the recall tool must still exist for this test to mean anything");
    const body = src.slice(i, i + 1400);
    assert.match(body, /recentDecisions\([^)]*SHADOW_SOURCES\)/, "recall must filter shadow sources out");
  });

  it("the store can actually exclude them, and does not when asked not to", () => {
    // The filter has to be real SQL, not a comment. Checked on the source
    // because exercising it needs a database.
    const store = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const i = store.indexOf("export async function recentDecisions");
    const body = store.slice(i, i + 1800);
    assert.match(body, /excludeSources/, "the parameter exists");
    assert.match(body, /d\.source NOT IN/, "and reaches the WHERE clause");
    assert.match(body, /excludeSources\.length \?/, "and is skipped entirely when nothing is excluded");
  });
});
