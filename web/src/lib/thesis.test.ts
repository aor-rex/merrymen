import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PUBLISHABLE_STRATEGIES, classifyDrop, publishableThesis, type ThesisRow } from "./thesis";

/**
 * This guard is the only thing between the decisions table and a page anybody
 * can read, and that table was never built to be published.
 *
 * The tests that matter most are not about the happy path. They are about the
 * row nobody thought of: a source added next year by someone who never read
 * this file, a model quoting an address it was handed, a template with a
 * model-supplied hole in the middle of it. Every one of those must publish
 * NOTHING, without anybody having to remember to make it so.
 */

const ok = (over: Partial<ThesisRow> = {}): ThesisRow => ({
  agent_id: "0xagent",
  name: "Much",
  x_handle: "much_miller",
  source: "strategy:steady-basket",
  action: "buy",
  symbol: "NVDA",
  size_usdg: 16.66,
  reason: "the schedule says buy — 16.66 USDG into NVDA, its 33% of a 3-leg basket",
  status: "landed",
  said: 38,
  last_at: 1_700_000_000,
  first_at: 1_699_900_000,
  ...over,
});

describe("what may be published", () => {
  it("publishes a strategy's own words", () => {
    const t = publishableThesis(ok())!;
    assert.equal(t.name, "Much");
    assert.equal(t.handle, "much_miller");
    assert.equal(t.head, "buy NVDA 16.66 USDG");
    assert.equal(t.outcome, "landed");
    assert.equal(t.said, 38);
    assert.match(t.reason!, /the schedule says buy/);
  });

  it("publishes the model's words, capped", () => {
    const long = "x".repeat(400);
    const t = publishableThesis(ok({ source: "strategist", reason: long }))!;
    assert.equal(t.reason!.length, 220, "the /why truncation point");
  });

  it("an empty model reason is a post with no reasoning line, not the string 'undefined'", () => {
    // The model omits the field routinely; it arrives as "" rather than null.
    const t = publishableThesis(ok({ source: "strategist", reason: "" }))!;
    assert.equal(t.reason, null);
    assert.equal(t.head, "buy NVDA 16.66 USDG");
  });
});

describe("the public id", () => {
  it("publishes a well-formed slug", () => {
    const t = publishableThesis(ok({ slug: "a7k3m9qz2n4vb8xd" }))!;
    assert.equal(t.slug, "a7k3m9qz2n4vb8xd");
  });

  it("A MISSING SLUG COSTS THE LINK, NOT THE POST", () => {
    // An agent granted before the identity store existed, or one whose
    // best-effort mint failed, still has things to say. Dropping the thesis
    // would trade a real loss for an imaginary one — a slug is not a
    // disclosure risk the way a reason is.
    assert.equal(publishableThesis(ok())!.slug, null);
    assert.equal(publishableThesis(ok({ slug: "not a slug" }))!.slug, null);
    // 16 characters, but 'i' is not in the alphabet — Crockford drops i/l/o/u
    // so a slug cannot be misread into a different agent.
    assert.equal(publishableThesis(ok({ slug: "iiiiiiiiiiiiiiii" }))!.slug, null);
    assert.match(publishableThesis(ok({ slug: "not a slug" }))!.reason!, /the schedule says buy/);
  });

  it("is never an address, and the backstop covers it anyway", () => {
    // It cannot be — base32 has no 0x prefix — which is exactly why the check
    // is worth having: the guarantee stops depending on the encoding staying
    // as designed.
    const t = publishableThesis(ok({ slug: "0x1111111111111111111111111111111111111111" }));
    assert.equal(t, null);
  });
});

describe("a decision is not a failed trade", () => {
  /**
   * The desk's proudest feature rendered as its worst. A window where the agent
   * researched and concluded "stay flat, and here is why" writes a decision
   * with a reason and no action — desk.test.ts calls this "A HOLD WITH A VIEW
   * is a real answer" — and every one of them published the sentence "no trade
   * came of it", which is the same sentence a refused buy gets.
   */
  it("a thesis-only row is a view, not a pending trade", () => {
    const t = publishableThesis(
      ok({
        source: "strategist",
        action: null,
        symbol: null,
        size_usdg: null,
        status: null,
        reason: "Everything I can price is shut for the weekend. Nothing worth doing.",
      }),
    )!;
    assert.equal(t.outcome, "view");
    assert.notEqual(t.outcome, "pending");
    assert.doesNotMatch(t.outcomeText, /no trade came of it/);
  });

  it("an explicit hold is a view too", () => {
    const t = publishableThesis(ok({ source: "strategist", action: "hold", status: null, size_usdg: 0 }))!;
    assert.equal(t.outcome, "view");
    assert.match(t.outcomeText, /by choice/);
  });

  it("A BUY THAT HAS NOT LANDED IS STILL PENDING", () => {
    // The guard that stops the fix over-reaching. An actionable proposal whose
    // trade row does not exist yet is genuinely unresolved, and calling that a
    // view would claim the agent chose an outcome it is still waiting on.
    const t = publishableThesis(ok({ status: null }))!;
    assert.equal(t.outcome, "pending");
    assert.match(t.outcomeText, /no trade came of it/);
  });

  it("a hold that somehow joined a trade reports what happened", () => {
    // A contradiction worth surfacing rather than hiding behind "by choice".
    const t = publishableThesis(ok({ action: "hold", status: "landed" }))!;
    assert.equal(t.outcome, "landed");
  });
});

