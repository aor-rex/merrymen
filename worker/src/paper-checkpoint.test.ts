import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { mirrorPaperCheckpoints, paperCheckpointRejection, restorePaperCheckpoint, validPaperCheckpoint } from "./paper-checkpoint";

test("paper cash, inventory and basis survive a fresh child without resetting or overwriting a running book", async()=>{
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [child,shared,fresh]=raws.map(wrapSqlite);
  try {
    for(const db of [child!,shared!,fresh!]) await db.exec(`CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
      CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
      CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
      INSERT INTO agents VALUES('a',1);`);
    await child!.prepare(`INSERT INTO paper_book VALUES('a',900,0,1000,?,10)`).run(JSON.stringify({AAPL:{token:'0x'+'1'.repeat(40),shares:2}}));
    await child!.exec(`INSERT INTO cost_basis VALUES('a','paper','AAPL','2000000000000000000','100000000',10)`);
    assert.equal(await mirrorPaperCheckpoints(child!,shared!),1);
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored/);
    assert.equal((await fresh!.prepare(`SELECT cash_usdg FROM paper_book`).get() as {cash_usdg:number}).cash_usdg,900);
    assert.equal((await fresh!.prepare(`SELECT cost_usdg FROM cost_basis`).get() as {cost_usdg:string}).cost_usdg,'100000000');
    await fresh!.exec(`UPDATE paper_book SET cash_usdg=875`);
    assert.equal(await restorePaperCheckpoint(fresh!,shared!,'a'),'local book retained');
    assert.equal((await fresh!.prepare(`SELECT cash_usdg FROM paper_book`).get() as {cash_usdg:number}).cash_usdg,875);
    // A book read between an inventory write and its basis write is rejected.
    await child!.exec(`UPDATE cost_basis SET qty_raw='1000000000000000000'`);
    assert.equal(await mirrorPaperCheckpoints(child!,shared!),0);
    // Upgrade from the old mirror's reconciled equity + position snapshot.
    await fresh!.exec('DELETE FROM paper_book; DELETE FROM cost_basis;');
    await shared!.exec(`DELETE FROM paper_checkpoints;
      CREATE TABLE equity(id INTEGER,agent_id TEXT,epoch INTEGER,mode TEXT,at INTEGER,cash_usdg REAL,vault_usdg REAL,positions_usdg REAL,equity_usdg REAL);
      CREATE TABLE trades(agent_id TEXT,epoch INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,value_usdg REAL);
      INSERT INTO equity VALUES(1,'a',1,'paper',10,900,0,110,1010);
      INSERT INTO cost_basis VALUES('a','paper','AAPL','2000000000000000000','100000000',10);`);
    await shared!.prepare(`INSERT INTO positions VALUES('a','AAPL',?,'2000000000000000000',110)`).run('0x'+'1'.repeat(40));
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored/);
    assert.equal((await fresh!.prepare('SELECT cash_usdg FROM paper_book').get() as {cash_usdg:number}).cash_usdg,900);
    await fresh!.exec('DELETE FROM paper_book;');
    await shared!.exec("INSERT INTO trades VALUES('a',1,'paper',11)");
    await assert.rejects(restorePaperCheckpoint(fresh!,shared!,'a'),/newer/);
  } finally {raws.forEach(r=>r.close());}
});

/**
 * THE FAILURE THAT KILLED EIGHT AGENTS, reproduced.
 *
 * The existing round-trip test above builds a world where the positions table
 * and the equity row were captured in the same instant — `value_usdg` 110
 * against `positions_usdg` 110 — which is the one case the old check could
 * pass. Production is never that world: `setPositions` replaces the positions
 * table every tick and the equity row is written only when the book is
 * complete, so the two drift apart and never come back.
 *
 * The consequence was not a warning. `restorePaperCheckpoint` throwing makes
 * the orchestrator skip `spawn()` for a paper agent, so the agent does not run
 * at all — and since the drift is permanent, it never runs again.
 */
test("a price that moved since the recoverable valuation does not block recovery", async()=>{
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [shared,fresh]=raws.map(wrapSqlite);
  try {
    for(const db of [shared!,fresh!]) await db.exec(`CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
      CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
      CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
      INSERT INTO agents VALUES('a',1);`);
    await shared!.exec(`CREATE TABLE equity(id INTEGER,agent_id TEXT,epoch INTEGER,mode TEXT,at INTEGER,cash_usdg REAL,vault_usdg REAL,positions_usdg REAL,equity_usdg REAL);
      CREATE TABLE trades(agent_id TEXT,epoch INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,value_usdg REAL);
      INSERT INTO equity VALUES(1,'a',1,'paper',10,900,0,110,1010);
      INSERT INTO cost_basis VALUES('a','paper','AAPL','2000000000000000000','100000000',10);`);
    // THE ONLY DIFFERENCE FROM THE PASSING CASE: the holding is now marked at
    // 120 rather than the 110 the equity row recorded. Same shares, same cash,
    // no fills — just a later mark. Production deltas ran from 0.0066 to
    // 948.40 USDG; ten is comfortably inside that and 1,000,000x the old
    // tolerance of 0.00001.
    await shared!.prepare(`INSERT INTO positions VALUES('a','AAPL',?,'2000000000000000000',120)`).run('0x'+'1'.repeat(40));
    assert.match(await restorePaperCheckpoint(fresh!,shared!,'a'),/restored/);
    const book = await fresh!.prepare('SELECT cash_usdg,hwm_usdg FROM paper_book').get() as {cash_usdg:number;hwm_usdg:number};
    // Cash comes from the mark and is untouched by the re-mark: `later.n`
    // proved no fill landed after it, so the cash cannot have moved.
    assert.equal(book.cash_usdg,900);
    // The HWM takes today's valuation, which is above anything the series held.
    assert.equal(book.hwm_usdg,1020);
  } finally {raws.forEach(r=>r.close());}
});

