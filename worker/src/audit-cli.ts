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
import { reconcile, reconstruct, verifyChain, type ExportedEntry } from "./audit";

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

async function doExport(): Promise<void> {
  const agentFlag = args.indexOf("--agent");
  const epochFlag = args.indexOf("--epoch");
  const agentId = await resolveAgent(agentFlag >= 0 ? args[agentFlag + 1] : undefined);
  const epoch = epochFlag >= 0 ? Number(args[epochFlag + 1]) : await getAgentEpoch(agentId);
  if (!Number.isInteger(epoch) || epoch < 1) fail(`bad --epoch: ${args[epochFlag + 1]}`);

  const entries = await readJournal(agentId, epoch);
  // A header line, so the file says what it is and a verifier can refuse a file
  // it doesn't understand rather than guessing.
  process.stdout.write(
    JSON.stringify({ format: "merrymen-journal", version: 1, agentId, epoch, records: entries.length }) + "\n",
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

function doVerify(): void {
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
  console.log(`  realized P&L: ${book.realizedPnlUsdg.toFixed(2)} USDG`);
  console.log(`  gas paid:     ${(Number(book.gasWei) / 1e18).toFixed(6)} ETH (not included in equity)`);
  if (book.publishedEquityUsdg !== null) {
    console.log(`  equity:       ${book.publishedEquityUsdg.toFixed(2)} USDG (as published)`);
    console.log(`  residual:     ${r.residualUsdg?.toFixed(2) ?? "—"} USDG — unrealized on open positions`);
  }

  // ── 3. what can and cannot be checked against a chain ─────────────────
  console.log("");
  console.log(`  ${book.chainRefs.length} record(s) name a transaction and can be checked on-chain`);
  if (book.unanchored.length) {
    console.log(`  ${book.unanchored.length} record(s) CANNOT be checked against any chain:`);
    for (const u of book.unanchored.slice(0, 10)) {
      console.log(`      seq ${u.seq} (${u.kind}): ${u.why}`);
    }
    if (book.unanchored.length > 10) console.log(`      … and ${book.unanchored.length - 10} more`);
    console.log(`    Drop these and recompute if you want a chain-verifiable figure only.`);
  }

  const rpcFlag = args.indexOf("--rpc");
  if (rpcFlag >= 0 && args[rpcFlag + 1]) {
    // Not yet implemented, and SAID so rather than silently skipped — a
    // verifier that quietly does less than it claims is worse than one that
    // does less and admits it.
    console.log("");
    console.log(`  ! --rpc given but on-chain refetch is not implemented yet.`);
    console.log(`    The transactions above are listed so they can be checked by hand meanwhile.`);
  }

  console.log("");
  process.exit(findings.length === 0 ? 0 : 1);
}

if (cmd === "export") {
  await doExport();
} else if (cmd === "verify") {
  doVerify();
} else {
  fail("usage: audit-cli <export|verify> …");
}

export type { JournalEntry };