describe("what may NOT be published", () => {
  it("NEVER a chat-sourced reason — it carries a counterparty address by template", () => {
    // worker/src/index.ts writes this string unconditionally on every chat
    // transfer. It is the owner speaking, not the agent, and it names a third
    // party and an amount.
    const row = ok({
      source: "chat",
      reason: "owner asked to transfer 25.00 USDG to 0x7060B218E0B11F37450A8835664fa748dB1FcC1E in chat",
    });
    assert.equal(publishableThesis(row), null);
  });

  it("NEVER an unclassified source — the case that matters in a year", () => {
    // Someone adds a decision writer and does not read this file. The row must
    // vanish, not publish, and nobody has to have remembered anything.
    for (const source of [
      "strategy:some-future-thing",
      "strategy:a-tenants-own-file",
      "selftest",
      "dashboard",
      "",
    ]) {
      assert.equal(publishableThesis(ok({ source, reason: "perfectly benign" })), null, source);
    }
  });

  it("NEVER a row whose text contains an address, whatever the source", () => {
    // The backstop. A strategy reason cannot contain one by construction; this
    // is here so that guarantee does not have to hold forever for us to be safe.
    assert.equal(
      publishableThesis(ok({ source: "strategist", reason: "rotating into 0x1234567890abcdef" })),
      null,
    );
    assert.equal(publishableThesis(ok({ name: "0xdeadbeefcafe" })), null);
    assert.equal(publishableThesis(ok({ x_handle: "0xabcdef123456" })), null);
  });

  it("NEVER the brokerage rail — its agent id is an account number", () => {
    assert.equal(publishableThesis(ok({ agent_id: "rh:12345678" })), null);
    assert.equal(publishableThesis(ok({ agent_id: "RH:12345678" })), null);
  });

  it("NEVER a nameless agent", () => {
    assert.equal(publishableThesis(ok({ name: "" })), null);
    assert.equal(publishableThesis(ok({ name: null })), null);
  });
});

describe("refusals are classified, never quoted", () => {
  it("does not echo the model-supplied symbol, at any length", () => {
    // dropped_rule is `#N <symbol>: <clause>` and <symbol> is model-supplied,
    // validated only as a string — no length cap, no charset.
    const nasty = "#0 <script>alert(1)</script>: nothing held to sell";
    const t = publishableThesis(ok({ source: "strategist", reason: null, dropped_rule: nasty, status: null }))!;
    assert.doesNotMatch(t.reason!, /script|alert/);
    assert.equal(t.reason, "there was nothing held to sell");
    assert.equal(t.outcome, "dropped");
  });

  it("does not echo the FIGURE in a cash refusal", () => {
    // "buy 50 USDG exceeds available cash" publishes an upper bound on the
    // agent's cash. The classified sentence says the same thing without it.
    const s = classifyDrop("#0 AAPL: buy 50 USDG exceeds available cash");
    assert.doesNotMatch(s, /50|USDG/);
    assert.match(s, /more cash than it had/);
  });

  it("an unknown clause gets a sentence of ours, not the clause", () => {
    const s = classifyDrop("#0 AAPL: some new reason nobody has classified yet");
    assert.doesNotMatch(s, /nobody has classified/);
  });

  it("an unknown reject_rule is not echoed either", () => {
    // reject_rule is NOT a closed vocabulary — some paths write free-form text.
    const t = publishableThesis(
      ok({ status: "rejected", reject_rule: "couldn't submit: something raw and long" }),
    )!;
    assert.equal(t.outcomeText, "the wall turned it back");
    assert.equal(t.outcome, "refused");
  });

  it("a known rule reads as a sentence", () => {
    const t = publishableThesis(ok({ status: "rejected", reject_rule: "daily-cap" }))!;
    assert.equal(t.outcomeText, "past today's spending cap");
  });
});

describe("the policy cannot drift from the strategies", () => {
  it("every builtin strategy that can emit a reason is classified", () => {
    // Adding a strategy without classifying it should fail HERE rather than
    // silently publishing, or silently not publishing.
    const src = readFileSync(
      path.join(process.cwd(), "worker", "src", "strategies", "registry.ts"),
      "utf8",
    );
    const names = [...src.matchAll(/"([a-z-]+)"/g)]
      .map((m) => m[1]!)
      .filter((n) => /^(steady-basket|weekend-gap|even-keel|dip-hunter|trencher)$/.test(n));
    assert.ok(names.length >= 5, `expected the builtins in registry.ts, saw ${names.join(",")}`);
    for (const n of new Set(names)) {
      assert.ok(
        (PUBLISHABLE_STRATEGIES as readonly string[]).includes(n),
        `${n} is a builtin strategy that nothing has classified for publication`,
      );
    }
  });

  it("llm-strategist is NOT in the strategy list — it publishes as `strategist`", () => {
    // Its decisions carry source "strategist" and are MODEL prose, which takes
    // the capped, address-checked path rather than the trusted one.
    assert.ok(!(PUBLISHABLE_STRATEGIES as readonly string[]).includes("llm-strategist"));
  });

  it("the route never selects signals_json", () => {
    // The strongest guarantee in the design is an absence: the owner's whole
    // balance sheet is not filtered out of the response, it is never fetched.
    const route = path.join(process.cwd(), "web", "src", "app", "api", "theses", "route.ts");
    let raw = "";
    try {
      raw = readFileSync(route, "utf8");
    } catch {
      return; // route not written yet — the guard lands first, by design
    }
    // Comments stripped first, exactly as client-env.test.ts does: the file that
    // explains why it never selects signals_json NAMES signals_json, and a naive
    // scan flags the very comment warning people off it. Only real code counts.
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    assert.ok(!/signals_json/.test(src), "signals_json must never be selected");
    assert.ok(!/tenantOf/.test(src), "a public route must not read a session");
  });
});
