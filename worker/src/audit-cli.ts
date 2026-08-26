/**
 * `merrymen export` and `merrymen verify` — the two commands that make the
 * README's "verifiable, not claimed" true rather than aspirational.
 *
 * The pair is meant to be used by someone who does not trust the operator:
 *
 *   merrymen export > ledger.jsonl        # run by the operator
 *   merrymen verify ledger.jsonl          # run by anyone, anywhere
 *
 * `verify` deliberately reads NOTHING but the file it is handed. It does not
 * open ~/.merrymen, does not consult settings, and does not care which machine
 * produced the export — otherwise it would only be checking the operator's
 * ledger against itself, which proves nothing.
 */

import { readFileSync } from "node:fs";
import { getAgentEpoch, readJournal, type JournalEntry } from "./store";
import {
  compareRecord,
  reconcile,
  reconstruct,
  verifyChain,
  type AuditFinding,
  type ExportedEntry,
  type FetchedReceipt,
} from "./audit";
import { gasQualifier, pnlUsdg } from "./equity";

const args = process.argv.slice(2);
const cmd = args[0];

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Whose ledger to export. One agent per install, so the armed one, else newest. */
async function resolveAgent(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const { DatabaseSync } = await import("node:sqlite");
  const { homePaths } = await import("./home");
  const db = new DatabaseSync(homePaths.db(), { readOnly: true });
  try {
    const row = db
      .prepare(
        `SELECT smart_account FROM agents
          ORDER BY (status = 'armed') DESC, created_at DESC, rowid DESC LIMIT 1`,
      )
      .get() as { smart_account: string } | undefined;
    if (!row?.smart_account) fail("no agent in the ledger — nothing to export.");
    return row.smart_account;
  } finally {
    db.close();
  }
}

/** The chain and cash token this ledger is about — recorded in the export header. */
async function exportContext(agentId: string): Promise<{ chainId: number | null; usdgToken: string }> {
  const { CASH } = await import("../../packages/core/src/index");
  const { DatabaseSync } = await import("node:sqlite");
  const { homePaths } = await import("./home");
  let chainId: number | null = null;
  try {
    const db = new DatabaseSync(homePaths.db(), { readOnly: true });
    const row = db
      .prepare("SELECT chain_id FROM agents WHERE smart_account = ?")
      .get(agentId) as { chain_id: number } | undefined;
    chainId = row?.chain_id ?? null;
    db.close();
  } catch {
    /* the export is still valid without it; the verifier says what is missing */
  }
  return { chainId, usdgToken: String(CASH.USDG) };
}

async function doExport(): Promise<void> {
  const agentFlag = args.indexOf("--agent");
  const epochFlag = args.indexOf("--epoch");
  const agentId = await resolveAgent(agentFlag >= 0 ? args[agentFlag + 1] : undefined);
  const epoch = epochFlag >= 0 ? Number(args[epochFlag + 1]) : await getAgentEpoch(agentId);
  if (!Number.isInteger(epoch) || epoch < 1) fail(`bad --epoch: ${args[epochFlag + 1]}`);

  const entries = await readJournal(agentId, epoch);
  // A header line, so the file says what it is and a verifier can refuse a file
  // it doesn't understand rather than guessing.
  //
  // It also carries what an on-chain check NEEDS: whose account to measure
  // movements for, which chain, and which token is cash. Without those the
  // verifier would have to be told them out of band — and anything the auditor
  // has to be told separately is something the operator gets to choose.
  const { chainId, usdgToken } = await exportContext(agentId);
  process.stdout.write(
    JSON.stringify({
      format: "merrymen-journal",
      version: 1,
      agentId,
      epoch,
      chainId,
      usdgToken,
      records: entries.length,
    }) + "\n",
  );
  for (const e of entries) process.stdout.write(JSON.stringify(e) + "\n");
  if (entries.length === 0) {
    console.error(
      `\n(no journal records for epoch ${epoch}. Rows written before the audit trail existed are ` +
        `epoch 1 and are deliberately not exportable — they cannot be verified, so presenting them ` +
        `as an audit would be dishonest.)`,
    );
  }
}

function readExport(file: string): { header: Record<string, unknown>; entries: ExportedEntry[] } {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return fail(`cannot read ${file}`);
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) fail(`${file} is empty`);
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]!) as Record<string, unknown>;
  } catch {
    return fail(`${file}: first line is not the export header`);
  }
  if (header.format !== "merrymen-journal") fail(`${file}: not a merrymen journal export`);
  const entries: ExportedEntry[] = [];
  for (let i = 1; i < lines.length; i++) {
    try {
      entries.push(JSON.parse(lines[i]!) as ExportedEntry);
    } catch {
      fail(`${file}: line ${i + 1} is not valid JSON`);
    }
  }
  return { header, entries };
}

/**
 * Minimal JSON-RPC. Deliberately plain `fetch` rather than a library: a
 * verifier should be small enough that someone can read it and believe it,
 * and `eth_getTransactionReceipt` needs nothing more.
 */
async function rpcCall(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "RPC error");
  return body.result ?? null;
}

