/**
 * DELETE A `class_positions` ROW THAT WAS NEVER A POSITION — AND NOTHING ELSE.
 *
 * A `Swept` of leftover vault cash carries USDG as its token, so the reconciler
 * offered it as a candidate, found a balance with no `ClassBuy` behind it, and
 * recorded it `recovered`. Shogun's shared ledger carries exactly one such row.
 * The producer is fixed and the child's copy is gone with its sqlite, but the
 * mirror skips `DELETE FROM class_positions` while the child reads `rebuilt`,
 * so the shared copy would stand indefinitely.
 *
 * WHY THIS IS THE MOST DANGEROUS KIND OF TOOL. `recovered` is also the state of
 * a REAL held token whose tape could not be explained — money the owner owns,
 * sitting in a vault, which a careless predicate would erase the record of. So
 * the rule here is not "delete recovered rows with odd-looking columns". It is:
 * delete only rows that COULD NOT POSSIBLY be a position, and report anything
 * that merely resembles one.
 *
 * FOUR CLAUSES, ALL REQUIRED, each ruling out a different way of being wrong:
 *
 *   token is the quote asset   The decisive one. A memecoin's address is not
 *                              the USDG contract, and a curve does not quote a
 *                              token in itself. Address-keyed — a launch token
 *                              may CALL itself USDG and must be kept.
 *   curve IS NULL              Every real position records the curve it was
 *                              bought on; without one no exit can be built.
 *   entry_tx IS NULL           It never had a `ClassBuy`. A bought position has
 *                              the transaction that bought it.
 *   cost_usdg IS NULL          Nothing was ever paid for it.
 *
 * Any one of those failing means the row is not provably cash, and this REFUSES
 * it and says which clause held it back. A refusal is cheap; a wrong delete is
 * a position the owner can no longer see.
 */

/** One row as the shared ledger holds it. Strings, because that is what pg returns. */
export interface CashRowCandidate {
  agentId: string;
  token: string;
  symbol: string | null;
  quoteToken: string | null;
  state: string | null;
  curve: string | null;
  entryTx: string | null;
  costUsdg: string | null;
}

export interface CashRowVerdict {
  row: CashRowCandidate;
  /** True only when every clause holds. */
  deletable: boolean;
  /** Why not, clause by clause. Empty when deletable. */
  blockedBy: string[];
}

export interface CashRowPlan {
  tenant: string;
  /** Rows that are provably the vault's cash. */
  deletable: CashRowVerdict[];
  /** Rows that looked like cash on the token test but failed a later clause. */
  refused: CashRowVerdict[];
  /** Every other row, untouched and uncounted. */
  untouched: number;
}

/**
 * Is this row the quote asset?
 *
 * Kept separate from the plan so the two tests read as what they are: an
 * IDENTITY question (is this cash) and a PROVENANCE question (could it ever
 * have been bought). A row can be cash and still not be safe to delete.
 */
function isCashToken(r: CashRowCandidate, cashToken: string): boolean {
  const t = r.token.toLowerCase();
  if (t === cashToken.toLowerCase()) return true;
  return r.quoteToken !== null && t === r.quoteToken.toLowerCase();
}

export function judgeCashRow(r: CashRowCandidate, cashToken: string): CashRowVerdict {
  const blockedBy: string[] = [];
  if (!isCashToken(r, cashToken)) {
    // Not even a candidate. Reported as blocked rather than silently skipped so
    // a plan can never be read as "these were the only rows considered".
    blockedBy.push("token is not the quote asset");
    return { row: r, deletable: false, blockedBy };
  }
  if (r.curve !== null) blockedBy.push(`curve is recorded (${r.curve}) — a real position has one`);
  if (r.entryTx !== null) blockedBy.push(`entry_tx is recorded (${r.entryTx}) — something bought this`);
  if (r.costUsdg !== null) blockedBy.push(`cost_usdg is recorded (${r.costUsdg}) — something was paid`);
  return { row: r, deletable: blockedBy.length === 0, blockedBy };
}

/**
 * ONE TENANT, NAMED. There is no fleet mode and there should not be one: a tool
 * that can delete rows across every owner at once is a different and much
 * larger thing to leave armed by accident.
 */
export function planCashRowRepair(
  tenant: string,
  rows: readonly CashRowCandidate[],
  cashToken: string,
): CashRowPlan {
  const deletable: CashRowVerdict[] = [];
  const refused: CashRowVerdict[] = [];
  let untouched = 0;
  for (const r of rows) {
    const v = judgeCashRow(r, cashToken);
    if (v.deletable) deletable.push(v);
    else if (v.blockedBy[0] === "token is not the quote asset") untouched += 1;
    else refused.push(v);
  }
  return { tenant, deletable, refused, untouched };
}

const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-4)}`;

export function cashRowRepairLines(plan: CashRowPlan, mode: "report" | "apply"): string[] {
  const out: string[] = [
    `class-cash-row: tenant ${plan.tenant} — ${mode.toUpperCase()}`,
    `  ${plan.untouched} row(s) are ordinary positions and were not considered`,
  ];
  if (plan.deletable.length === 0) {
    out.push(`  nothing to delete — no provable quote-token row`);
  }
  for (const v of plan.deletable) {
    out.push(
      `  ${mode === "apply" ? "DELETING" : "would delete"} ${short(v.row.token)} ` +
        `state=${v.row.state ?? "(null)"} symbol=${v.row.symbol ?? "(none)"} ` +
        `— no curve, no entry tx, no cost: this is the vault's cash`,
    );
  }
  for (const v of plan.refused) {
    out.push(`  REFUSING ${short(v.row.token)} state=${v.row.state ?? "(null)"} — ${v.blockedBy.join("; ")}`);
  }
  if (mode === "report") out.push(`  nothing was written.`);
  return out;
}
