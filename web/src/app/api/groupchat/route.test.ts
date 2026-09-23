/**
 * THE ROOM'S HTTP DOOR, DRIVEN THROUGH ITS REAL HANDLERS.
 *
 * Every request below is a real Request into the exported GET/POST/DELETE,
 * with a real session cookie, the real file-backed grant and identity stores
 * under a temporary home, and the store's real SQL on an in-memory sqlite
 * through the ledger's own driver (room.ts's seam). What is NOT covered here is
 * the Postgres dialect of that SQL; the one statement this route adds on top
 * of the store (the per-owner advisory lock) is Postgres-only and is skipped
 * on sqlite.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";

import { agentNameForSlug, type StoredGrant } from "@merrymen/core";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { wrapSqlite, type Db } from "../../../../../worker/src/db";
import { getGrantStore, resetGrantStoreForTest } from "../../../../../worker/src/grant-store";
import { getIdentityStore, resetIdentityStoreForTest } from "../../../../../worker/src/identity-store";
import { appendMessage, ensureGroupchatSchema } from "../../../../../worker/src/groupchat/store";
import type { NewMessage, PublicMessage } from "../../../../../worker/src/groupchat/types";
import { DELETE, GET, POST } from "./route";
import { setRoomForTest } from "./room";

const ORIGIN = "https://app.merrymen.dev";
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;
/** Signed in, no grant: not an owner. */
const C = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
/** Smart accounts, written mixed-case where the ledger might hold them so. */
const SA_A = "0x00000000000000000000000000000000000000a1" as const;
const SA_B = "0x00000000000000000000000000000000000000b2" as const;
/** Noon UTC: the day count resets twelve hours from here. */
const NOON = Date.UTC(2026, 8, 23, 12, 0, 0);

const saved = Object.fromEntries(
  ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_STORE_DEK"].map((k) => [k, process.env[k]]),
);
let home: string;
let slugA: string;
let slugB: string;

/** A grant as the store keeps it: session key only, never an owner key. */
function grantFor(smartAccount: `0x${string}`): StoredGrant {
  return {
    smartAccount,
    owner: "0x0000000000000000000000000000000000000fee",
    sessionKeyAddress: "0x0000000000000000000000000000000000000abc",
    serialized: "not-a-permission-account",
    caps: { perTradeUsdg: 10, dailyUsdg: 50, expiryDays: 7, maxDrawdownPct: 20, maxOpsPerDay: 20 },
    grantedAt: 1,
    expiresAt: 4_000_000_000,
    chainId: 4663,
    demoSessionPrivateKey: `0x${"1".repeat(64)}`,
  } as unknown as StoredGrant;
}

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-groupchat-route-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "groupchat-route-test-secret-at-least-32-chars";
  delete process.env.DATABASE_URL;
  delete process.env.MERRYMEN_STORE_DEK;
  resetGrantStoreForTest();
  resetIdentityStoreForTest();
  await getGrantStore().put(A, grantFor(SA_A));
  await getGrantStore().put(B, grantFor(SA_B));
  slugA = (await getIdentityStore().ensure(A, SA_A)).slug;
  slugB = (await getIdentityStore().ensure(B, SA_B)).slug;
});

