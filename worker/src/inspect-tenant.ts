/**
 * ONE TENANT'S CLASS-ROUTE CONFIGURATION, READ AND PRINTED, NOTHING ELSE.
 *
 * WHY THIS EXISTS. The grant and the settings blob live in a Postgres reachable
 * only from inside Railway — `DATABASE_URL` names `postgres.railway.internal`
 * and the service publishes no proxy — so "does this owner's signed wall carry a
 * class vault?" cannot be answered from an operator's machine at all. It was
 * answered by guessing twice before this existed.
 *
 * ZERO WRITES. It opens the stores read-only, reads, formats and returns. There
 * is no code path here that calls `put`, and there is no argument that would
 * make one appear.
 *
 * IT CANNOT PRINT A SECRET, and that is a property of the shape rather than a
 * promise about the author. `describeTenant` takes a FLAT RECORD OF THE FIELDS
 * ASKED FOR — never the settings object — so a bot token, a DEK, a session key,
 * a grant blob or an RPC url is not in scope at the point where strings are
 * built. Handing it `settings` and trusting a formatter to pick carefully is the
 * version of this that leaks the first time somebody adds a field.
 *
 * ONE TENANT, NAMED EXPLICITLY. The caller supplies an address; there is no
 * "all" mode. A diagnostic that can dump the fleet is a different and much
 * larger thing to leave armed by accident.
 */

/** Exactly the fields this diagnostic reports. Nothing else may be passed in. */
export interface TenantFacts {
  tenant: string;
  smartAccount: string | null;
  /** The vault the SIGNATURE sealed, from the grant. Null when none. */
  grantClassVault: string | null;
  /** `vaultFor(smartAccount)` — deterministic, whether or not it was sealed. */
  derivedClassVault: string | null;
  /**
   * Has the vault contract been created?
   *
   * Null when the chain would not answer. Not false — an unread code check and
   * an absent contract are different facts, and this module exists because
   * somebody was about to act on the difference.
   */
  vaultDeployed: boolean | null;
  /** Settings, each null when the tenant has no stored value for it. */
  assetMode: string | null;
  liveTradingEnabled: boolean | null;
  classSnipeEnabled: boolean | null;
  classPerEntryUsdg: number | null;
  classMaxPositions: number | null;
  scoutEnabled: boolean | null;
  scoutBudgetUsdg: number | null;
  scoutPerTokenUsdg: number | null;
  classMinDepthUsdg: number | null;
  maxImpactBps: number | null;
  slippageBps: number | null;
  classMaxHoldSec: number | null;
  classExitAtGraduationPct: number | null;
  /** True when the tenant has no settings row at all. */
  settingsMissing: boolean;
  /** Set when the settings read threw — distinct from "no row". */
  settingsError: string | null;
}

/** The defaults a field falls back to, for reporting only. Never written. */
const DEFAULTS: Record<string, string> = {
  assetMode: '"all"',
  liveTradingEnabled: "false",
  classSnipeEnabled: "false",
  classPerEntryUsdg: "0",
  classMaxPositions: "0",
  scoutEnabled: "false",
  scoutBudgetUsdg: "0",
  scoutPerTokenUsdg: "25",
  classMinDepthUsdg: "250",
  maxImpactBps: "300",
  slippageBps: "100",
  classMaxHoldSec: "21600",
  classExitAtGraduationPct: "85",
};

const SETTING_ORDER = [
  "assetMode",
  "liveTradingEnabled",
  "classSnipeEnabled",
  "classPerEntryUsdg",
  "classMaxPositions",
  "scoutEnabled",
  "scoutBudgetUsdg",
  "scoutPerTokenUsdg",
  "classMinDepthUsdg",
  "maxImpactBps",
  "slippageBps",
  "classMaxHoldSec",
  "classExitAtGraduationPct",
] as const;

const yesNo = (v: boolean | null): string => (v === null ? "UNKNOWN (could not read)" : v ? "YES" : "NO");

/**
 * The report.
 *
 * ABSENT IS REPORTED AS ABSENT, with the default named beside it. A field the
 * owner never set and a field they set TO the default resolve identically at
 * runtime and mean opposite things to somebody deciding what to change — one is
 * a choice and the other is a gap.
 */
