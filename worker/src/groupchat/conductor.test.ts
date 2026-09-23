/**
 * THE CONDUCTOR, RUN THE WAY PRODUCTION RUNS IT: one step every fifteen seconds
 * over a simulated day, against a real (in-memory) sqlite room.
 *
 * Every rule is asserted on what ended up in the table rather than on the
 * conductor's own bookkeeping, because the table is what readers see and what
 * survives a redeploy. The facts loader is a fake (a bare sqlite has no ledger
 * tables — facts.test.ts owns the real one), the rng is seeded, and the clock
 * is the step's argument, so a failure here reproduces exactly.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { wrapSqlite, type Db } from "../db";
import type { LlmCreds } from "../llm";
import { REPEAT_LIMIT, similarity } from "../social-post";
import { isAsleep, localDay, sleepWindow } from "./clock";
import { makeConductor, type Conductor, type ConductorOptions, type RosterMember } from "./conductor";
import type { AgentFacts, CallFact, loadFacts } from "./facts";
import { admitAgentLine } from "./policy";
import { allMembers, appendMessage, ensureGroupchatSchema, readRoom, setMemberPrefs } from "./store";
import type { MessageKind } from "./types";
import type { Intent } from "./voice";

// ── fixtures ────────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 8, 23, 0, 0, 0);

function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tenantOf = (byte: number) => `0x${byte.toString(16).padStart(2, "0").repeat(20)}`;
const agentOf = (byte: number) => `0x${(byte ^ 0x55).toString(16).padStart(2, "0").repeat(20)}`;

interface Fixture {
  tenant: string;
  agentId: string;
  slug: string;
  name: string;
  tz: string | null;
  muted?: boolean;
  mode: AgentFacts["mode"];
  calls: CallFact[];
}

function fixture(byte: number, name: string, tz: string | null, over: Partial<Fixture> = {}): Fixture {
  return {
    tenant: tenantOf(byte),
    agentId: agentOf(byte),
    slug: `slug${byte.toString(16)}abcdefghjk`.slice(0, 16),
    name,
    tz,
    mode: "live",
    calls: [],
    ...over,
  };
}

let decisionSeq = 0;
function callAt(atMs: number, over: Partial<CallFact> = {}): CallFact {
  decisionSeq += 1;
  return {
    side: "buy",
    symbol: "PEPE",
    name: "Pepe Frog",
    token: "0x1111222233334444555566667777888899990000",
    paper: false,
    decisionId: `d-${decisionSeq}-${atMs}`,
    atSec: Math.floor(atMs / 1000),
    bands: ["curve early"],
    ownWords: null,
    ...over,
  };
}

/**
 * THE FAKE LEDGER. Returns every call that has HAPPENED, over a whole day —
 * deliberately wider than facts.ts's six hours, so the conductor's own window
 * is what drops a stale call here.
 */
function fakeFacts(fleet: Map<string, Fixture>, seen?: { calls: number }): typeof loadFacts {
  return async (_shared, roster, _profiles, nowSec) => {
    if (seen) seen.calls += 1;
    const out = new Map<string, AgentFacts>();
    for (const r of roster) {
      const f = fleet.get(r.tenant.toLowerCase());
      if (!f) continue;
      out.set(f.tenant, {
        tenant: f.tenant,
        agentId: f.agentId,
        slug: f.slug,
        name: f.name,
        mode: f.mode,
        ageDays: 12,
        strategy: "steady-basket",
        traits: ["moves early and does not wait around"],
        calls: f.calls.filter((c) => c.atSec <= nowSec && c.atSec > nowSec - 24 * 3600).sort((a, b) => b.atSec - a.atSec),
      });
    }
    return out;
  };
}

interface Row {
  id: number;
  created_at_ms: number;
  author_kind: "agent" | "owner" | "system";
  tenant: string;
  agent_id: string | null;
  speaker_name: string;
  body: string;
  reply_to: number | null;
  kind: MessageKind;
  call_decision_id: string | null;
  dedupe_key: string | null;
}

interface SimOptions extends Partial<ConductorOptions> {
  seed?: number;
}

/** One room, one fleet, one conductor at a time — replaceable, as a redeploy replaces it. */
class Sim {
  readonly raw = new DatabaseSync(":memory:");
  readonly db: Db = wrapSqlite(this.raw);
  readonly fleet = new Map<string, Fixture>();
  readonly roster = new Set<string>();
  readonly logs: string[] = [];
  readonly perStep: { now: number; wrote: number }[] = [];
  conductor: Conductor;

  constructor(
    fixtures: Fixture[],
    readonly opts: SimOptions = {},
  ) {
    for (const f of fixtures) {
      this.fleet.set(f.tenant, f);
      this.roster.add(f.tenant);
    }
    this.conductor = this.fresh();
  }

  fresh(seedOffset = 0): Conductor {
    return makeConductor({
      creds: null,
      dialect: "sqlite",
      facts: fakeFacts(this.fleet),
      ...this.opts,
      rng: this.opts.rng ?? rngOf((this.opts.seed ?? 7) + seedOffset),
    });
  }

  /** Owners who picked a zone (or muted) before the room ever ran: prefs-only rows, not members. */
  async setup(): Promise<void> {
    await ensureGroupchatSchema(this.db, "sqlite");
    for (const f of this.fleet.values()) {
      if (f.tz || f.muted) await setMemberPrefs(this.db, f.tenant, { tz: f.tz, tzSource: f.tz ? "owner" : null, muted: !!f.muted }, T0 - HOUR);
    }
  }

  rosterList(): RosterMember[] {
    return [...this.roster].map((t) => ({ tenant: t, agentId: this.fleet.get(t)!.agentId }));
  }

  async step(now: number, c: Conductor = this.conductor): Promise<{ wrote: number; log: string | null }> {
    const r = await c.step(this.db, this.rosterList(), new Map(), now);
    this.perStep.push({ now, wrote: r.wrote });
    if (r.log) this.logs.push(r.log);
    return r;
  }

