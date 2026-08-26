import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GENESIS, linkHash, reconcile, reconstruct, verifyChain, type ExportedEntry } from "./audit";

/** Build a well-formed chain from a list of payloads, the way the store would. */
function chain(payloads: { kind: string; payload: unknown }[]): ExportedEntry[] {
  const out: ExportedEntry[] = [];
  let prev = GENESIS;
  payloads.forEach((p, i) => {
    const payload_json = JSON.stringify(p.payload);
    const hash = linkHash(prev, payload_json);
    out.push({
      seq: i + 1,
      agent_id: "0xagent",
      epoch: 2,
      kind: p.kind,
      payload_json,
      prev_hash: prev,
      hash,
      at: 1_700_000_000 + i,
    });
    prev = hash;
  });
  return out;
}

const deposit = { kind: "flow", payload: { amountUsdg: 1000, direction: "in", source: "chain-log", txHash: "0xdep" } };
const buy = {
  kind: "fill",
  payload: { amountUsdg: 50, gasWei: "3450000000000", realizedPnlUsdg: null, status: "landed", txHash: "0xbuy" },
};
const sell = {
  kind: "fill",
  payload: { amountUsdg: 60, gasWei: "3450000000000", realizedPnlUsdg: 10, status: "landed", txHash: "0xsell" },
};
const mark = { kind: "mark", payload: { equityUsdg: 1010, marks: [], blockNumber: "5000" } };

describe("verifyChain — tamper evidence", () => {
  it("an untouched chain verifies clean", () => {
    assert.deepEqual(verifyChain(chain([deposit, buy, sell, mark])), []);
  });

  it("an EDITED payload is caught — the recorded hash no longer matches", () => {
    const c = chain([deposit, buy, sell, mark]);
    // The obvious attack: quietly turn a 10 USDG gain into 1,000.
    c[2]!.payload_json = JSON.stringify({ ...JSON.parse(c[2]!.payload_json), realizedPnlUsdg: 1000 });
    const findings = verifyChain(c);
    assert.ok(findings.some((f) => f.check === "chain" && f.seq === 3));
  });

  it("a RE-HASHED edit is still caught — every later link breaks", () => {
    // A more careful attacker edits the payload AND recomputes its hash. That
    // works for one row and breaks the next one's prev_hash, which is the whole
    // point of chaining rather than hashing each record alone.
    const c = chain([deposit, buy, sell, mark]);
    const edited = JSON.stringify({ ...JSON.parse(c[2]!.payload_json), realizedPnlUsdg: 1000 });
    c[2]!.payload_json = edited;
    c[2]!.hash = linkHash(c[2]!.prev_hash, edited);
    const findings = verifyChain(c);
    assert.ok(findings.some((f) => f.check === "chain" && f.seq === 4), JSON.stringify(findings));
  });

  it("a DELETED record shows as a sequence gap even if the chain is re-stitched", () => {
    const c = chain([deposit, buy, sell, mark]);
    const without = [c[0]!, c[2]!, c[3]!]; // drop the buy
    const findings = verifyChain(without);
    assert.ok(findings.some((f) => f.check === "gap"), JSON.stringify(findings));
  });

  it("a gap does not cascade into a break at every later row", () => {
    // Otherwise one deletion drowns the real signal in noise.
    const c = chain([deposit, buy, sell, mark]);
    const findings = verifyChain([c[0]!, c[2]!, c[3]!]);
    assert.equal(findings.filter((f) => f.check === "gap").length, 1);
    assert.equal(findings.filter((f) => f.check === "chain").length, 0);
  });

  it("an empty export is not a failure — it is an agent that has done nothing", () => {
    assert.deepEqual(verifyChain([]), []);
  });
});

describe("reconstruct — the book from primitives", () => {
  it("sums flows, realized P&L and gas", () => {
    const book = reconstruct(chain([deposit, buy, sell, mark]));
    assert.equal(book.netContributionsUsdg, 1000);
    assert.equal(book.realizedPnlUsdg, 10);
    assert.equal(book.gasWei, 6_900_000_000_000n);
    assert.equal(book.publishedEquityUsdg, 1010);
  });

  it("a withdrawal reduces contributions", () => {
    const book = reconstruct(
      chain([deposit, { kind: "flow", payload: { amountUsdg: 400, direction: "out", source: "transfer-intent", txHash: "0xout" } }]),
    );
    assert.equal(book.netContributionsUsdg, 600);
  });

  it("lists every record an RPC could check", () => {
    const book = reconstruct(chain([deposit, buy, sell, mark]));
    assert.deepEqual(book.chainRefs.map((r) => r.txHash), ["0xdep", "0xbuy", "0xsell"]);
  });

  it("SEPARATES what cannot be checked, rather than quietly counting it", () => {
    // An inferred flow moves the numbers and names no transaction. Counting it
    // silently would let a figure that rests on guesswork pass as verified.
    const inferred = { kind: "flow", payload: { amountUsdg: 500, direction: "in", source: "inferred", txHash: null } };
    const paper = { kind: "fill", payload: { amountUsdg: 25, realizedPnlUsdg: 3, status: "paper", txHash: null } };
    const book = reconstruct(chain([inferred, paper]));
    assert.equal(book.netContributionsUsdg, 500);
    assert.equal(book.unanchored.length, 2);
    assert.match(book.unanchored[0]!.why, /inferred/);
    assert.match(book.unanchored[1]!.why, /simulated/);
  });
});

describe("reconcile", () => {
  it("reports the unrealized residual rather than calling it an error", () => {
    const book = reconstruct(chain([deposit, buy, sell, mark]));
    const r = reconcile(book);
    // 1010 published − (1000 contributed + 10 realized) = 0 here.
    assert.equal(r.residualUsdg, 0);
  });

  it("says so when there is nothing to reconcile against", () => {
    const r = reconcile(reconstruct(chain([deposit])));
    assert.equal(r.residualUsdg, null);
    assert.match(r.note, /nothing to reconcile/);
  });
});