export function describeTenant(f: TenantFacts): string[] {
  const lines: string[] = [
    `tenant                        ${f.tenant}`,
    `smartAccount                  ${f.smartAccount ?? "UNKNOWN"}`,
    `grantPonsClassVault(grant)    ${f.grantClassVault ?? "null"}`,
    `derived vaultFor(account)     ${f.derivedClassVault ?? "UNKNOWN"}`,
    ``,
    `class vault sealed in grant:  ${yesNo(f.grantClassVault === null ? false : true)}`,
    `class vault deployed on-chain: ${yesNo(f.vaultDeployed)}`,
    ``,
  ];

  if (f.settingsError !== null) {
    lines.push(`settings UNREADABLE — ${f.settingsError}`);
    lines.push(`(every value below is therefore unknown, NOT default)`);
    return lines;
  }
  if (f.settingsMissing) {
    lines.push(`settings: NO ROW for this tenant — every field below falls to its default`);
  }

  const values = f as unknown as Record<string, unknown>;
  for (const name of SETTING_ORDER) {
    const v = values[name];
    const shown =
      v === null || v === undefined
        ? `(unset) -> default ${DEFAULTS[name] ?? "?"}`
        : JSON.stringify(v);
    lines.push(`${name.padEnd(29)} ${shown}`);
  }

  /**
   * THE ONE DERIVED LINE, because it is the question that gets asked next.
   *
   * A sealed vault is necessary and not sufficient: `proposeClassEntries` also
   * requires the route switched on, a non-zero size, room for another position,
   * and a live rail. Listing the fields without saying which of them is the
   * blocker invites the same guess this module was written to stop.
   */
  const blockers: string[] = [];
  if (f.grantClassVault === null) blockers.push("no class vault sealed in the grant (needs a re-sign)");
  if (f.classSnipeEnabled !== true) blockers.push("classSnipeEnabled is not true");
  if ((f.classPerEntryUsdg ?? 0) <= 0) blockers.push("classPerEntryUsdg is 0");
  if ((f.classMaxPositions ?? 0) <= 0) blockers.push("classMaxPositions is 0");
  if (f.liveTradingEnabled !== true) blockers.push("liveTradingEnabled is not true");
  if (f.assetMode === "stocks") blockers.push('assetMode is "stocks", which excludes the whole route');

  lines.push(``);
  lines.push(
    blockers.length === 0
      ? `class route: every gate this module can see is OPEN`
      : `class route BLOCKED BY: ${blockers.join("; ")}`,
  );
  return lines;
}

/**
 * THE SECOND QUESTION THIS MODULE GETS ASKED: why is the breaker refusing?
 *
 * The drawdown breaker divides by `agents.hwm_usdg` (policy.ts:725-731), and
 * that figure lives in the SHARED database — the one an operator's machine
 * cannot reach. So "is this a real drawdown or a stale peak?" was, like the
 * settings question above, answerable only by guessing.
 *
 * ONE INVARIANT MAKES THE ANSWER CHECKABLE. A peak is contributed capital plus
 * realised profit. An agent that has never traded has no realised profit, so
 * for it the peak MUST equal net contributions. When the durable peak exceeds
 * what the owner ever put in, the excess is not performance — it is money the
 * book is still counting after it left, or counted twice on the way in. That is
 * a defect in the accounting, and it is reported here as one rather than
 * rendered as a drawdown the owner is expected to trade out of.
 *
 * SAME DISCIPLINE AS ABOVE: a flat record of named numbers. No settings blob,
 * no grant, no keys.
 */
export interface AccountingFacts {
  smartAccount: string | null;
  /** `agents.hwm_usdg` as the SHARED database holds it. Null when unread. */
  durableHwmUsdg: number | null;
  durableAccruedFeeUsdg: number | null;
  durableEpoch: number | null;
  /** On-chain equity right now, in USDG. Null when the chain would not answer. */
  equityUsdg: number | null;
  /** The owner's own signed ceiling, from `grant.caps.maxDrawdownPct`. */
  maxDrawdownBps: number | null;
  /** Every durable flow row for this agent, oldest first. Null when unread. */
  flows:
    | {
        direction: string;
        amountUsdg: number;
        source: string;
        txHash: string | null;
        blockNumber: number | null;
      }[]
    | null;
  /** How many trade rows the shared ledger holds. Null when unread. */
  trades: number | null;
  /** Set when a read threw — distinct from "no rows". */
  error: string | null;
}

