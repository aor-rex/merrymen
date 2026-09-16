/**
 * GIVING A REBUILT CHILD BACK THE COST BASIS IT ALREADY EARNED.
 *
 * A child's ledger lives in its container's own sqlite and `railway.json`
 * declares no volume for it, so every redeploy destroys `cost_basis`. The
 * mirror carries it UP to shared Postgres and nothing ever carries it back, so
 * after a redeploy a position bought last week sells with no basis at all:
 * `applyFill` reports `basisUnknown` — correctly, for a sell with nothing on
 * the books — and the realised P&L is dropped.
 *
 * `restoreClassCostBasis` already solves this for CLASS positions by
 * re-deriving them from the vault's own `ClassBuy` events. An ordinary swap has
 * no such event to read: the cost was only ever known to the ledger. So the
 * ledger is where it has to come back from.
 *
 * ONLY INTO AN EMPTY TABLE, and that is the whole safety argument. A child that
 * still holds its own rows is the authority on its own book — it may have
 * booked fills the mirror has not collected yet, and overwriting those with an
 * older shared snapshot would lose them. A rebuilt child has nothing to lose,
 * which is exactly when this runs.
 *
 * NOT A SECOND SOURCE OF TRUTH. This copies what the mirror copied up; it never
 * invents a figure. If shared has no row either, the basis stays unknown and
 * the sell still reports `basisUnknown` — which is the honest answer, and the
 * one thing that must never be replaced by a confident zero.
 */

/** One position's cost, exactly as both sides store it. */
export interface BasisSeedRow {
  mode: string;
  symbol: string;
  qtyRaw: string;
  costUsdg: string;
}

export interface BasisSeedPlan {
  /** Rows to write into the child. Empty when the child already has its own. */
  rows: BasisSeedRow[];
  /** Why nothing is being written, for the operator log. Null when seeding. */
  skipped: string | null;
}

/**
 * Decide what to seed.
 *
 * Pure so the decision can be tested without a database — the two facts that
 * matter are "does the child already have rows" and "what does shared hold".
 */
export function planBasisSeed(args: {
  /** How many `cost_basis` rows the CHILD currently holds. */
  childRowCount: number;
  /** What SHARED holds for this agent. */
  shared: readonly BasisSeedRow[];
  /**
   * Symbols the shared ledger still shows a NON-ZERO POSITION in.
   *
   * WITHOUT THIS THE SEED RESURRECTS SOLD POSITIONS. The shared `cost_basis`
   * copy goes stale in one specific way: the mirror skips its own
   * `DELETE FROM cost_basis` while the child reads `rebuilt`, so a basis the
   * child consumed on a sell can still be sitting in shared. Restoring it would
   * hand the next buy a cost it never paid and make the next sell report a loss
   * that already happened — the very thing the stranded sweep exists to prevent.
   *
   * So a cost is only restored for something the book still says is held.
   * Omitted means "no position list available", and then nothing is seeded:
   * an unknown holding set is not a licence to restore costs.
   */
  heldSymbols?: readonly string[];
}): BasisSeedPlan {
  if (args.childRowCount > 0) {
    // The child is the authority on its own book. It may hold fills the mirror
    // has not collected, and an older shared snapshot would overwrite them.
    return { rows: [], skipped: `child already holds ${args.childRowCount} basis row(s)` };
  }
  if (args.shared.length === 0) {
    return { rows: [], skipped: "shared ledger holds no basis for this account" };
  }
  // A ZERO ROW IS NOT A BASIS. `setBasis` deletes at zero rather than storing
  // one, so a zero here would be a row the child itself would never have
  // written — and it would read as a tracked position with no cost, which is a
  // different and worse claim than "unknown".
  const held = new Set(args.heldSymbols ?? []);
  if (held.size === 0) {
    return { rows: [], skipped: "no held position on record — nothing to restore a cost for" };
  }
  const rows = args.shared.filter((r) => {
    if (!held.has(r.symbol)) return false;
    try {
      return BigInt(r.qtyRaw) > 0n;
    } catch {
      return false;
    }
  });
  if (rows.length === 0) {
    return { rows: [], skipped: "no shared basis row matches a currently-held position" };
  }
  return { rows, skipped: null };
}

/** The operator line, so a restored book is visible rather than inferred. */
export function basisSeedLine(tenant: string, plan: BasisSeedPlan): string {
  if (plan.skipped !== null) return `basis seed: ${tenant} — ${plan.skipped}`;
  const what = plan.rows.map((r) => `${r.symbol}=${r.costUsdg}`).join(", ");
  return `basis seed: ${tenant} — restored ${plan.rows.length} cost basis row(s) from the shared ledger (${what})`;
}