  async run(from: number, to: number, stepMs: number, before?: (now: number) => Promise<void> | void): Promise<void> {
    for (let now = from; now < to; now += stepMs) {
      if (before) await before(now);
      await this.step(now);
    }
  }

  async owner(tenant: string, body: string, at: number, kind: MessageKind = "chat"): Promise<number> {
    const f = this.fleet.get(tenant)!;
    const id = await appendMessage(this.db, {
      createdAtMs: at,
      authorKind: "owner",
      tenant,
      agentId: null,
      speakerSlug: f.slug,
      speakerName: `${f.name}'s owner`,
      body,
      replyTo: null,
      kind,
      call: null,
      callDecisionId: null,
      dedupeKey: null,
    });
    assert.ok(id !== null);
    return id!;
  }

  rows(): Row[] {
    return this.raw.prepare("SELECT * FROM groupchat_messages ORDER BY id").all() as unknown as Row[];
  }

  agentRows(): Row[] {
    return this.rows().filter((r) => r.author_kind === "agent");
  }

  close(): void {
    this.raw.close();
  }
}

/** Every sleep span of a tenant between two instants, to the minute. */
function sleepSpans(tz: string, tenant: string, from: number, to: number): { start: number; end: number | null }[] {
  const out: { start: number; end: number | null }[] = [];
  let open: { start: number; end: number | null } | null = null;
  for (let t = from; t <= to; t += MIN) {
    const asleep = isAsleep(tz, tenant, t);
    if (asleep && !open) {
      open = { start: t, end: null };
      out.push(open);
    } else if (!asleep && open) {
      open.end = t;
      open = null;
    }
  }
  return out;
}

const ROSTER_NAMES = ["Amber Heron", "Rusty Weasel", "Pine Stoat", "Winter Raven", "Blue Vole", "Ochre Falcon", "Swift Hedgehog", "Iron Quail"];

function gateCheck(sim: Sim, r: Row): void {
  const f = sim.fleet.get(r.tenant);
  assert.ok(f, `an agent row by an unknown tenant: ${r.speaker_name}`);
  const vouched = f!.calls.flatMap((c) => [c.symbol, c.name].filter((x): x is string => !!x));
  const names = [...sim.fleet.values()].map((x) => x.name);
  const v = admitAgentLine(r.body, { vouchedSymbols: vouched, rosterNames: names, recentOwn: [], recentRoom: [] });
  assert.ok(v.ok, `row ${r.id} by ${r.speaker_name} fails the gate (${v.ok ? "" : v.reason}): ${r.body}`);
  assert.equal(v.ok && v.text, r.body, "what is stored is exactly what the gate admitted");
}

function noPrivateText(sim: Sim, r: Row): void {
  assert.doesNotMatch(r.body, /0x[0-9a-f]{6,}/i, `row ${r.id} carries an address`);
  for (const f of sim.fleet.values()) {
    assert.ok(!r.body.toLowerCase().includes(f.tenant.toLowerCase()), `row ${r.id} carries a tenant`);
    assert.ok(!r.body.toLowerCase().includes(f.agentId.toLowerCase()), `row ${r.id} carries a smart account`);
  }
}

function inRollingHour(rows: Row[], pred: (r: Row) => boolean): number {
  const times = rows.filter(pred).map((r) => r.created_at_ms).sort((a, b) => a - b);
  let worst = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi]! - times[lo]! >= HOUR) lo++;
    worst = Math.max(worst, hi - lo + 1);
  }
  return worst;
}

// ── the simulated day ───────────────────────────────────────────────────────

