import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyVerdicts, nullScout, toScoutCandidates } from "./memecoin-scout";
import { emptyGeckoBuckets, type GeckoPool } from "../venues/geckoterminal";

/**
 * The scout's contract is a SUBSET, guaranteed against the model rather than
 * requested of it. Most of what follows is that one property attacked from
 * different directions: a model that hallucinates, repeats itself, returns
 * prose, or is outright adversarial must still be unable to put a token in
 * front of the agent that the deterministic screen did not already admit.
 */

const NOW = 1_756_000_000;
const pool = (name: string, over: Partial<GeckoPool> = {}): GeckoPool => ({
  poolId: `0x${name.length.toString(16).padStart(40, "0")}`,
  poolAddress: null,
  tokenAddress: `0x${"a".repeat(40)}`,
  name,
  dex: "pons-v2-dex",
  priceUsd: 0.01,
  reserveUsd: 100_000,
  fdvUsd: 1_000_000,
  volume24hUsd: 500_000,
  change24hPct: 12,
  change1hPct: 1,
  buys24h: 900,
  sells24h: 700,
  buyers24h: 300,
  buckets: emptyGeckoBuckets(),
  createdAt: NOW - 86_400 * 3,
  ...over,
});
const POOLS = [pool("AAA / WETH"), pool("BBB / WETH"), pool("CCC / WETH")];

describe("toScoutCandidates", () => {
  it("shows the model NO address to hallucinate with", () => {
    // The strongest guarantee in this module is the one made by omission: a
    // prompt with no address in it cannot produce a wrong address.
    const text = JSON.stringify(toScoutCandidates(POOLS, NOW));
    assert.ok(!/0x[0-9a-f]{40}/i.test(text), "an address leaked into the prompt");
    assert.ok(!text.includes("tokenAddress") && !text.includes("poolId"));
  });

  it("indexes candidates by position so answers map back exactly", () => {
    const c = toScoutCandidates(POOLS, NOW);
    assert.deepEqual(c.map((x) => x.index), [0, 1, 2]);
    assert.equal(c[1]!.label, "BBB / WETH");
  });

  it("converts age to days the model can reason about", () => {
    assert.equal(toScoutCandidates(POOLS, NOW)[0]!.ageDays, 3);
    assert.equal(toScoutCandidates([pool("X", { createdAt: null })], NOW)[0]!.ageDays, null);
  });

  it("passes UNKNOWN through as null, never as zero", () => {
    // The prompt tells the model null means unknown. That is only true if the
    // projection keeps it null — a 0 here would read as "no volume at all",
    // which is a much stronger claim than "not indexed yet".
    const c = toScoutCandidates([pool("NEW", { volume24hUsd: null, buyers24h: null, fdvUsd: null })], NOW);
    assert.equal(c[0]!.volume24hUsd, null);
    assert.equal(c[0]!.distinctBuyers24h, null);
    assert.notEqual(c[0]!.volume24hUsd, 0);
  });
});

describe("applyVerdicts — cannot widen the set", () => {
  it("returns the pools the model chose", () => {
    const r = applyVerdicts(POOLS, { keep: [{ index: 2, conviction: 4, reason: "deep" }] });
    assert.equal(r.picks.length, 1);
    assert.equal(r.picks[0]!.pool.name, "CCC / WETH");
    assert.equal(r.picks[0]!.conviction, 4);
    assert.equal(r.passed.length, 2);
  });

  it("DROPS an index that refers to nothing, rather than clamping it", () => {
    // Clamping 99 to 2 would hand the agent a token the model never chose. The
    // failure must not be repaired into a different, confident answer.
    const r = applyVerdicts(POOLS, { keep: [{ index: 99, conviction: 5 }, { index: -1, conviction: 5 }] });
    assert.equal(r.picks.length, 0);
    assert.equal(r.ignored.length, 2, "and it is reported, not swallowed");
  });

  it("cannot be made to emit a token that was never offered", () => {
    // The adversarial case: a model (or an injection through a token name)
    // trying to name its own target. There is no field through which to do it.
    const r = applyVerdicts(POOLS, {
      keep: [
        { index: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", conviction: 5 },
        { index: 0.5, conviction: 5 },
        { index: null, conviction: 5 },
        { token: "0xbad", conviction: 5 },
      ],
    });
    assert.equal(r.picks.length, 0);
    for (const p of r.picks) assert.ok(POOLS.includes(p.pool));
  });

  it("counts a repeated index once", () => {
    const r = applyVerdicts(POOLS, { keep: [{ index: 1, conviction: 5 }, { index: 1, conviction: 2 }] });
    assert.equal(r.picks.length, 1);
    assert.equal(r.picks[0]!.conviction, 5, "the first answer stands");
  });

  it("survives garbage where a list was expected", () => {
    for (const junk of [null, undefined, {}, { keep: "yes" }, { keep: null }, "prose", 42]) {
      const r = applyVerdicts(POOLS, junk);
      assert.equal(r.picks.length, 0, `${JSON.stringify(junk)} produced picks`);
      assert.equal(r.passed.length, 3);
    }
  });

  it("every pick is a pool from the input, under any answer", () => {
    const answers: unknown[] = [
      { keep: [{ index: 0 }, { index: 1 }, { index: 2 }] },
      { keep: [{ index: 3 }] },
      { keep: Array.from({ length: 50 }, (_, i) => ({ index: i })) },
    ];
    for (const a of answers) {
      const r = applyVerdicts(POOLS, a);
      assert.ok(r.picks.length <= POOLS.length);
      for (const p of r.picks) assert.ok(POOLS.includes(p.pool), "a pick escaped the input set");
      assert.equal(r.picks.length + r.passed.length, POOLS.length, "picks and passed must partition the input");
    }
  });

  it("clamps conviction but never lets it select anything", () => {
    // Unlike an index, conviction names no token — a nonsense value is safe to
    // repair into range rather than discard.
    const r = applyVerdicts(POOLS, { keep: [{ index: 0, conviction: 99 }, { index: 1, conviction: -4 }, { index: 2, conviction: "high" }] });
    assert.deepEqual(r.picks.map((p) => p.conviction).sort(), [1, 1, 5]);
  });

  it("orders by conviction, most interesting first", () => {
    const r = applyVerdicts(POOLS, { keep: [{ index: 0, conviction: 2 }, { index: 1, conviction: 5 }, { index: 2, conviction: 3 }] });
    assert.deepEqual(r.picks.map((p) => p.pool.name), ["BBB / WETH", "CCC / WETH", "AAA / WETH"]);
  });

  it("truncates a reason instead of logging whatever it was sent", () => {
    const r = applyVerdicts(POOLS, { keep: [{ index: 0, conviction: 3, reason: "x".repeat(5000) }] });
    assert.equal(r.picks[0]!.reason.length, 240);
    assert.equal(applyVerdicts(POOLS, { keep: [{ index: 0, conviction: 3 }] }).picks[0]!.reason, "");
  });
});

describe("nullScout", () => {
  it("picks NOTHING when there is no brain, rather than passing everything", () => {
    // This step exists to exclude. With nothing to do the excluding, the honest
    // result is "nothing has been vetted" — not "everything has".
    return nullScout.rank(POOLS, NOW).then((r) => {
      assert.equal(r.picks.length, 0);
      assert.equal(r.passed.length, 3);
    });
  });
});
