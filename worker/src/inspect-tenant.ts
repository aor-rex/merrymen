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