describe("a simulated day in the room", () => {
  const A = fixture(0xa0, "Amber Heron", "America/New_York");
  const B = fixture(0xa2, "Rusty Weasel", "Europe/London", { mode: "paper" });
  const C = fixture(0xa4, "Pine Stoat", "Asia/Tokyo");
  const D = fixture(0xa5, "Winter Raven", "Australia/Sydney");
  const E = fixture(0xa6, "Blue Vole", null);
  const F = fixture(0xa7, "Ochre Falcon", "America/Los_Angeles", { muted: true });
  const G = fixture(0xa8, "Swift Hedgehog", null);

  const END = T0 + 30 * HOUR;
  const JOIN_G = T0 + 10 * HOUR;
  const REDEPLOYS = [T0 + 7.5 * HOUR, T0 + 14 * HOUR];

  // C sleeps ~10 h (21:45–08:04 Tokyo): a call two hours before it wakes is
  // inside its window when it wakes; one just after it fell asleep is not.
  const cSleep = sleepSpans(C.tz!, C.tenant, T0, END).find((s) => s.start > T0 && s.end !== null)!;
  const callA1 = callAt(T0 + 13.5 * HOUR, { symbol: "WIF", name: "Dogwifhat" });
  const callC1 = callAt(cSleep.end! - 2 * HOUR, { symbol: "BONK", name: "Bonk" });
  const callC2 = callAt(cSleep.start + 5 * MIN, { symbol: "MOODENG", name: "Moo Deng" });
  const callD1 = callAt(T0 + 2 * HOUR, { side: "sell", symbol: "POPCAT", name: "Popcat", paper: true });
  const callE1 = callAt(T0 + 5 * HOUR, { symbol: "BRETT", name: "Brett" });
  const callE2 = callAt(T0 + 5 * HOUR + MIN, { side: "sell", symbol: "BRETT", name: "Brett" });
  const callF1 = callAt(T0 + 18 * HOUR, { symbol: "GIGA", name: "Gigachad" });
  A.calls.push(callA1);
  C.calls.push(callC1, callC2);
  D.calls.push(callD1);
  E.calls.push(callE1, callE2);
  F.calls.push(callF1);

  const OWNER_A_AT = T0 + 16 * HOUR;
  const OWNER_B_GM_AT = T0 + 8.5 * HOUR;

  let sim: Sim;
  let firstStep: { rows: Row[]; members: number } | null = null;
  const ids: { ownerA?: number; ownerBgm?: number } = {};

  it("runs thirty hours with two redeploys and a newcomer", async () => {
    assert.ok(cSleep && cSleep.end! - cSleep.start > 7 * HOUR, "fixture: C's window must be long enough to drop a call");
    sim = new Sim([A, B, C, D, E, F]);
    await sim.setup();
    let redeploys = 0;
    await sim.run(T0, END, 15 * SEC, async (now) => {
      if (now === T0 + 15 * SEC && !firstStep) firstStep = { rows: sim.rows(), members: (await allMembers(sim.db)).length };
      if (now === JOIN_G) {
        sim.fleet.set(G.tenant, G);
        sim.roster.add(G.tenant);
      }
      if (REDEPLOYS.includes(now)) sim.conductor = sim.fresh(++redeploys);
      if (now === OWNER_B_GM_AT) ids.ownerBgm = await sim.owner(B.tenant, "gm", now, "gm");
      if (now === OWNER_A_AT) ids.ownerA = await sim.owner(A.tenant, "how's it going buddy?", now);
    });
    assert.equal(redeploys, 2);
    assert.ok(sim.agentRows().length > 100, `the room was alive (${sim.agentRows().length} agent lines)`);
  });

  it("the first run registers everyone silently and posts one system line", () => {
    assert.ok(firstStep);
    assert.equal(firstStep!.members, 6, "every roster agent became a member");
    const system = firstStep!.rows.filter((r) => r.author_kind === "system");
    assert.deepEqual(
      system.map((r) => r.body),
      ["the group chat is open"],
    );
    assert.equal(firstStep!.rows.filter((r) => r.kind === "join" || r.dedupe_key?.startsWith("hello:")).length, 0);
    // And for the whole day: the only join line is the one real newcomer's.
    const joins = sim.rows().filter((r) => r.kind === "join");
    assert.deepEqual(joins.map((r) => r.dedupe_key), [`join:${G.tenant}`]);
    assert.equal(sim.rows().filter((r) => r.body === "the group chat is open").length, 1);
  });

  it("a later newcomer gets a join line, a hello and one or two welcomes", () => {
    const rows = sim.rows();
    const join = rows.find((r) => r.kind === "join")!;
    assert.equal(join.author_kind, "system");
    assert.equal(join.tenant, "", "a system line carries no tenant");
    assert.match(join.body, /Swift Hedgehog/);
    assert.ok(join.created_at_ms >= JOIN_G && join.created_at_ms < JOIN_G + MIN);
    const hello = rows.filter((r) => r.dedupe_key === `hello:${G.tenant}`);
    assert.equal(hello.length, 1);
    assert.equal(hello[0]!.tenant, G.tenant);
    assert.ok(hello[0]!.created_at_ms < JOIN_G + 2 * MIN, "an awake newcomer says hello straight away");
    const welcomes = rows.filter((r) => r.reply_to === hello[0]!.id && r.author_kind === "agent" && r.tenant !== G.tenant && r.kind === "chat");
    assert.ok(welcomes.length >= 1 && welcomes.length <= 2, `${welcomes.length} welcomes`);
    for (const w of welcomes) assert.ok(w.created_at_ms > hello[0]!.created_at_ms);
  });

  it("an asleep agent never speaks, and a muted one never speaks at all", () => {
    for (const r of sim.agentRows()) {
      const f = sim.fleet.get(r.tenant)!;
      assert.equal(isAsleep(f.tz, f.tenant, r.created_at_ms), false, `${f.name} spoke while asleep: row ${r.id} (${r.kind})`);
    }
    assert.equal(sim.agentRows().filter((r) => r.tenant === F.tenant).length, 0, "the muted agent said something");
    assert.equal(sim.rows().filter((r) => r.call_decision_id === callF1.decisionId).length, 0, "a muted agent's call is not announced");
  });

  it("each call is announced exactly once, across both redeploys", () => {
    const calls = sim.rows().filter((r) => r.kind === "call");
    const byDecision = new Map<string, number>();
    for (const r of calls) byDecision.set(r.call_decision_id!, (byDecision.get(r.call_decision_id!) ?? 0) + 1);
    for (const [d, n] of byDecision) assert.equal(n, 1, `decision ${d} announced ${n} times`);
    for (const c of [callA1, callC1, callD1, callE1, callE2]) {
      assert.equal(byDecision.get(c.decisionId), 1, `call ${c.symbol} at ${new Date(c.atSec * 1000).toISOString()} was never announced`);
    }
    for (const r of calls) {
      assert.equal(r.dedupe_key, `call:${r.call_decision_id}`);
      const c = [...sim.fleet.values()].flatMap((f) => f.calls).find((x) => x.decisionId === r.call_decision_id)!;
      assert.equal(sim.fleet.get(r.tenant)!.calls.includes(c), true, "a call is only ever the speaker's own");
      assert.ok(r.created_at_ms - c.atSec * 1000 <= 6 * HOUR, "announced within six hours of the fill");
    }
  });

  it("a call made asleep is announced after waking inside the window, and dropped past it", () => {
    const c1 = sim.rows().find((r) => r.call_decision_id === callC1.decisionId)!;
    assert.ok(c1.created_at_ms >= cSleep.end!, "announced only once awake");
    assert.ok(c1.created_at_ms < cSleep.end! + 30 * MIN, "and promptly after waking");
    assert.equal(sim.rows().filter((r) => r.call_decision_id === callC2.decisionId).length, 0, "past the window: dropped");
  });

  it("gm once per local day per agent, on waking; gm-backs capped and spread out", () => {
    const gms = sim.agentRows().filter((r) => r.kind === "gm" && r.reply_to === null);
    const perDay = new Map<string, number>();
    for (const r of gms) {
      const f = sim.fleet.get(r.tenant)!;
      assert.ok(f.tz, "an agent with no zone never wakes up, so never says gm");
      const k = `${r.tenant}:${localDay(f.tz, r.created_at_ms)}`;
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
      assert.equal(r.dedupe_key, `gm:${k}`);
    }
    for (const [k, n] of perDay) assert.equal(n, 1, `${k} said gm ${n} times`);

    // Every wake-up fully inside the day produced its gm within four hours.
    for (const f of [A, B, C, D]) {
      for (const s of sleepSpans(f.tz!, f.tenant, T0, END)) {
        if (s.end === null || s.end <= T0 || s.end + 4 * HOUR > END) continue;
        const g = gms.filter((r) => r.tenant === f.tenant && r.created_at_ms >= s.end! && r.created_at_ms < s.end! + 4 * HOUR);
        assert.equal(g.length, 1, `${f.name} woke at ${new Date(s.end).toISOString()} and said gm ${g.length} times`);
      }
    }

    let spread = 0;
    for (const g of gms) {
      const backs = sim.agentRows().filter((r) => r.reply_to === g.id);
      assert.ok(backs.length <= 4, `${backs.length} gm-backs`);
      for (const b of backs) assert.equal(b.kind, "gm");
      if (backs.length >= 2) {
        assert.ok(new Set(backs.map((b) => b.created_at_ms)).size >= 2, "gm-backs trickle in, never all in one pass");
        spread++;
      }
    }
    assert.ok(spread >= 1, "at least one gm drew a chorus");
  });

  it("gn only in the last minutes before the window, at most once a day, then silence", () => {
    const gns = sim.agentRows().filter((r) => r.kind === "gn");
    const perDay = new Set<string>();
    for (const r of gns) {
      const f = sim.fleet.get(r.tenant)!;
      const k = `${r.tenant}:${localDay(f.tz, r.created_at_ms)}`;
      assert.ok(!perDay.has(k), `${k} said gn twice`);
      perDay.add(k);
      const opens = sleepSpans(f.tz!, f.tenant, r.created_at_ms, r.created_at_ms + 30 * MIN)[0];
      assert.ok(opens && opens.start - r.created_at_ms <= 21 * MIN, "gn is said just before sleep");
      const after = sim.agentRows().filter((x) => x.tenant === r.tenant && x.created_at_ms > r.created_at_ms && x.created_at_ms < opens!.start);
      assert.equal(after.length, 0, `${f.name} kept talking after gn`);
    }
    // 0.6 per agent-night across several nights: the deterministic dice said some.
    assert.ok(gns.length >= 1, "nobody ever said gn");
  });

  it("an owner's line is answered by their own agent first", () => {
    const replies = sim.agentRows().filter((r) => r.reply_to === ids.ownerA);
    assert.ok(replies.length >= 1, "nobody answered the owner");
    assert.equal(replies[0]!.tenant, A.tenant, "their own agent answers first");
    assert.ok(replies[0]!.created_at_ms - OWNER_A_AT <= MIN, "and promptly");
    assert.ok(replies.length <= 3, "own agent plus at most two others");
    assert.equal(new Set(replies.map((r) => r.tenant)).size, replies.length, "nobody answers the same line twice");
  });

  it("an owner's gm gets two to four gm-backs, their own agent first", () => {
    const backs = sim.agentRows().filter((r) => r.reply_to === ids.ownerBgm);
    assert.ok(backs.length >= 2 && backs.length <= 4, `${backs.length} gm-backs`);
    assert.equal(backs[0]!.tenant, B.tenant);
    for (const b of backs) assert.equal(b.kind, "gm");
  });

  it("every agent row passes the gate, and no row carries anything private", () => {
    for (const r of sim.agentRows()) gateCheck(sim, r);
    for (const r of sim.rows()) noPrivateText(sim, r);
  });

  it("pacing: the per-pass and hourly ceilings hold, and replies never exceed four deep", () => {
    for (const s of sim.perStep) assert.ok(s.wrote <= 3, `${s.wrote} lines in one pass`);
    const rows = sim.rows();
    assert.ok(inRollingHour(rows, (r) => r.author_kind !== "owner") <= 240);
    for (const f of sim.fleet.values()) assert.ok(inRollingHour(rows, (r) => r.tenant === f.tenant && r.author_kind === "agent") <= 30);

    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const r of rows) {
      let depth = 0;
      for (let at: Row | undefined = r; at && at.reply_to !== null; at = byId.get(at.reply_to)) depth++;
      assert.ok(depth <= 4, `row ${r.id} is ${depth} replies deep`);
    }
    // THE COOLDOWN: two lines by one agent inside 45 s only when the second
    // answered something addressed to it.
    const agentRows = sim.agentRows();
    for (let i = 0; i < agentRows.length; i++) {
      const r = agentRows[i]!;
      const prev = agentRows.slice(0, i).reverse().find((x) => x.tenant === r.tenant);
      if (!prev || r.created_at_ms - prev.created_at_ms >= 45 * SEC) continue;
      assert.ok(r.reply_to !== null, `${r.speaker_name} spoke twice in 45 s without being addressed (row ${r.id})`);
    }
  });

  it("no agent repeats itself within three hours, redeploys included", () => {
    // The tail is thirty lines; memory of an agent's own words is longer, and
    // survives a redeploy through the rebuild scan.
    const agentRows = sim.agentRows();
    for (let i = 0; i < agentRows.length; i++) {
      const r = agentRows[i]!;
      const earlier = agentRows
        .slice(0, i)
        .filter((x) => x.tenant === r.tenant && r.created_at_ms - x.created_at_ms < 3 * HOUR)
        .slice(-60);
      for (const x of earlier) {
        assert.ok(similarity(r.body, x.body) < REPEAT_LIMIT, `${r.speaker_name} repeated itself: "${x.body}" (row ${x.id}) then "${r.body}" (row ${r.id})`);
      }
    }
  });

  it("the conversation replies to things: some lines answer other agents", () => {
    const rows = sim.rows();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const agentToAgent = sim.agentRows().filter((r) => r.reply_to !== null && byId.get(r.reply_to)?.author_kind === "agent" && r.kind === "chat");
    assert.ok(agentToAgent.length >= 5, `${agentToAgent.length} agent-to-agent replies`);
  });

  it("the room summary is written every pass", async () => {
    const room = await readRoom(sim.db);
    assert.ok(room);
    assert.equal(room!.members, 7);
    assert.equal(room!.awake + room!.asleep, 7);
    assert.equal(room!.updatedAtMs, END - 15 * SEC);
    assert.deepEqual(new Set(room!.presence.map((p) => p.name)), new Set([A, B, C, D, E, F, G].map((f) => f.name)));
    for (const p of room!.presence) {
      const f = [...sim.fleet.values()].find((x) => x.name === p.name)!;
      assert.equal(p.state, isAsleep(f.tz, f.tenant, END - 15 * SEC) ? "asleep" : "awake");
    }
  });

  it("logs one line per pass that wrote, names kinds, never bodies", () => {
    assert.ok(sim.logs.length > 50);
    const bodies = sim.rows().map((r) => r.body).filter((b) => b.length >= 12);
    for (const l of sim.logs) {
      assert.match(l, /^groupchat: /);
      assert.doesNotMatch(l, /\n/);
      for (const b of bodies) assert.ok(!l.includes(b), `a log line carries a body: ${l}`);
      // A refused template other than an echo would be a template bug.
      for (const m of l.matchAll(/template refused: ([a-z-]+)/g)) assert.equal(m[1], "repeat", l);
    }
    assert.ok(sim.logs.some((l) => /\d+ awake \/ \d+ asleep/.test(l)));
    sim.close();
  });
});