const usd = (n: number): string => n.toFixed(6);

/**
 * The accounting report, and the one derived verdict worth printing.
 *
 * EVERY UNKNOWN STAYS UNKNOWN. A null peak is not zero and a null flow list is
 * not an empty one; the whole reason this file exists is that somebody was
 * about to act on that difference.
 */
export function describeAccounting(f: AccountingFacts): string[] {
  const lines: string[] = [``, `── accounting ─────────────────────────────────`];
  if (f.error !== null) {
    lines.push(`accounting UNREADABLE — ${f.error}`);
    lines.push(`(nothing below is known; do NOT read a missing figure as zero)`);
    return lines;
  }

  lines.push(`smartAccount                  ${f.smartAccount ?? "UNKNOWN"}`);
  lines.push(
    `durable hwm_usdg              ${f.durableHwmUsdg === null ? "UNKNOWN" : usd(f.durableHwmUsdg)}`,
  );
  lines.push(
    `durable accrued_fee_usdg      ${f.durableAccruedFeeUsdg === null ? "UNKNOWN" : usd(f.durableAccruedFeeUsdg)}`,
  );
  lines.push(`durable epoch                 ${f.durableEpoch ?? "UNKNOWN"}`);
  lines.push(`equity now (on chain)         ${f.equityUsdg === null ? "UNKNOWN" : usd(f.equityUsdg)}`);
  lines.push(`trade rows in shared ledger   ${f.trades ?? "UNKNOWN"}`);
  lines.push(
    `maxDrawdownBps (signed cap)   ${f.maxDrawdownBps === null ? "UNKNOWN" : String(f.maxDrawdownBps)}`,
  );

  if (f.durableHwmUsdg !== null && f.durableHwmUsdg > 0 && f.equityUsdg !== null) {
    const bps = Math.floor(((f.durableHwmUsdg - f.equityUsdg) / f.durableHwmUsdg) * 10_000);
    lines.push(
      `→ breaker reads                ${bps}bps` +
        (f.maxDrawdownBps === null ? `` : bps >= f.maxDrawdownBps ? ` — REFUSING every buy` : ` — under the cap`),
    );
  }

  lines.push(``);
  if (f.flows === null) {
    lines.push(`flows UNREADABLE`);
    return lines;
  }
  if (f.flows.length === 0) {
    lines.push(`flows: NONE on record — the book has never seen capital arrive`);
  }
  let net = 0;
  for (const fl of f.flows) {
    net += fl.direction === "in" ? fl.amountUsdg : -fl.amountUsdg;
    lines.push(
      `  ${fl.direction === "in" ? "IN " : "OUT"} ${usd(fl.amountUsdg).padStart(14)}` +
        `  running ${usd(net).padStart(14)}  ${fl.source.padEnd(11)}` +
        `  ${fl.txHash ? fl.txHash.slice(0, 12) + "…" : "(no tx)"}` +
        `  ${fl.blockNumber ?? ""}`,
    );
  }
  lines.push(`net contributions             ${usd(net)}`);

  // THE VERDICT. Only stated when the premise for it actually holds: a peak
  // above contributions is only provably wrong when there is no realised
  // profit that could explain it, and only a zero trade count establishes that.
  if (f.durableHwmUsdg !== null && f.trades !== null && f.flows.length > 0) {
    const excess = f.durableHwmUsdg - net;
    if (f.trades === 0 && excess > 0.000001) {
      lines.push(
        `→ DEFECT: the peak exceeds contributed capital by ${usd(excess)} USDG on ZERO trades. ` +
          `With no realised profit the peak cannot exceed what was put in, so this is money the ` +
          `book is still counting after it left (or counted twice on the way in) — not a drawdown.`,
      );
    } else if (f.trades === 0) {
      lines.push(`→ peak agrees with contributed capital on zero trades`);
    } else {
      lines.push(
        `→ ${f.trades} trade(s) on record, so realised profit may legitimately explain a peak ` +
          `above contributions — this module cannot settle it alone`,
      );
    }
  }
  return lines;
}
