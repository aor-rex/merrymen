/**
 * TURN THE CLASS ROUTE ON FOR ONE NAMED TENANT, AND NOTHING ELSE.
 *
 * The settings store lives in a Postgres reachable only from inside Railway, so
 * there is no way to set these from an operator's machine. This is the same
 * shape the consent migration used: gated on a variable naming ONE tenant, run
 * once per process, and reported in full before and after.
 *
 * IT MERGES, IT DOES NOT REPLACE. `put` writes the whole blob, so a naive write
 * would silently erase every setting the owner has — including the ones they
 * chose deliberately. Dave's `maxImpactBps: 500` and `slippageBps: 200` are the
 * live example: they are his, they are looser than the defaults, and nothing
 * here may touch them.
 *
 * IT TOUCHES ONLY THE CANARY FIELDS. Not `liveTradingEnabled`, not
 * `paperTradingEnabled`, not the strategy, not the basket — and not the signed
 * caps, which live in the grant where no setting can reach them at all.
 */

/** Exactly the fields this writer sets. Anything absent is left as the owner had it. */
export interface CanarySettings {
  classSnipeEnabled: boolean;
  classPerEntryUsdg: number;
  classMaxPositions: number;
  scoutEnabled: boolean;
  scoutBudgetUsdg: number;
  classMinDepthUsdg: number;
  classMaxHoldSec: number;
  classExitAtGraduationPct: number;
}

/**
 * The canary configuration.
 *
 * `classMaxHoldSec` and `classExitAtGraduationPct` are written at their NORMAL
 * values rather than omitted, so the record says plainly that they were not
 * shortened — a canary whose hold timer was trimmed to finish sooner proves
 * nothing about the exit that matters.
 *
 * `scoutBudgetUsdg` is 15 because `classMaxPositions` is 3 at
 * `classPerEntryUsdg` 5: a smaller budget silently caps the position count below
 * what the other settings claim, and `scoutAllows` refuses at 0 outright, so
 * leaving it unset would make the whole route inert while looking configured.
 */
export const CANARY: CanarySettings = Object.freeze({
  classSnipeEnabled: true,
  classPerEntryUsdg: 5,
  classMaxPositions: 3,
  scoutEnabled: true,
  scoutBudgetUsdg: 15,
  classMinDepthUsdg: 250,
  classMaxHoldSec: 6 * 3600,
  classExitAtGraduationPct: 85,
});

/**
 * What to write: the owner's settings with exactly the canary fields replaced.
 *
 * Pure, so the merge is testable without a store — and the merge is the whole
 * risk here. A write that dropped a field would be invisible until the setting
 * it dropped was the one that mattered.
 */
export function mergeCanary(
  current: Record<string, unknown> | null,
  values: CanarySettings = CANARY,
): Record<string, unknown> {
  return { ...(current ?? {}), ...values };
}

/** What changed, for the operator line. Unchanged fields are not reported. */
export function describeCanaryChange(
  current: Record<string, unknown> | null,
  values: CanarySettings = CANARY,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    const before = current?.[k];
    out.push(
      before === undefined
        ? `  ${k.padEnd(26)} (unset) -> ${JSON.stringify(v)}`
        : before === v
          ? `  ${k.padEnd(26)} ${JSON.stringify(v)} (unchanged)`
          : `  ${k.padEnd(26)} ${JSON.stringify(before)} -> ${JSON.stringify(v)}`,
    );
  }
  return out;
}

/**
 * Fields this writer must never touch, named so a test can prove it.
 *
 * Not a runtime filter — `mergeCanary` only ever spreads CANARY's own keys, so
 * the guarantee is structural. This list exists so the TEST can assert the
 * structure holds for the fields that would hurt most if it did not.
 */
export const MUST_PRESERVE = [
  "maxImpactBps",
  "slippageBps",
  "liveTradingEnabled",
  "paperTradingEnabled",
  "strategy",
  "basketSymbols",
  "customTokens",
  "telegramBotToken",
  "assetMode",
] as const;

/**
 * STOP NEW ENTRIES. LEAVE EVERY EXIT ALONE.
 *
 * `classSnipeEnabled` gates `proposeClassEntries` and nothing else — the exit
 * path reads `classMaxHoldSec` and `classExitAtGraduationPct` and never consults
 * it, which is why an agent holding a position keeps managing it after entries
 * are switched off. That asymmetry is the whole reason this is safe to do to a
 * tenant with money in the market, and the reason it is one field rather than a
 * "pause the route" flag that would take the exit with it.
 *
 * ONE FIELD. Not `liveTradingEnabled` (which would stop the sell), not
 * `classMaxPositions` (0 would read as a configuration the owner chose), not
 * `scoutEnabled` (the budget is also what an exit reports against). Anything
 * broader here silently strands a live position in a book that can no longer
 * close it, which is the trap `merrymen`'s class route was built to avoid.
 */
export const HALT_ENTRIES = Object.freeze({ classSnipeEnabled: false });

/** The owner's settings with entries switched off and nothing else changed. */
export function mergeHaltEntries(
  current: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...(current ?? {}), ...HALT_ENTRIES };
}

/**
 * Fields that MUST survive an entries-halt, named so a test can prove it.
 *
 * The first two are the exit triggers and the third is the rail the sell rides
 * on. If any of them moved, the halt would not be a halt — it would be a
 * position nobody can get out of.
 */
export const HALT_MUST_PRESERVE = [
  "classMaxHoldSec",
  "classExitAtGraduationPct",
  "liveTradingEnabled",
  "classPerEntryUsdg",
  "classMaxPositions",
  "scoutEnabled",
  "scoutBudgetUsdg",
  "maxImpactBps",
  "slippageBps",
  "assetMode",
] as const;

/**
 * TURN NEW ENTRIES BACK ON. THE EXACT INVERSE OF `HALT_ENTRIES`, AND NOTHING MORE.
 *
 * Deliberately not `CANARY`. That writes eight fields, and re-running it to flip
 * one would restate the owner's hold window and graduation cliff as a side
 * effect — values somebody may have tuned since. Resuming is one field because
 * halting was one field, and the pair has to be symmetric or the round trip
 * through them is not a round trip.
 */
export const RESUME_ENTRIES = Object.freeze({ classSnipeEnabled: true });

/** The owner's settings with entries switched back on and nothing else changed. */
export function mergeResumeEntries(
  current: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...(current ?? {}), ...RESUME_ENTRIES };
}