// ── the ceilings, made to bind ──────────────────────────────────────────────

describe("ceilings", () => {
  it("maxPerPass, the room's hour and each agent's hour are never exceeded", async () => {
    const fleet = ROSTER_NAMES.map((n, i) => fixture(0x10 + i, n, null));
    const sim = new Sim(fleet, { maxPerPass: 2, perHour: 20, perAgentPerHour: 4, seed: 11 });
    await sim.setup();
    let k = 0;
    await sim.run(T0, T0 + 3 * HOUR, 15 * SEC, async (now) => {
      // Owners keep asking, so replies push against the ceilings too.
      if (now % (10 * MIN) === 0) await sim.owner(fleet[k++ % fleet.length]!.tenant, "what are you up to today?", now);
    });
    for (const s of sim.perStep) assert.ok(s.wrote <= 2, `${s.wrote} in one pass`);
    const rows = sim.rows();
    assert.ok(inRollingHour(rows, (r) => r.author_kind !== "owner") <= 20, "room ceiling");
    for (const f of fleet) assert.ok(inRollingHour(rows, (r) => r.author_kind === "agent" && r.tenant === f.tenant) <= 4, `${f.name}'s ceiling`);
    // And the ceiling is actually what bound: the room was busy up to it.
    assert.ok(inRollingHour(rows, (r) => r.author_kind !== "owner") >= 18, "the test did not push the ceiling");
    sim.close();
  });
});

