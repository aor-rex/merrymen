import type { Db } from "./db";

export const PAPER_CHECKPOINT_SCHEMA = `CREATE TABLE IF NOT EXISTS paper_checkpoints (
  agent_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, cash_usdg REAL NOT NULL,
  vault_usdg REAL NOT NULL, hwm_usdg REAL NOT NULL, shares TEXT NOT NULL,
  basis_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);`;

export async function recordPaperRecoveryHealth(db:Db,account:string,blocked:boolean):Promise<void> {
  await db.exec(`CREATE TABLE IF NOT EXISTS paper_recovery_health (
    agent_id TEXT PRIMARY KEY, blocked INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`);
  await db.prepare(`INSERT INTO paper_recovery_health(agent_id,blocked,updated_at) VALUES(?,?,?)
    ON CONFLICT(agent_id) DO UPDATE SET blocked=excluded.blocked,updated_at=excluded.updated_at`)
    .run(account.toLowerCase(),blocked?1:0,Math.floor(Date.now()/1000));
}

type Checkpoint = {agent_id:string; epoch:number; cash_usdg:number; vault_usdg:number; hwm_usdg:number; shares:string; basis_json:string; updated_at:number};
type Basis = {symbol:string; qty_raw:string; cost_usdg:string};

export function validPaperCheckpoint(row: Checkpoint): boolean {
  try {
    if (![row.cash_usdg,row.vault_usdg,row.hwm_usdg].every(v=>Number.isFinite(Number(v)) && Number(v)>=0)) return false;
    const shares = JSON.parse(row.shares) as Record<string,{token:string;shares:number}>;
    const basis = JSON.parse(row.basis_json) as Basis[];
    if (!shares || Array.isArray(shares) || !Array.isArray(basis)) return false;
    for (const [symbol,p] of Object.entries(shares)) {
      if (!/^0x[0-9a-f]{40}$/i.test(p.token) || !Number.isFinite(p.shares) || p.shares<=0) return false;
      const b = basis.find(b=>b.symbol===symbol);
      // A snapshot between cash/book and basis writes must not become a restore point.
      if (!b || BigInt(b.cost_usdg)<0n || Math.abs(Number(b.qty_raw)/1e18-p.shares)>1e-6) return false;
    }
    return basis.every(b=>BigInt(b.qty_raw)>=0n && BigInt(b.cost_usdg)>=0n && (shares[b.symbol] || BigInt(b.qty_raw)===0n));
  } catch { return false; }
}

