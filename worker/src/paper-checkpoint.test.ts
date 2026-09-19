import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from "./db";
import { mirrorPaperCheckpoints, restorePaperCheckpoint } from "./paper-checkpoint";

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