test("a recoverable valuation whose own terms do not add up is still refused", async()=>{
  // The check that REPLACED the cross-temporal one, and it has to bite: this
  // tests one row against itself, which is a question that has a right answer
  // at any instant. Production passes it every time — the old error message
  // proved as much, printing identical snapshotDelta and equityDelta, which
  // reduces algebraically to exactly this identity holding.
  const raws=[new DatabaseSync(':memory:'),new DatabaseSync(':memory:')];
  const [shared,fresh]=raws.map(wrapSqlite);
  try {
    for(const db of [shared!,fresh!]) await db.exec(`CREATE TABLE agents(smart_account TEXT,epoch INTEGER);
      CREATE TABLE paper_book(agent_id TEXT PRIMARY KEY,cash_usdg REAL,vault_usdg REAL,hwm_usdg REAL,shares TEXT,updated_at INTEGER);
      CREATE TABLE cost_basis(agent_id TEXT,mode TEXT,symbol TEXT,qty_raw TEXT,cost_usdg TEXT,updated_at INTEGER);
      INSERT INTO agents VALUES('a',1);`);
    await shared!.exec(`CREATE TABLE equity(id INTEGER,agent_id TEXT,epoch INTEGER,mode TEXT,at INTEGER,cash_usdg REAL,vault_usdg REAL,positions_usdg REAL,equity_usdg REAL);
      CREATE TABLE trades(agent_id TEXT,epoch INTEGER,status TEXT,created_at INTEGER);
      CREATE TABLE positions(agent_id TEXT,symbol TEXT,token TEXT,raw_balance TEXT,value_usdg REAL);
      INSERT INTO equity VALUES(1,'a',1,'paper',10,900,0,110,5000);
      INSERT INTO cost_basis VALUES('a','paper','AAPL','2000000000000000000','100000000',10);`);
    await shared!.prepare(`INSERT INTO positions VALUES('a','AAPL',?,'2000000000000000000',110)`).run('0x'+'1'.repeat(40));
    await assert.rejects(restorePaperCheckpoint(fresh!,shared!,'a'),/does not add up/);
  } finally {raws.forEach(r=>r.close());}
});

test("a rejected checkpoint says which clause rejected it", async()=>{
  // The boolean is why eight dead agents could only be described as "invalid".
  const base = {agent_id:'a',epoch:1,cash_usdg:900,vault_usdg:0,hwm_usdg:1000,updated_at:10};
  const token = '0x'+'1'.repeat(40);
  const held = JSON.stringify({AAPL:{token,shares:2}});
  const ok = {...base,shares:held,basis_json:JSON.stringify([{symbol:'AAPL',qty_raw:'2000000000000000000',cost_usdg:'100000000'}])};
  assert.equal(paperCheckpointRejection(ok),null);
  assert.equal(validPaperCheckpoint(ok),true,'the boolean wrapper still agrees');

  assert.match(paperCheckpointRejection({...ok,cash_usdg:-1})!,/cash is -1/);
  assert.match(paperCheckpointRejection({...ok,basis_json:'[]'})!,/AAPL is held with no paper cost basis/);
  assert.match(
    paperCheckpointRejection({...ok,basis_json:JSON.stringify([{symbol:'AAPL',qty_raw:'1000000000000000000',cost_usdg:'100000000'}])})!,
    /AAPL basis 1000000000000000000 raw disagrees with 2 shares/,
  );
  assert.match(paperCheckpointRejection({...ok,shares:'{'})!,/unreadable/);
  assert.match(paperCheckpointRejection({...ok,shares:'[]'})!,/shares is not an object/);
  assert.match(paperCheckpointRejection({...ok,shares:JSON.stringify({AAPL:{token:'nope',shares:2}})})!,/no usable token address/);
  assert.match(
    paperCheckpointRejection({...ok,basis_json:JSON.stringify([
      {symbol:'AAPL',qty_raw:'2000000000000000000',cost_usdg:'100000000'},
      {symbol:'MSFT',qty_raw:'5000000000000000000',cost_usdg:'1'},
    ])})!,
    /MSFT has basis for 5000000000000000000 raw but is not held/,
  );
});
