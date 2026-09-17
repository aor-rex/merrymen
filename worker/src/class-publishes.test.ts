/**
 * THE CLASS ROUTE CAN BE READ IN PUBLIC.
 *
 * WHAT THIS IS A REGRESSION TEST FOR. `class-route` was not a key in
 * SOURCE_POLICY, and `publishableThesis` fails closed on an unknown source — so
 * every class-vault entry and exit published NOTHING. Two agents completed full
 * autonomous buy-and-sell round trips of a launch, and their own feeds, every
 * peer file and the desk's `read_peers` tool never mentioned it. The flagship
 * capability was the one thing the product never talked about.
 *
 * Nothing about that failure was visible from the class route: it traded
 * correctly, wrote its rows, and the silence lived in a map in another module.
 * Which is why the assertions below are about the PUBLISHED SHAPE rather than
 * about the presence of a key.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUBLISHABLE_SOURCES, publishableThesis, type ThesisRow } from "./thesis-policy";
import { renderWhy, type Why } from "./strategies/reasons";

const row = (over: Partial<ThesisRow> = {}): ThesisRow => ({
  name: "Shogun",
  slug: "0123456789abcdef",
  source: "class-route",
  action: "buy",
  symbol: "MOON",
  size_usdg: 5,
  reason: "taking 5.00 USDG of MOON — 20 different buyers have been through it",
  status: "landed",
  said: 1,
  last_at: 1_700_000_000,
  first_at: 1_700_000_000,
  mode: "live",
  ...over,
});

describe("a class trade reaches the feed at all", () => {
  it("publishes, where before it produced nothing", () => {
    const t = publishableThesis(row());
    assert.ok(t !== null, "a class decision must not be dropped by the publication gate");
    assert.equal(t.symbol, "MOON");
    assert.equal(t.action, "buy");
    assert.equal(t.sizeUsdg, 5);
  });

  it("carries the ticker into the head, not a bare figure", () => {
    // `symbolOfToken` searches watchTokens and STOCK_TOKENS; a launch token is
    // in neither by definition, so these rows used to carry symbol NULL and
    // `headOf` rendered "buy 5.00 USDG" — a post about nothing in particular,
    // and invisible to every symbol-keyed surface in the product.
    const t = publishableThesis(row())!;
    assert.match(t.head, /MOON/, "the head must name the token");
  });

  it("is reachable by the SQL both readers narrow on", () => {
    // The gate and the queries are separate mechanisms and both have to admit
    // it. PUBLISHABLE_SOURCES is derived from the policy for exactly this
    // reason, and this asserts the derivation actually reaches the new key.
    assert.ok(
      PUBLISHABLE_SOURCES.includes("class-route"),
      "read-theses and peer-theses both narrow on this list",
    );
  });

  it("publishes an exit as a sell", () => {
    const t = publishableThesis(row({ action: "sell", reason: "out of MOON with 3.60 USDG — 6h is as long as I hold one of these" }))!;
    assert.equal(t.action, "sell");
    assert.match(t.head, /sell/);
  });
});

describe("what the class route still may not say", () => {
  it("drops a row whose reason carries an address", () => {
    // The backstop applies here exactly as everywhere else. A class token's
    // symbol comes from an ERC-20 the launcher controls, and discovery falls
    // back to a truncated ADDRESS when the symbol read fails — so this is a
    // reachable state on this route specifically, not a hypothetical.
    const t = publishableThesis(row({ reason: "taking 5.00 USDG of 0x1234abcd… — it looks early" }));
    assert.equal(t, null, "an address in the prose must drop the whole post");
  });

  it("drops a row whose SYMBOL is an address", () => {
    const t = publishableThesis(row({ symbol: "0x1234abcd…" }));
    assert.equal(t, null);
  });

  it("is not a shadow source — a class trade really happened", () => {
    // Brain's posts say "would buy" because Brain cannot spend. A class trade
    // moved real money, and rendering it in the conditional would understate
    // what the agent did.
    const t = publishableThesis(row())!;
    assert.equal(t.shadow, false);
  });
});

/**
 * PROVENANCE. The owner's rule is that a deterministic decision must never be
 * dressed as a model's opinion, and this is the half of it that can be asserted
 * without a database: the words themselves are ours.
 */
describe("the prose on a class post is written by us", () => {
  const cases: Why[] = [
    {
      code: "class-enter",
      symbol: "MOON",
      usdgRaw: 5_000_000n,
      trades: 60,
      traders: 20,
      depthRaw: 400_000_000n,
      impactBps: 40,
      costBps: 120,
      graduationBps: 2000,
      field: 4,
    },
    {
      code: "class-exit",
      symbol: "MOON",
      cause: "clock",
      heldSec: 21_600,
      graduationBps: 4100,
      proceedsRaw: 3_600_000n,
    },
    {
      code: "class-exit",
      symbol: "MOON",
      cause: "cliff",
      heldSec: 900,
      graduationBps: 8600,
      proceedsRaw: 3_600_000n,
    },
  ];

  it("renders every class Why through renderWhy, under the published cap", () => {
    for (const w of cases) {
      const s = renderWhy(w);
      assert.ok(s.length > 0 && s.length <= 220, `"${s}" must fit the published cap`);
      assert.ok(!/\bI think\b|\bshould\b|\bwill\b/.test(s), `"${s}" must not predict`);
    }
  });

  it("says nothing about buyers when the tape was unreadable", () => {
    // THE SENTENCE-LEVEL HALF OF THE NULL RULE. The evidence layer drops the
    // band; this asserts the prose drops the clause, because a reader cannot
    // see a missing key but can certainly read an invented claim.
    const s = renderWhy({
      code: "class-enter",
      symbol: "MOON",
      usdgRaw: 5_000_000n,
      trades: null,
      traders: null,
      depthRaw: 400_000_000n,
      impactBps: 40,
      costBps: null,
      graduationBps: 2000,
      field: 1,
    });
    assert.ok(!/buyers|trades/.test(s), `"${s}" must not describe a tape we could not read`);
  });

  it("explains the cliff, because a contract revert is not a price target", () => {
    const s = renderWhy(cases[2]!);
    assert.match(s, /graduat/i, "the cliff post must say why it is leaving now");
  });

  it("distinguishes the two exits in the words, not just in the data", () => {
    assert.notEqual(renderWhy(cases[1]!), renderWhy(cases[2]!));
  });
});
