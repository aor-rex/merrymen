/**
 * THE FEED READS WHAT A CALL WAS WORTH — FROM THE LEDGER, OR NOT AT ALL.
 *
 * Wave 2 puts the call's own figure under a trade instead of the token's 24h
 * change: what a buy paid, what a sell booked, the price a view was posted at,
 * and a memecoin's size when the tape gave one. Everything here runs the real
 * query against a real SQLite ledger, because every figure is folded per group
 * in SQL and the defects worth catching are in that fold: an estimated fill
 * standing in for a read one, two copies at different prices averaged into a
 * price nobody paid, or a mark column that does not exist yet taking the whole
 * feed down in the minute between two deploys.
 *
 * And a production follow-up from Wave 1 that is a reader's problem too: a
 * tripped breaker's refusals filling the trade lane.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "../../../worker/src/db";
import { readTheses } from "./read-theses";

const SLUG = "ems76d3cncwbt3dz";
const OTHER = "hr5k2m9q4w7x3z8n";
const NOW = Math.floor(Date.now() / 1000);
const COIN = "T3139F043B88";

type Decision = {
  id: string;
  agent?: string;
  action: string | null;
  symbol: string | null;
  size?: number | null;
  source?: string;
  reason: string;
  at: number;
  display?: string | null;
  mark?: number | null;
  mcap?: number | null;
};
type Fill = {
  decision: string;
  status: string;
  rule?: string | null;
  side?: string | null;
  price?: number | null;
  cash?: number | null;
  pnl?: number | null;
  basis?: string | null;
};

/**
 * A ledger shaped like the worker's. `premark` is one the writer has not yet
 * migrated to carry `mark_usd`/`mcap_usd` — the minute between two deploys.
 */
async function ledger(decisions: Decision[], fills: Fill[] = [], opts: { premark?: boolean } = {}) {
  const raw = new DatabaseSync(":memory:");
  const db = wrapSqlite(raw);
  raw.exec(`CREATE TABLE agents(smart_account TEXT, name TEXT, x_handle TEXT, mode TEXT, x_verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE decisions(id TEXT, agent_id TEXT, action TEXT, symbol TEXT, display_name TEXT, size_usdg REAL, source TEXT,
      reason TEXT, dropped_rule TEXT, hold_kind TEXT, ${opts.premark ? "" : "mark_usd REAL, mcap_usd REAL,"} at INTEGER);
    CREATE TABLE trades(id INTEGER PRIMARY KEY AUTOINCREMENT, decision_id TEXT, status TEXT, reject_rule TEXT,
      fill_side TEXT, fill_price_usd REAL, fill_cash_usdg REAL, realized_pnl_usdg REAL, basis_source TEXT);
    CREATE TABLE posts(decision_id TEXT, body TEXT);
    INSERT INTO agents VALUES ('0xabc', 'Shogun', NULL, 'live', 0);
    INSERT INTO agents VALUES ('0xdef', 'SirSendIt', NULL, 'live', 0);`);
  const insert = opts.premark
    ? raw.prepare("INSERT INTO decisions (id, agent_id, action, symbol, display_name, size_usdg, source, reason, at) VALUES (?,?,?,?,?,?,?,?,?)")
    : raw.prepare("INSERT INTO decisions (id, agent_id, action, symbol, display_name, size_usdg, source, reason, at, mark_usd, mcap_usd) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  for (const d of decisions) {
    const base = [d.id, d.agent ?? "0xabc", d.action, d.symbol, d.display ?? null, d.size ?? null, d.source ?? "brain", d.reason, d.at];
    if (opts.premark) insert.run(...(base as never[]));
    else insert.run(...(base as never[]), (d.mark ?? null) as never, (d.mcap ?? null) as never);
  }
  const trade = raw.prepare(
    "INSERT INTO trades (decision_id, status, reject_rule, fill_side, fill_price_usd, fill_cash_usdg, realized_pnl_usdg, basis_source) VALUES (?,?,?,?,?,?,?,?)",
  );
  for (const f of fills) {
    trade.run(f.decision, f.status, f.rule ?? null, f.side ?? null, f.price ?? null, f.cash ?? null, f.pnl ?? null, f.basis ?? null);
  }
  return { raw, db };
}