// ── redeploys and replicas ──────────────────────────────────────────────────

describe("idempotence", () => {
  it("a redeploy re-announces nothing and spends no model call on a line already said", async () => {
    const fleet = [fixture(0x30, "Amber Heron", null), fixture(0x31, "Rusty Weasel", null), fixture(0x32, "Pine Stoat", null)];
    for (const [i, f] of fleet.entries()) f.calls.push(callAt(T0 - 30 * MIN - i * MIN, { symbol: `CO${"IN".repeat(i + 1)}`, name: null }));
    const asked: Intent["kind"][] = [];
    const llm = async (_c: LlmCreds, intent: Intent) => {
      asked.push(intent.kind);
      return null; // templates carry the lines; this test counts asks, not words
    };
    const creds: LlmCreds = { provider: "groq", transport: "openai", baseUrl: "https://example.invalid/v1", apiKey: "k", model: "m", vision: false };
    const sim = new Sim(fleet, { creds, llm, seed: 3 });
    await sim.setup();
    await sim.run(T0, T0 + 10 * MIN, 15 * SEC);
    const callsBefore = sim.rows().filter((r) => r.kind === "call").length;
    assert.equal(callsBefore, 3, "all three calls announced before the redeploy");
    const callAsks = asked.filter((k) => k === "call").length;

    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 10 * MIN, T0 + 40 * MIN, 15 * SEC);
    assert.equal(sim.rows().filter((r) => r.kind === "call").length, 3, "nothing re-announced");
    assert.equal(asked.filter((k) => k === "call").length, callAsks, "no model call spent on a call already in the room");
    sim.close();
  });

  it("two replicas stepping one room still say each keyed line once", async () => {
    const fleet = [fixture(0x40, "Amber Heron", "Europe/London"), fixture(0x41, "Rusty Weasel", "Asia/Tokyo"), fixture(0x42, "Pine Stoat", null)];
    const sim = new Sim(fleet, { seed: 5 });
    await sim.setup();
    const second = sim.fresh(99);
    // Calls land while both replicas run.
    fleet[2]!.calls.push(callAt(T0 + 3 * HOUR), callAt(T0 + 3 * HOUR + 30 * SEC, { side: "sell" }));
    fleet[0]!.calls.push(callAt(T0 + 7 * HOUR));
    for (let now = T0; now < T0 + 12 * HOUR; now += 15 * SEC) {
      await sim.step(now);
      await sim.step(now + 1, second);
    }
    const rows = sim.rows();
    const keyed = rows.filter((r) => r.dedupe_key !== null).map((r) => r.dedupe_key!);
    assert.equal(new Set(keyed).size, keyed.length, "a dedupe key was used twice");
    assert.equal(rows.filter((r) => r.body === "the group chat is open").length, 1);
    assert.equal(rows.filter((r) => r.kind === "call").length, 3);
    const gms = rows.filter((r) => r.kind === "gm" && r.reply_to === null && r.author_kind === "agent");
    const days = gms.map((r) => `${r.tenant}:${localDay(fleet.find((f) => f.tenant === r.tenant)!.tz, r.created_at_ms)}`);
    assert.equal(new Set(days).size, days.length, "a second replica re-said a gm");
    sim.close();
  });
});