async function doVerify(): Promise<void> {
  const file = args[1];
  if (!file) fail("usage: merrymen verify <ledger.jsonl> [--rpc <url>]");
  const { header, entries } = readExport(file);

  console.log(`\n  merrymen ledger — agent ${header.agentId}, epoch ${header.epoch}`);
  console.log(`  ${entries.length} record(s)\n`);

  // ── 1. tamper evidence ────────────────────────────────────────────────
  const findings = verifyChain(entries);
  if (findings.length === 0) {
    console.log("  ✓ hash chain intact — no record was edited, and none is missing");
  } else {
    console.log(`  ✗ ${findings.length} problem(s) with the record itself:`);
    for (const f of findings) console.log(`      [${f.check}] seq ${f.seq ?? "?"}: ${f.detail}`);
  }

  // ── 2. what the arithmetic says ───────────────────────────────────────
  const book = reconstruct(entries);
  const r = reconcile(book);
  console.log("");
  console.log(`  contributed:  ${book.netContributionsUsdg.toFixed(2)} USDG`);
  console.log(`  realized P&L: ${book.realizedPnlUsdg.toFixed(2)} USDG (gross of gas)`);
  console.log(
    `  gas paid:     ${(Number(book.gasWei) / 1e18).toFixed(6)} ETH = ${book.gasUsdg.toFixed(2)} USDG` +
      (book.gasUnpricedFills > 0 ? ` (+ ${book.gasUnpricedFills} fill(s) whose gas is UNPRICED)` : ""),
  );
  if (book.publishedEquityUsdg !== null) {
    console.log(`  equity:       ${book.publishedEquityUsdg.toFixed(2)} USDG (as published)`);
    const net = pnlUsdg(book.publishedEquityUsdg, book.netContributionsUsdg, book.gasUsdg);
    console.log(
      `  P&L net:      ${net?.toFixed(2) ?? "—"} USDG — ` +
        gasQualifier({ usdg: book.gasUsdg, unpricedTrades: book.gasUnpricedFills }),
    );
    console.log(`  residual:     ${r.residualUsdg?.toFixed(2) ?? "—"} USDG — unrealized on open positions`);
  }

  // ── 3. the chain of custody ───────────────────────────────────────────
  console.log("");
  const rpcFlag = args.indexOf("--rpc");
  const rpcUrl = rpcFlag >= 0 ? args[rpcFlag + 1] : undefined;
  const onchain: AuditFinding[] = [];
  let unreachable = 0;

  if (!rpcUrl) {
    console.log(`  ${book.chainRefs.length} record(s) name a transaction and can be checked on-chain`);
    console.log(`    Pass --rpc <url> to actually refetch them.`);
  } else {
    const account = String(header.agentId ?? "");
    const usdgToken = String(header.usdgToken ?? "");
    if (!account || !usdgToken) {
      // An older export predates the header carrying what a check needs. Say
      // which field is missing rather than silently checking nothing.
      console.log(`  ! this export has no ${!account ? "agentId" : "usdgToken"} in its header — cannot check on-chain`);
    } else {
      console.log(`  checking ${book.chainRefs.length} transaction(s) against ${new URL(rpcUrl).host}…`);
      const byTx = new Map(entries.map((e) => [e.seq, e]));
      let checked = 0;
      for (const ref of book.chainRefs) {
        const entry = byTx.get(ref.seq);
        if (!entry) continue;
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(entry.payload_json) as Record<string, unknown>;
        } catch {
          continue;
        }
        let receipt: FetchedReceipt | null = null;
        try {
          receipt = (await rpcCall(rpcUrl, "eth_getTransactionReceipt", [ref.txHash])) as FetchedReceipt | null;
        } catch (e) {
          // A network failure is NOT a verification failure. Conflating the two
          // would let a flaky RPC condemn an honest ledger, or a hostile one
          // launder a dishonest ledger into "couldn't check".
          console.log(`      seq ${ref.seq}: RPC error — ${e instanceof Error ? e.message : String(e)} (not checked)`);
          continue;
        }
        checked++;
        onchain.push(
          ...compareRecord({ seq: ref.seq, kind: entry.kind, payload, receipt, account, usdgToken }),
        );
      }
      if (onchain.length > 0) {
        console.log(`  ✗ ${onchain.length} record(s) disagree with the chain:`);
        for (const f of onchain) console.log(`      seq ${f.seq}: ${f.detail}`);
      } else if (checked > 0) {
        console.log(`  ✓ ${checked} transaction(s) match the chain — amounts and direction confirmed`);
      }
      if (checked < book.chainRefs.length) {
        // NEVER a green tick for work that did not happen. A verifier whose
        // failure mode is a pass is worse than no verifier, because it launders
        // "we couldn't look" into "we looked and it was fine".
        unreachable = book.chainRefs.length - checked;
        console.log(`  ! ${unreachable} of ${book.chainRefs.length} could not be fetched — UNKNOWN, not verified`);
      }
    }
  }

  if (book.unanchored.length) {
    console.log("");
    console.log(`  ${book.unanchored.length} record(s) CANNOT be checked against any chain:`);
    for (const u of book.unanchored.slice(0, 10)) {
      console.log(`      seq ${u.seq} (${u.kind}): ${u.why}`);
    }
    if (book.unanchored.length > 10) console.log(`      … and ${book.unanchored.length - 10} more`);
    console.log(`    Drop these and recompute if you want a chain-verifiable figure only.`);
  }

  console.log("");
  // Exit 0 means CHECKED AND SOUND. An unreachable RPC is neither, so it is
  // not a pass — the caller asked for an on-chain check and did not get one.
  const clean = findings.length === 0 && onchain.length === 0 && unreachable === 0;
  if (!clean && findings.length === 0 && onchain.length === 0) {
    console.log('  verdict: INDETERMINATE — the record is internally sound but could not be checked against the chain.');
  }
  process.exit(clean ? 0 : 1);
}

if (cmd === "export") {
  await doExport();
} else if (cmd === "verify") {
  await doVerify();
} else {
  fail("usage: audit-cli <export|verify> …");
}

export type { JournalEntry };