after(() => {
  setRoomForTest(null);
  mock.restoreAll();
  resetGrantStoreForTest();
  resetIdentityStoreForTest();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let raw: DatabaseSync;
let db: Db;
let clock = NOON;

/** A fresh room per test, with the ledger's `agents` rows the name is read from. */
beforeEach(async () => {
  process.env.MERRYMEN_HOSTED = "1";
  clock = NOON;
  raw = new DatabaseSync(":memory:");
  raw.exec("CREATE TABLE agents (smart_account TEXT PRIMARY KEY, name TEXT)");
  raw.prepare("INSERT INTO agents (smart_account, name) VALUES (?, ?)").run(SA_A.toUpperCase().replace("0X", "0x"), "Kestrel");
  raw.prepare("INSERT INTO agents (smart_account, name) VALUES (?, ?)").run(SA_B, "Robin");
  db = wrapSqlite(raw);
  await ensureGroupchatSchema(db, "sqlite");
  setRoomForTest({ db, now: () => clock });
});

afterEach(() => {
  setRoomForTest(null);
  mock.restoreAll();
  try {
    raw.close();
  } catch {
    /* already closed by the test */
  }
});

const cookie = (tenant: string) => `${SESSION_COOKIE}=${mintSession(tenant as `0x${string}`)}`;

function get(query = "", tenant?: string) {
  return GET(new Request(`${ORIGIN}/api/groupchat${query}`, { headers: tenant ? { cookie: cookie(tenant) } : {} }));
}

function post(tenant: string | null, body: unknown, raw = false) {
  return POST(
    new Request(`${ORIGIN}/api/groupchat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(tenant ? { cookie: cookie(tenant) } : {}) },
      body: raw ? String(body) : JSON.stringify(body),
    }),
  );
}

function del(tenant: string | null, id: string | number) {
  return DELETE(
    new Request(`${ORIGIN}/api/groupchat?id=${encodeURIComponent(String(id))}`, {
      method: "DELETE",
      headers: tenant ? { cookie: cookie(tenant) } : {},
    }),
  );
}

/** An agent line as the orchestrator writes it, with every internal field set. */
function agentLine(over: Partial<NewMessage> = {}): NewMessage {
  return {
    createdAtMs: clock - 5_000,
    authorKind: "agent",
    tenant: B,
    agentId: SA_B,
    speakerSlug: slugB,
    speakerName: "Amber Heron",
    body: "just picked up a bag",
    replyTo: null,
    kind: "call",
    call: { side: "buy", symbol: "FROG", name: "Frog", token: null, paper: true },
    callDecisionId: "decision-secret-id",
    dedupeKey: `call:${Math.random()}`,
    ...over,
  };
}

/** The same database, with every statement's answer delayed a few milliseconds. */
function slow(inner: Db): Db {
  const late = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 3));
  return {
    prepare(sql) {
      const s = inner.prepare(sql);
      return {
        run: async (...p) => late(await s.run(...p)),
        get: async (...p) => late(await s.get(...p)),
        all: async (...p) => late(await s.all(...p)),
      };
    },
    exec: (sql) => inner.exec(sql),
    tx: (fn) => inner.tx((scoped) => fn(slow(scoped))),
  };
}

async function posted(res: Response): Promise<PublicMessage> {
  const body = (await res.json()) as { message?: PublicMessage; error?: string };
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.message);
  return body.message;
}

/** The route's source without comments, which name what the code must never do. */
const CODE = readFileSync(new URL("./route.ts", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("hosted only", () => {
  it("answers 404 to every verb on a self-hosted install", async () => {
    delete process.env.MERRYMEN_HOSTED;
    assert.equal((await get()).status, 404);
    assert.equal((await post(A, { body: "hello" })).status, 404);
    assert.equal((await del(A, 1)).status, 404);
  });
});

describe("GET is the same bytes for everybody", () => {
  it("never reads a session: no tenantOf, no cookie, in the handler", () => {
    const start = CODE.indexOf("export async function GET");
    const end = CODE.indexOf("\nexport async function", start + 1);
    const body = CODE.slice(start, end);
    assert.ok(start > 0 && end > start);
    assert.doesNotMatch(body, /tenantOf|cookie|headers\.get/);
  });

  it("answers a signed-in and a signed-out reader identically, sets no cookie, and carries nothing internal", async () => {
    await posted(await post(A, { body: "morning all, my agent is up early" }));
    await appendMessage(db, agentLine());
    const anon = await get("?limit=60");
    const signed = await get("?limit=60", A);
    const anonText = await anon.text();
    assert.equal(anonText, await signed.text());
    assert.equal(anon.headers.get("set-cookie"), null);
    assert.equal(signed.headers.get("set-cookie"), null);
    assert.equal(anon.headers.get("cache-control"), "public, max-age=2, s-maxage=2");
    for (const secret of [A, B, SA_A, SA_B, "decision-secret-id", "call:", "tenant", "agentId", "agent_id", "dedupe", "hidden"]) {
      assert.ok(!anonText.toLowerCase().includes(secret.toLowerCase()), `the public GET leaked ${secret}`);
    }
    const page = JSON.parse(anonText) as { source: string; messages: PublicMessage[] };
    assert.equal(page.source, "db");
    assert.equal(page.messages.length, 2);
    assert.deepEqual(Object.keys(page.messages[1]!).sort(), ["at", "author", "body", "call", "id", "kind", "name", "replyTo", "slug"]);
  });

  it("is dynamic and never prerendered", () => {
    assert.match(CODE, /export const dynamic = "force-dynamic"/);
    assert.doesNotMatch(CODE, /export const revalidate/);
  });
});

describe("GET pages by cursor", () => {
  it("since returns only newer lines; the cursor is the newest id, or the since sent when nothing is new", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await appendMessage(db, agentLine({ body: `line ${i}`, dedupeKey: null })))!);
    const after2 = (await (await get(`?since=${ids[1]}&limit=100`)).json()) as { messages: PublicMessage[]; cursor: number; start: boolean };
    assert.deepEqual(after2.messages.map((m) => m.id), ids.slice(2));
    assert.equal(after2.cursor, ids[4]);
    const quiet = (await (await get(`?since=${ids[4]}&limit=100`)).json()) as { messages: PublicMessage[]; cursor: number };
    assert.deepEqual(quiet.messages, []);
    assert.equal(quiet.cursor, ids[4]);
  });

  it("before returns the older page and says when it reached the start", async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push((await appendMessage(db, agentLine({ body: `line ${i}`, dedupeKey: null })))!);
    const older = (await (await get(`?before=${ids[3]}&limit=2`)).json()) as { messages: PublicMessage[]; start: boolean };
    assert.deepEqual(older.messages.map((m) => m.id), [ids[1], ids[2]]);
    assert.equal(older.start, false);
    const first = (await (await get(`?before=${ids[1]}&limit=2`)).json()) as { messages: PublicMessage[]; start: boolean };
    assert.deepEqual(first.messages.map((m) => m.id), [ids[0]]);
    assert.equal(first.start, true);
    const newest = (await (await get(`?limit=2`)).json()) as { messages: PublicMessage[]; cursor: number };
    assert.deepEqual(newest.messages.map((m) => m.id), [ids[3], ids[4]]);
    assert.equal(newest.cursor, ids[4]);
  });

  it("leaves hidden lines out", async () => {
    const mine = await posted(await post(A, { body: "oops" }));
    assert.equal(((await (await del(A, mine.id)).json()) as { hidden: boolean }).hidden, true);
    const page = (await (await get()).json()) as { messages: PublicMessage[] };
    assert.ok(!page.messages.some((m) => m.id === mine.id));
  });

  it("refuses a cursor that is not a whole number, without caching the refusal", async () => {
    for (const q of ["?since=1e3", "?since=-1", "?since=2.5", "?before=abc", "?limit=ten", `?since=${"9".repeat(17)}`]) {
      const res = await get(q);
      assert.equal(res.status, 400, q);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });

  it("serves the room summary the orchestrator wrote", async () => {
    raw.prepare("INSERT INTO groupchat_room (k, v, updated_at_ms) VALUES ('room', ?, ?)").run(
      JSON.stringify({ members: 2, awake: 1, asleep: 1, presence: [{ slug: slugB, name: "Amber Heron", state: "awake" }], updatedAtMs: clock }),
      clock,
    );
    const page = (await (await get()).json()) as { room: { awake: number; asleep: number } | null };
    assert.equal(page.room?.awake, 1);
    assert.equal(page.room?.asleep, 1);
  });
});

describe("GET says when it could not read", () => {
  it("source none, the client's cursor back, no-store — never an empty room", async () => {
    raw.close();
    const res = await get("?since=41&limit=100");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { source: "none", messages: [], cursor: 41, room: null });
  });

  it("source none when this deploy has no shared database at all", async () => {
    setRoomForTest(null);
    const res = await get("?limit=10");
    assert.deepEqual(await res.json(), { source: "none", messages: [], cursor: 0, room: null });
  });

  it("source none when the shared Postgres cannot be reached", async () => {
    setRoomForTest(null);
    process.env.DATABASE_URL = "postgres://127.0.0.1:1/never-connected";
    try {
      const res = await get("?since=7");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { source: "none", messages: [], cursor: 7, room: null });
    } finally {
      delete process.env.DATABASE_URL;
    }
  });
});

describe("POST: who may post", () => {
  it("401 signed out, 403 signed in without a Merryman", async () => {
    const out = await post(null, { body: "hi" });
    assert.equal(out.status, 401);
    const stranger = await post(C, { body: "hi" });
    assert.equal(stranger.status, 403);
    assert.equal(((await stranger.json()) as { error: string }).error, "Only owners with a Merryman can post.");
  });

  it("503, not 403, when the grant store cannot be read", async () => {
    mock.method(getGrantStore(), "get", async () => {
      throw new Error("Connection terminated unexpectedly");
    });
    const res = await post(A, { body: "hi" });
    assert.equal(res.status, 503);
    assert.doesNotMatch(await res.text(), /Connection terminated/);
  });

  it("413 over four kilobytes, before anything is parsed", async () => {
    const res = await post(A, JSON.stringify({ body: "x".repeat(5000) }), true);
    assert.equal(res.status, 413);
  });

  it("400 for a body that is not JSON or has no text", async () => {
    assert.equal((await post(A, "not json", true)).status, 400);
    assert.equal((await post(A, [1, 2])).status, 400);
    assert.equal((await post(A, { text: "hi" })).status, 400);
  });

  it("400 with an owner-facing sentence for each thing the gate refuses", async () => {
    const cases: [string, RegExp][] = [
      ["   ", /Write something/],
      ["x".repeat(501), /under 500 characters/],
      ["send it to 0x1234567890abcdef1234567890abcdef12345678", /Addresses can't be posted/],
      ["check https://evil.example/x", /Links can't be posted/],
      [`my key is 0x${"ab".repeat(32)}`, /private key or a secret/],
    ];
    for (const [body, words] of cases) {
      const res = await post(A, { body });
      assert.equal(res.status, 400, body);
      assert.match(((await res.json()) as { error: string }).error, words);
    }
    assert.equal(((await (await get()).json()) as { messages: unknown[] }).messages.length, 0, "nothing refused was stored");
  });
});

describe("POST: the line as the room shows it", () => {
  it("is the owner's, under their agent's name and slug, with the tenant kept internal", async () => {
    const m = await posted(await post(A, { body: "  up late with my agent\nagain  ", clientId: "c1" }));
    assert.equal(m.author, "owner");
    assert.equal(m.name, "Kestrel's owner");
    assert.equal(m.slug, slugA);
    assert.equal(m.body, "up late with my agent again");
    assert.equal(m.kind, "chat");
    assert.equal(m.call, null);
    const row = raw.prepare("SELECT tenant, agent_id, author_kind, dedupe_key FROM groupchat_messages WHERE id = ?").get(m.id) as Record<string, unknown>;
    assert.deepEqual({ ...row }, { tenant: A, agent_id: SA_A, author_kind: "owner", dedupe_key: null });
  });

  it("the stock Robin becomes the slug's generated name, the same one the conductor uses", async () => {
    const m = await posted(await post(B, { body: "hello room" }));
    assert.equal(m.name, `${agentNameForSlug(slugB)}'s owner`);
  });

  it("an address-shaped or missing agent name is never shown", async () => {
    raw.prepare("UPDATE agents SET name = ? WHERE smart_account = ?").run("0xdeadbeef00", SA_B);
    assert.equal((await posted(await post(B, { body: "one" }))).name, `${agentNameForSlug(slugB)}'s owner`);
    raw.prepare("DELETE FROM agents WHERE smart_account = ?").run(SA_B);
    assert.equal((await posted(await post(B, { body: "two" }))).name, `${agentNameForSlug(slugB)}'s owner`);
  });

  it("a line that is only a greeting is a gm; a greeting with a question is chat", async () => {
    for (const body of ["gm", "GM all!", "good morning everyone ☀️", "gm gm frens"]) {
      assert.equal((await posted(await post(A, { body }))).kind, "gm", body);
      clock += 11_000;
    }
    assert.equal((await posted(await post(A, { body: "gm, how is everyone doing" }))).kind, "chat");
  });

  it("owner lines may carry digits — it is their speech", async () => {
    assert.equal((await posted(await post(A, { body: "up 40% today, 3 trades" }))).body, "up 40% today, 3 trades");
  });
});

describe("POST: replies", () => {
  it("replyTo must be a positive whole number naming a line the room still shows", async () => {
    const target = (await appendMessage(db, agentLine({ dedupeKey: null })))!;
    for (const replyTo of ["5", 0, -1, 1.5, 999_999, true]) {
      const res = await post(A, { body: "agreed", replyTo });
      assert.equal(res.status, 400, JSON.stringify(replyTo));
    }
    const hidden = await posted(await post(B, { body: "take this back" }));
    await del(B, hidden.id);
    assert.equal((await post(A, { body: "what did you say?", replyTo: hidden.id })).status, 400);
    const ok = await posted(await post(A, { body: "agreed", replyTo: target }));
    assert.equal(ok.replyTo, target);
    assert.equal((await posted(await post(A, { body: "no reply", replyTo: null }))).replyTo, null);
  });
});

describe("POST: the rate limit", () => {
  it("six a minute, then 429 with Retry-After, and the next minute opens again", async () => {
    for (let i = 0; i < 6; i++) await posted(await post(A, { body: `line ${i}` }));
    const seventh = await post(A, { body: "one more" });
    assert.equal(seventh.status, 429);
    assert.equal(seventh.headers.get("retry-after"), "60");
    assert.match(((await seventh.json()) as { error: string }).error, /Wait a minute/);
    assert.equal((await post(B, { body: "another owner is unaffected" })).status, 200);
    clock += 61_000;
    assert.equal((await post(A, { body: "later" })).status, 200);
  });

  it("hiding a line does not give it back", async () => {
    for (let i = 0; i < 6; i++) {
      const m = await posted(await post(A, { body: `line ${i}` }));
      await del(A, m.id);
    }
    assert.equal((await post(A, { body: "again" })).status, 429);
  });

  it("two hundred a UTC day, then 429 until midnight; yesterday's lines do not count", async () => {
    const owner = (at: number): NewMessage => ({
      ...agentLine(),
      authorKind: "owner",
      tenant: A,
      agentId: SA_A,
      kind: "chat",
      call: null,
      callDecisionId: null,
      dedupeKey: null,
      createdAtMs: at,
    });
    for (let i = 0; i < 40; i++) await appendMessage(db, owner(NOON - 13 * 3600_000)); // yesterday, UTC
    for (let i = 0; i < 199; i++) await appendMessage(db, owner(NOON - 3 * 3600_000));
    assert.equal((await post(A, { body: "the two hundredth" })).status, 200);
    clock += 61_000;
    const over = await post(A, { body: "the two hundred and first" });
    assert.equal(over.status, 429);
    assert.equal(over.headers.get("retry-after"), String(12 * 3600 - 61));
  });

  it("holds under concurrent posts: a burst cannot count the same lines twice", async () => {
    // Every statement answers late, so ten requests that were NOT serialised
    // would all count zero before any of them inserted.
    setRoomForTest({ db: slow(db), now: () => clock });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => post(A, { body: `burst ${i}` })));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429, 429, 429, 429]);
  });
});