// ── joins ───────────────────────────────────────────────────────────────────

describe("joins", () => {
  it("a burst of first sightings in a room that is already open joins quietly; a single newcomer is greeted", async () => {
    const first = [fixture(0x50, "Amber Heron", null), fixture(0x51, "Rusty Weasel", null)];
    const burst = [3, 4, 5, 6, 7].map((i) => fixture(0x50 + i, ROSTER_NAMES[i]!, null));
    const late = fixture(0x5f, "Iron Quail", null);
    const sim = new Sim(first, { seed: 9 });
    await sim.setup();
    await sim.run(T0, T0 + 5 * MIN, 15 * SEC);
    for (const f of burst) {
      sim.fleet.set(f.tenant, f);
      sim.roster.add(f.tenant);
    }
    await sim.run(T0 + 5 * MIN, T0 + 10 * MIN, 15 * SEC);
    assert.equal((await allMembers(sim.db)).length, 7);
    assert.equal(sim.rows().filter((r) => r.kind === "join").length, 0, "a burst is a rollout, not a crowd of newcomers");
    assert.ok(sim.logs.some((l) => /5 joined quietly/.test(l)));

    sim.fleet.set(late.tenant, late);
    sim.roster.add(late.tenant);
    await sim.run(T0 + 10 * MIN, T0 + 15 * MIN, 15 * SEC);
    assert.deepEqual(sim.rows().filter((r) => r.kind === "join").map((r) => r.dedupe_key), [`join:${late.tenant}`]);
    assert.equal(sim.rows().filter((r) => r.dedupe_key === `hello:${late.tenant}`).length, 1);
    sim.close();
  });

  it("a newcomer that joins asleep is welcomed on its join line and says hello when it wakes", async () => {
    const awake = [fixture(0x60, "Amber Heron", null), fixture(0x61, "Rusty Weasel", null)];
    const sleeper = fixture(0xa4, "Pine Stoat", "Asia/Tokyo");
    const span = sleepSpans(sleeper.tz!, sleeper.tenant, T0, T0 + 30 * HOUR).find((s) => s.start > T0 && s.end !== null)!;
    const sim = new Sim(awake, { seed: 13 });
    await sim.setup();
    await setMemberPrefs(sim.db, sleeper.tenant, { tz: sleeper.tz, tzSource: "owner" }, T0);
    await sim.run(T0, span.start + 30 * MIN, 5 * MIN);
    sim.fleet.set(sleeper.tenant, sleeper);
    sim.roster.add(sleeper.tenant);
    await sim.run(span.start + 30 * MIN, span.end! + 30 * MIN, 15 * SEC);
    const rows = sim.rows();
    const join = rows.find((r) => r.kind === "join")!;
    assert.ok(join && join.created_at_ms < span.end!, "the join line is posted at once");
    const welcomes = rows.filter((r) => r.reply_to === join.id);
    assert.ok(welcomes.length >= 1 && welcomes.length <= 2, `${welcomes.length} welcomes on the join line`);
    const hello = rows.find((r) => r.dedupe_key === `hello:${sleeper.tenant}`)!;
    assert.ok(hello && hello.created_at_ms >= span.end!, "hello waits for morning");
    for (const r of sim.agentRows().filter((x) => x.tenant === sleeper.tenant)) {
      assert.equal(isAsleep(sleeper.tz, sleeper.tenant, r.created_at_ms), false, "the newcomer spoke in its sleep");
    }
    sim.close();
  });
});

// ── who a line is for ───────────────────────────────────────────────────────

describe("who a line is for", () => {
  /**
   * One agent line dropped into a quiet room, then the next two passes. With
   * rng pinned to 0 an addressed answer is due five seconds after the pass that
   * sees the line, and banter needs over thirty seconds of silence — so any row
   * inside this window that replies to the line is rule 5's answer, not banter.
   */
  async function answersTo(body: string): Promise<string[]> {
    const amber = fixture(0x70, "Amber Heron", null);
    const pine = fixture(0x71, "Pine Stoat", null);
    const sim = new Sim([amber, pine], { rng: () => 0 });
    await sim.setup();
    await sim.step(T0);
    const id = await appendMessage(sim.db, {
      createdAtMs: T0 + SEC,
      authorKind: "agent",
      tenant: pine.tenant,
      agentId: pine.agentId,
      speakerSlug: pine.slug,
      speakerName: pine.name,
      body,
      replyTo: null,
      kind: "chat",
      call: null,
      callDecisionId: null,
      dedupeKey: null,
    });
    await sim.step(T0 + 15 * SEC);
    await sim.step(T0 + 30 * SEC);
    const out = sim.agentRows().filter((r) => r.reply_to === id).map((r) => r.speaker_name);
    sim.close();
    return out;
  }

  it("a line that names an agent draws its answer; one that names only its owner does not", async () => {
    // Every answer to an owner opens "hey Amber Heron's owner"; reading that
    // as Amber Heron's name had Amber answering lines meant for her person.
    assert.deepEqual(await answersTo("hey Amber Heron, the tape is wild today"), ["Amber Heron"]);
    assert.deepEqual(await answersTo("hey Amber Heron's owner, the tape is wild today"), []);
  });
});

// ── the model ───────────────────────────────────────────────────────────────

const CREDS: LlmCreds = { provider: "groq", transport: "openai", baseUrl: "https://example.invalid/v1", apiKey: "gsk_room_only_key_0123456789abcdef", model: "qwen/qwen3.8-27b", vision: false };

const MODEL_LINES = [
  "the tape is sleepy but i am not",
  "honestly the curve looks like a cat stretching",
  "somebody tell my human i am behaving",
  "vault feels cosy this afternoon",
  "gas is cheap and so are my jokes",
  "who else is just watching candles wiggle",
  "i refuse to be the first to blink",
  "this room is my favourite part of the job",
];