export async function mirrorPaperCheckpoints(child:Db, shared:Db): Promise<number> {
  if (!await child.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='paper_book'").get()) return 0;
  await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  const snapshots = await child.tx(async db => {
    const books = await db.prepare(`SELECT p.*, a.epoch FROM paper_book p JOIN agents a ON LOWER(a.smart_account)=LOWER(p.agent_id)`).all() as Checkpoint[];
    for (const book of books) book.basis_json = JSON.stringify(await db.prepare(`SELECT symbol, qty_raw, cost_usdg FROM cost_basis WHERE agent_id=? AND mode='paper'`).all(book.agent_id));
    return books;
  });
  let count=0;
  for(const b of snapshots) {
    if (!validPaperCheckpoint(b)) continue;
    await shared.prepare(`INSERT INTO paper_checkpoints(agent_id,epoch,cash_usdg,vault_usdg,hwm_usdg,shares,basis_json,updated_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(agent_id) DO UPDATE SET epoch=excluded.epoch,cash_usdg=excluded.cash_usdg,
      vault_usdg=excluded.vault_usdg,hwm_usdg=excluded.hwm_usdg,shares=excluded.shares,basis_json=excluded.basis_json,updated_at=excluded.updated_at
      WHERE excluded.epoch > paper_checkpoints.epoch OR (excluded.epoch=paper_checkpoints.epoch AND excluded.updated_at>=paper_checkpoints.updated_at)`)
      .run(b.agent_id,b.epoch,b.cash_usdg,b.vault_usdg,b.hwm_usdg,b.shares,b.basis_json,b.updated_at);
    count++;
  }
  return count;
}

/** Restore only an empty local book, including its matching basis. */
export async function restorePaperCheckpoint(child:Db, shared:Db, account:string):Promise<string> {
  if (await child.prepare("SELECT agent_id FROM paper_book WHERE LOWER(agent_id)=LOWER(?)").get(account)) return 'local book retained';
  await shared.exec(PAPER_CHECKPOINT_SCHEMA);
  let row = await shared.prepare(`SELECT p.* FROM paper_checkpoints p JOIN agents a ON LOWER(a.smart_account)=LOWER(p.agent_id)
    WHERE LOWER(p.agent_id)=LOWER(?) AND p.epoch=a.epoch`).get(account) as Checkpoint | undefined;
  if (!row) {
    // Upgrade path: recover a fully reconciled recorded valuation. Never take
    // today's on-chain cash or a configured seed as the old paper bankroll.
    const mark = await shared.prepare(`SELECT e.* FROM equity e JOIN agents a ON LOWER(a.smart_account)=LOWER(e.agent_id) AND a.epoch=e.epoch
      WHERE LOWER(e.agent_id)=LOWER(?) ORDER BY e.at DESC,e.id DESC LIMIT 1`).get(account) as Record<string,unknown> | undefined;
    if (!mark || mark.mode !== 'paper') return 'no durable checkpoint';
    const later = await shared.prepare(`SELECT COUNT(*) AS n FROM trades WHERE LOWER(agent_id)=LOWER(?) AND epoch=? AND status='paper' AND created_at>=?`)
      .get(account,Number(mark.epoch),Number(mark.at)) as {n:number};
    if (Number(later.n)>0) throw new Error('paper fills are newer than the recoverable valuation');
    const positions = await shared.prepare(`SELECT symbol,token,raw_balance,value_usdg FROM positions WHERE LOWER(agent_id)=LOWER(?)`).all(account) as Record<string,unknown>[];
    const value = positions.reduce((sum,p)=>sum+Number(p.value_usdg),0);
    if (!Number.isFinite(value) || Math.abs(value-Number(mark.positions_usdg))>0.00001 || Math.abs(Number(mark.cash_usdg)+Number(mark.vault_usdg)+value-Number(mark.equity_usdg))>0.00001) throw new Error(`paper valuation does not reconcile (positions=${positions.length}, snapshotDelta=${value-Number(mark.positions_usdg)}, equityDelta=${Number(mark.cash_usdg)+Number(mark.vault_usdg)+value-Number(mark.equity_usdg)})`);
    const shares=Object.fromEntries(positions.filter(p=>BigInt(String(p.raw_balance))>0n).map(p=>[String(p.symbol),{token:String(p.token),shares:Number(p.raw_balance)/1e18}]));
    const basis=await shared.prepare(`SELECT symbol,qty_raw,cost_usdg FROM cost_basis WHERE LOWER(agent_id)=LOWER(?) AND mode='paper'`).all(account) as Basis[];
    const peak=await shared.prepare(`SELECT MAX(equity_usdg) AS peak FROM equity WHERE LOWER(agent_id)=LOWER(?) AND epoch=? AND mode='paper'`).get(account,Number(mark.epoch)) as {peak:number};
    row={agent_id:account,epoch:Number(mark.epoch),cash_usdg:Number(mark.cash_usdg),vault_usdg:Number(mark.vault_usdg),hwm_usdg:Math.max(Number(mark.equity_usdg),Number(peak.peak)),shares:JSON.stringify(shares),basis_json:JSON.stringify(basis.filter(b=>shares[b.symbol])),updated_at:Number(mark.at)};
  }
  if (!validPaperCheckpoint(row)) throw new Error('invalid paper checkpoint');
  await child.tx(async db=>{
    await db.prepare(`INSERT INTO paper_book(agent_id,cash_usdg,vault_usdg,hwm_usdg,shares,updated_at) VALUES(?,?,?,?,?,?)`)
      .run(account,row.cash_usdg,row.vault_usdg,row.hwm_usdg,row.shares,row.updated_at);
    await db.prepare("DELETE FROM cost_basis WHERE agent_id=? AND mode='paper'").run(account);
    for(const b of JSON.parse(row.basis_json) as Basis[]) await db.prepare(`INSERT INTO cost_basis(agent_id,mode,symbol,qty_raw,cost_usdg,updated_at) VALUES(?,'paper',?,?,?,?)`)
      .run(account,b.symbol,b.qty_raw,b.cost_usdg,row.updated_at);
  });
  return 'paper cash, holdings and basis restored';
}