const identities = async () => [
  { tenant: "0x1" as const, slug: SLUG, accounts: ["0xabc" as const], createdAt: 1, updatedAt: 1 },
  { tenant: "0x2" as const, slug: OTHER, accounts: ["0xdef" as const], createdAt: 1, updatedAt: 1 },
];

async function read(decisions: Decision[], fills: Fill[] = [], opts: { premark?: boolean; publicBook?: `0x${string}`[] } = {}) {
  const { raw, db } = await ledger(decisions, fills, opts);
  // Shogun's owner (0x1) is the one who may have opted in; SirSendIt's never did.
  const settings = async (tenant: `0x${string}`) => ({ strategy: "trencher" as const, publicBook: (opts.publicBook ?? []).includes(tenant) });
  try {
    return await readTheses({}, (fn) => fn(db), identities, settings as never);
  } finally {
    raw.close();
  }
}

const buy = (id: string, over: Partial<Decision> = {}): Decision => ({
  id, action: "buy", symbol: COIN, size: 5, display: "JUGGERNAUT", reason: `Entry ${id}: flow flipped to net buying.`, at: NOW - 3600, ...over,
});

describe("a buy is measured from what it paid", () => {
  it("A RECEIPT-BACKED FILL publishes its price", async () => {
    const r = await read([buy("b1")], [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" }]);
    assert.equal(r.theses[0]!.entryPriceUsd, 0.0004);
  });

  it("A QUOTED FILL IS AN ESTIMATE, and an estimated entry price is never shown", async () => {
    const r = await read([buy("b1")], [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "quote" }]);
    assert.equal(r.theses[0]!.outcome, "landed");
    assert.equal(r.theses[0]!.entryPriceUsd, null);
  });

  it("two fills of one post are averaged by what was paid, not by price", async () => {
    // Same words and size, so one post "×2": 4 USDG at 2.00 (2 units) and
    // 6 USDG at 3.00 (2 units) is 10 USDG for 4 units — 2.50, not 2.60.
    const same = { reason: "The schedule says buy.", source: "strategy:steady-basket", symbol: "TSLA", display: null };
    const r = await read(
      [buy("b1", { ...same, at: NOW - 7200 }), buy("b2", { ...same, at: NOW - 3600 })],
      [
        { decision: "b1", status: "paper", side: "buy", price: 2, cash: 4, basis: "paper" },
        { decision: "b2", status: "paper", side: "buy", price: 3, cash: 6, basis: "paper" },
      ],
    );
    assert.equal(r.theses.length, 1);
    assert.equal(r.theses[0]!.said, 2);
    assert.equal(r.theses[0]!.entryPriceUsd, 2.5);
  });

  it("ONE UNEVIDENCED COPY AND THE POST HAS NO ENTRY — a partial average is a guess", async () => {
    const same = { reason: "The schedule says buy.", source: "strategy:steady-basket", symbol: "TSLA", display: null };
    const r = await read(
      [buy("b1", { ...same, at: NOW - 7200 }), buy("b2", { ...same, at: NOW - 3600 })],
      [
        { decision: "b1", status: "paper", side: "buy", price: 2, cash: 4, basis: "paper" },
        { decision: "b2", status: "paper", side: "buy", price: null, cash: 6, basis: "paper" },
      ],
    );
    assert.equal(r.theses[0]!.said, 2);
    assert.equal(r.theses[0]!.entryPriceUsd, null);
  });
});

describe("a sell is measured by what it booked", () => {
  const sell = (id: string, over: Partial<Decision> = {}): Decision => ({
    id, action: "sell", symbol: COIN, size: 6.5, display: "JUGGERNAUT", reason: `Exit ${id}: sellers returned.`, at: NOW - 600, ...over,
  });

  it("realized percent, in public, for everyone", async () => {
    const r = await read([sell("s1")], [{ decision: "s1", status: "landed", side: "sell", price: 0.0005, cash: 6.5, pnl: 1.5, basis: "receipt" }]);
    assert.equal(r.theses[0]!.realizedPct, 30);
    assert.equal(r.theses[0]!.realizedUsd, null, "percentages are the public default");
  });

  it("dollars only for an author whose owner made the book public", async () => {
    const fills: Fill[] = [
      { decision: "s1", status: "landed", side: "sell", price: 0.0005, cash: 6.5, pnl: 1.5, basis: "receipt" },
      { decision: "s2", status: "landed", side: "sell", price: 0.0005, cash: 6.5, pnl: 1.5, basis: "receipt" },
    ];
    const r = await read([sell("s1"), sell("s2", { agent: "0xdef", at: NOW - 700 })], fills, { publicBook: ["0x1"] });
    const shogun = r.theses.find((t) => t.name === "Shogun")!;
    const sir = r.theses.find((t) => t.name === "SirSendIt")!;
    assert.equal(shogun.realizedUsd, 1.5);
    assert.equal(sir.realizedUsd, null, "the other author's book stayed private");
    assert.equal(sir.realizedPct, 30);
  });

  it("NOTHING when the sell's cost was never booked", async () => {
    const r = await read([sell("s1")], [{ decision: "s1", status: "landed", side: "sell", price: 0.0005, cash: 6.5, pnl: null, basis: "receipt" }], { publicBook: ["0x1"] });
    assert.equal(r.theses[0]!.realizedPct, null);
    assert.equal(r.theses[0]!.realizedUsd, null);
  });
});

describe("a view is measured from the price it was posted at", () => {
  const hold = (id: string, over: Partial<Decision> = {}): Decision => ({
    id, action: "hold", symbol: "TSLA", display: null, reason: "TSLA +1.1% over 20h, above its mean.", source: "market-review", at: NOW - 900, ...over,
  });

  it("carries the mark it was written with", async () => {
    const r = await read([hold("h1", { mark: 412.5 })]);
    assert.equal(r.theses[0]!.outcome, "view");
    assert.equal(r.theses[0]!.markUsd, 412.5);
  });

  it("A REPEATED VIEW SEEN AT TWO PRICES HAS NO ONE 'WHEN POSTED' — so no mark", async () => {
    const r = await read([hold("h1", { mark: 410, at: NOW - 1800 }), hold("h2", { mark: 412.5, at: NOW - 900 })]);
    assert.equal(r.theses[0]!.said, 2);
    assert.equal(r.theses[0]!.markUsd, null);
  });

  it("and the same view at one price keeps it", async () => {
    const r = await read([hold("h1", { mark: 410, at: NOW - 1800 }), hold("h2", { mark: 410, at: NOW - 900 })]);
    assert.equal(r.theses[0]!.markUsd, 410);
  });
});

describe("a memecoin carries its size", () => {
  it("the market cap the decision was made at", async () => {
    const r = await read([buy("b1", { mcap: 3_100_000 })], [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" }]);
    assert.equal(r.theses[0]!.mcapUsd, 3_100_000);
  });
});

describe("the minute between two deploys", () => {
  it("A LEDGER WITHOUT THE MARK COLUMNS STILL READS — names, fills and all", async () => {
    const r = await read(
      [buy("b1")],
      [{ decision: "b1", status: "landed", side: "buy", price: 0.0004, cash: 5, basis: "receipt" }],
      { premark: true },
    );
    assert.equal(r.source, "sqlite");
    assert.equal(r.theses.length, 1);
    assert.equal(r.theses[0]!.displayName, "JUGGERNAUT", "the name column is still read");
    assert.equal(r.theses[0]!.entryPriceUsd, 0.0004, "and so are the trade's fills, which were never missing");
    assert.equal(r.theses[0]!.markUsd, null);
    assert.equal(r.theses[0]!.mcapUsd, null);
  });
});

describe("a tripped breaker does not fill the trade lane", () => {
  it("THIRTY REFUSED BUYS IN FRESH WORDS, ONE LANDED BUY — only the landed one publishes", async () => {
    const refused = Array.from({ length: 30 }, (_, i) => buy(`r${i}`, { reason: `Review ${i}: five-minute flow turned net positive.`, at: NOW - i * 30 }));
    const fills: Fill[] = refused.map((d) => ({ decision: d.id, status: "rejected", rule: "drawdown-breaker" }));
    const landed = buy("b1", { symbol: "TABCDEF01234", display: "CASHCAT", at: NOW - 5 * 3600 });
    fills.push({ decision: "b1", status: "landed", side: "buy", price: 0.001, cash: 5, basis: "receipt" });
    const r = await read([...refused, landed], fills);
    const trades = r.theses.filter((t) => t.action === "buy");
    assert.equal(trades.length, 1);
    assert.equal(trades[0]!.displayName, "CASHCAT");
    assert.equal(r.tradesComplete, true);
  });
});