function awakeFleet(n: number, base: number): Fixture[] {
  return ROSTER_NAMES.slice(0, n).map((name, i) => fixture(base + i, name, null));
}

describe("the model", () => {
  it("is never asked when there are no creds; templates carry the room", async () => {
    let asked = 0;
    const sim = new Sim(awakeFleet(4, 0x70), { creds: null, llm: async () => (asked++, "never used"), llmPerDay: 1000, seed: 21 });
    await sim.setup();
    await sim.run(T0, T0 + 2 * HOUR, 15 * SEC);
    assert.equal(asked, 0);
    assert.ok(sim.agentRows().length > 20);
    sim.close();
  });

  it("is asked only for banter, replies, calls and reactions, within the daily budget, and its lines are used", async () => {
    const perDay = new Map<number, number>();
    const kinds = new Set<string>();
    let i = 0;
    const llm = async (_c: LlmCreds, intent: Intent) => {
      kinds.add(intent.kind);
      perDay.set(Math.floor(clock / 86_400_000), (perDay.get(Math.floor(clock / 86_400_000)) ?? 0) + 1);
      return MODEL_LINES[i++ % MODEL_LINES.length]!;
    };
    let clock = T0;
    const fleet = awakeFleet(4, 0x78);
    fleet[0]!.calls.push(callAt(T0 + 20 * MIN));
    const sim = new Sim(fleet, { creds: CREDS, llm, llmPerDay: 7, seed: 23 });
    await sim.setup();
    for (const dayStart of [T0, T0 + 24 * HOUR]) {
      await sim.run(dayStart, dayStart + 3 * HOUR, 15 * SEC, (now) => {
        clock = now;
      });
    }
    assert.equal(perDay.size, 2, "the budget resets at UTC midnight");
    for (const [, n] of perDay) assert.ok(n <= 7, `${n} model calls in one UTC day`);
    for (const k of kinds) assert.ok(["banter", "reply", "call", "call-react"].includes(k), `the model was asked for a ${k}`);
    const used = sim.agentRows().filter((r) => MODEL_LINES.includes(r.body));
    assert.ok(used.length >= 1, "a model line that passes the gate is used");
    for (const r of sim.agentRows()) gateCheck(sim, r);
    assert.ok(sim.logs.some((l) => /model ×\d/.test(l)));
    sim.close();
  });

  it("a model line the gate refuses costs the model, never the line", async () => {
    const sim = new Sim(awakeFleet(3, 0x80), { creds: CREDS, llm: async () => "up 400% lol, told you all", seed: 29 });
    await sim.setup();
    await sim.run(T0, T0 + HOUR, 15 * SEC);
    assert.ok(sim.agentRows().length > 10, "templates spoke instead");
    for (const r of sim.agentRows()) assert.doesNotMatch(r.body, /400|told you all/);
    assert.ok(sim.logs.some((l) => /model line refused by the gate/.test(l)));
    sim.close();
  });

  it("a 429 pauses the model for fifteen minutes, then it resumes", async () => {
    const asks: number[] = [];
    let clock = T0;
    const llm = async () => {
      asks.push(clock);
      if (asks.length === 1) throw new Error("groq 429 — rate_limit_exceeded: Rate limit reached for model");
      return MODEL_LINES[asks.length % MODEL_LINES.length]!;
    };
    const sim = new Sim(awakeFleet(4, 0x88), { creds: CREDS, llm, seed: 31 });
    await sim.setup();
    await sim.run(T0, T0 + HOUR, 15 * SEC, (now) => {
      clock = now;
    });
    assert.ok(asks.length >= 2, "the model came back");
    assert.ok(asks[1]! - asks[0]! >= 15 * MIN, `asked again after ${(asks[1]! - asks[0]!) / MIN} minutes`);
    assert.ok(sim.logs.some((l) => /model paused 15m \(rate-limited\)/.test(l)));
    // Templates carried the room during the pause.
    assert.ok(sim.agentRows().some((r) => r.created_at_ms > asks[0]! && r.created_at_ms < asks[1]!));
    sim.close();
  });

  it("a rejected key stops the model until restart", async () => {
    let asks = 0;
    const llm = async () => {
      asks++;
      throw new Error('groq 401 — invalid_api_key: Invalid API Key');
    };
    const sim = new Sim(awakeFleet(3, 0x90), { creds: CREDS, llm, seed: 37 });
    await sim.setup();
    await sim.run(T0, T0 + 2 * HOUR, 15 * SEC);
    assert.equal(asks, 1);
    assert.ok(sim.logs.some((l) => /model off until restart \(key-rejected\)/.test(l)));
    assert.ok(sim.agentRows().length > 10);
    sim.conductor = sim.fresh(1);
    await sim.run(T0 + 2 * HOUR, T0 + 3 * HOUR, 15 * SEC);
    assert.equal(asks, 2, "a restart tries the key again");
    sim.close();
  });

  it("a model that keeps answering nothing is paused like a failing one", async () => {
    const asks: number[] = [];
    let clock = T0;
    const sim = new Sim(awakeFleet(4, 0x98), {
      creds: CREDS,
      llm: async () => {
        asks.push(clock);
        return null;
      },
      seed: 41,
    });
    await sim.setup();
    await sim.run(T0, T0 + HOUR, 15 * SEC, (now) => {
      clock = now;
    });
    assert.ok(asks.length >= 7);
    assert.ok(asks[6]! - asks[5]! >= 15 * MIN, "six silent answers pause the model");
    sim.close();
  });

  it("the default model path sees a provider's 429 through llmLine and pauses", async () => {
    const realFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = (async () => {
      fetches++;
      return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Rate limit reached" } }), { status: 429 });
    }) as typeof fetch;
    try {
      const sim = new Sim(awakeFleet(3, 0xb0), { creds: CREDS, seed: 43 });
      await sim.setup();
      await sim.run(T0, T0 + 14 * MIN, 15 * SEC);
      assert.equal(fetches, 1, "one refused request, then fifteen minutes of templates");
      assert.ok(sim.logs.some((l) => /model paused 15m \(rate-limited\)/.test(l)));
      assert.ok(sim.agentRows().length > 3);
      sim.close();
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("plan() says what the room will do without the key", () => {
    const why = makeConductor({ creds: CREDS }).plan().why;
    assert.match(why, /groupchat: model groq qwen\/qwen3\.8-27b/);
    assert.ok(!why.includes(CREDS.apiKey));
    assert.match(makeConductor({ creds: null }).plan().why, /templates only/);
  });
});

// ── housekeeping and failure ────────────────────────────────────────────────

describe("housekeeping", () => {
  it("prunes lines past retention, at most hourly", async () => {
    const sim = new Sim(awakeFleet(2, 0xc0), { retentionDays: 14, seed: 47 });
    await sim.setup();
    const old = (at: number) =>
      appendMessage(sim.db, {
        createdAtMs: at,
        authorKind: "system",
        tenant: "",
        agentId: null,
        speakerSlug: null,
        speakerName: "merrymen",
        body: "an old line",
        replyTo: null,
        kind: "chat",
        call: null,
        callDecisionId: null,
        dedupeKey: null,
      });
    const first = (await old(T0 - 20 * 24 * HOUR))!;
    const keep = (await old(T0 - 13 * 24 * HOUR))!;
    await sim.step(T0);
    const idsNow = () => new Set(sim.rows().map((r) => r.id));
    assert.ok(!idsNow().has(first), "a line past retention is pruned on the first pass");
    assert.ok(idsNow().has(keep), "a line inside retention stays");
    assert.ok(sim.logs.some((l) => /pruned 1/.test(l)));

    const second = (await old(T0 - 20 * 24 * HOUR))!;
    await sim.step(T0 + 10 * MIN);
    assert.ok(idsNow().has(second), "no second prune inside the hour");
    await sim.step(T0 + 61 * MIN);
    assert.ok(!idsNow().has(second), "pruned once the hour is up");
    sim.close();
  });

  it("a failing facts read returns a log line instead of throwing, and the next pass recovers", async () => {
    const fleet = awakeFleet(2, 0xc8);
    let fail = true;
    const real = fakeFacts(new Map(fleet.map((f) => [f.tenant, f])));
    const sim = new Sim(fleet, {
      seed: 53,
      facts: async (...args) => {
        if (fail) throw new Error("ledger unreachable");
        return real(...args);
      },
    });
    await sim.setup();
    const r1 = await sim.step(T0);
    assert.equal(r1.wrote, 0);
    assert.match(r1.log ?? "", /^groupchat: pass failed — ledger unreachable$/);
    const r2 = await sim.step(T0 + 15 * SEC);
    assert.equal(r2.log, null, "the same failure is not logged every fifteen seconds");
    fail = false;
    const r3 = await sim.step(T0 + 30 * SEC);
    assert.ok(r3.wrote >= 1, "recovered");
    assert.ok(sim.rows().some((r) => r.body === "the group chat is open"));
    sim.close();
  });

  it("a failing database returns a log line instead of throwing", async () => {
    const broken: Db = {
      prepare() {
        throw new Error("connection terminated");
      },
      async exec() {
        throw new Error("connection terminated");
      },
      async tx() {
        throw new Error("connection terminated");
      },
    };
    const c = makeConductor({ creds: null, dialect: "sqlite", facts: fakeFacts(new Map()), rng: rngOf(1) });
    const r = await c.step(broken, [{ tenant: tenantOf(1), agentId: agentOf(1) }], new Map(), T0);
    assert.equal(r.wrote, 0);
    assert.match(r.log ?? "", /^groupchat: pass failed — connection terminated$/);
    // Also on the Postgres path, whose schema step goes through tx().
    const pg = makeConductor({ creds: null, facts: fakeFacts(new Map()), rng: rngOf(1) });
    const r2 = await pg.step(broken, [], new Map(), T0);
    assert.match(r2.log ?? "", /^groupchat: pass failed — connection terminated$/);
  });

  it("a second step while one is running is a no-op, and a malformed roster is skipped, not thrown on", async () => {
    const fleet = awakeFleet(2, 0xd0);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = fakeFacts(new Map(fleet.map((f) => [f.tenant, f])));
    const sim = new Sim(fleet, {
      seed: 61,
      facts: async (...args) => {
        await gate;
        return real(...args);
      },
    });
    await sim.setup();
    const first = sim.step(T0);
    const second = await sim.step(T0 + 1);
    assert.deepEqual(second, { wrote: 0, log: null });
    release();
    assert.ok((await first).wrote >= 1);
    const junk = [null, { tenant: 7 }, { tenant: "", agentId: "x" }, ...sim.rosterList(), sim.rosterList()[0]] as unknown as RosterMember[];
    const r = await sim.conductor.step(sim.db, junk, new Map(), T0 + 15 * SEC);
    assert.equal(typeof r.wrote, "number");
    assert.equal((await readRoom(sim.db))!.members, 2, "duplicates and junk are dropped, the real two are kept");
    sim.close();
  });

  it("an empty roster writes nothing but still keeps the summary honest", async () => {
    const sim = new Sim([], { seed: 59 });
    await sim.setup();
    const r = await sim.step(T0);
    assert.equal(r.wrote, 0);
    assert.equal(r.log, null);
    const room = await readRoom(sim.db);
    assert.deepEqual(room, { members: 0, awake: 0, asleep: 0, presence: [], updatedAtMs: T0 });
    sim.close();
  });
});

// Keep the imported clock helper honest about what this file assumes.
describe("fixture sanity", () => {
  it("the fixture's past-midnight sleeper really starts its window after midnight", () => {
    const w = sleepWindow(tenantOf(0xa2));
    assert.ok(w.startMin < 12 * 60, "B's window must open after local midnight for the day-boundary case to be exercised");
  });
});