describe("DELETE hides only the caller's own owner lines", () => {
  it("an owner can take back their line; nobody else can, and no agent line can be hidden", async () => {
    const mine = await posted(await post(A, { body: "hello" }));
    const theirs = await posted(await post(B, { body: "hi" }));
    const agent = (await appendMessage(db, agentLine({ dedupeKey: null })))!;
    assert.equal((await del(null, mine.id)).status, 401);
    assert.equal(((await (await del(B, mine.id)).json()) as { hidden: boolean }).hidden, false);
    assert.equal(((await (await del(A, agent)).json()) as { hidden: boolean }).hidden, false);
    assert.equal(((await (await del(A, theirs.id)).json()) as { hidden: boolean }).hidden, false);
    const res = await del(A, mine.id);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.equal(((await res.json()) as { hidden: boolean }).hidden, true);
    const ids = ((await (await get()).json()) as { messages: PublicMessage[] }).messages.map((m) => m.id);
    assert.deepEqual(ids.sort((x, y) => x - y), [theirs.id, agent].sort((x, y) => x - y));
  });

  it("400 for an id that is not one", async () => {
    for (const id of ["", "abc", "0", "-3", "1.5"]) assert.equal((await del(A, id)).status, 400, id);
  });
});

describe("no model is ever called from here", () => {
  it("imports nothing that can reach one", () => {
    assert.doesNotMatch(CODE, /\bllm\b|llmText|llmLine|groupchat\/voice|groupchat\/conductor|\bfetch\(/);
  });
});
