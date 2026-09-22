/**
 * A FIRST NAME FOR A BRAND-NEW AGENT THAT ARRIVED WITHOUT ONE.
 *
 * Called from the grants route, straight after the identity store mints the
 * slug — the first moment a slug exists to seed a name on. An agent that
 * reaches its grant with no name set would otherwise become the fleet's next
 * "Robin"; this writes the slug's generated name (packages/core agent-name.ts)
 * into its settings instead, and the worker's name reconcile carries it into
 * the soul and onto the roster on its first tick.
 *
 * NEW AGENTS ONLY, AND "NEW" IS PROVEN, NOT ASSUMED. Renaming an existing
 * agent behind its owner's back is the harm here; an agent left as "Robin" is
 * merely the status quo, and the Agent screen offers the same name as a chip.
 * So every question that cannot be answered is answered "don't":
 *
 *   - settings already hold a name → the owner chose it; keep it.
 *   - the tenant has held an account before → not new. An empty setting does
 *     not mean nobody named it: a chat rename lives only in the soul, and the
 *     reconcile would stamp this name over it.
 *   - the ledger already has a row for this account → not new either; that is
 *     an account from before the identity store, with no record to say so.
 *   - any of those three could not be read → unread, so no write.
 *
 * Never widens anything: a name is a display string and the soul's own rule
 * still applies to it downstream.
 */
import { agentNameForSlug, type MerrymenSettings } from "@merrymen/core";
import type { Db } from "../../../worker/src/db";

export interface FirstNameInputs {
  /** The slug the identity store just returned. */
  slug: string;
  /** The smart account this grant is for. */
  account: string;
  /**
   * The tenant's identity as it stood BEFORE this grant's ensure: null when
   * there was none, `undefined` when it could not be read.
   */
  prior: { accounts: readonly string[] } | null | undefined;
  settings: {
    get(): Promise<MerrymenSettings | null>;
    put(settings: MerrymenSettings): Promise<void>;
  };
  /** True when the ledger already has a row for the account; null when unread. */
  ledgerHasAgent(account: string): Promise<boolean | null>;
}

export type FirstNameOutcome =
  | { named: string }
  | { skipped: "no-slug" | "has-name" | "not-new" | "unread" };

export async function nameNewAgent(i: FirstNameInputs): Promise<FirstNameOutcome> {
  const name = agentNameForSlug(i.slug);
  if (!name) return { skipped: "no-slug" };
  if (i.prior === undefined) return { skipped: "unread" };
  if (i.prior && i.prior.accounts.length > 0) return { skipped: "not-new" };

  let stored: MerrymenSettings | null;
  try {
    stored = await i.settings.get();
  } catch {
    return { skipped: "unread" };
  }
  if (typeof stored?.agentName === "string" && stored.agentName.trim()) return { skipped: "has-name" };

  const known = await i.ledgerHasAgent(i.account);
  if (known === null) return { skipped: "unread" };
  if (known) return { skipped: "not-new" };

  // READ-MODIFY-WRITE of the whole record, because that is the store's only
  // write. The window is the few milliseconds since the read above, on a
  // tenant whose wizard (the only other writer at signup) finished its own
  // settings save before it posted this grant.
  await i.settings.put({ ...(stored ?? {}), agentName: name });
  return { named: name };
}

/**
 * Does the ledger already hold this account? Null when there is no ledger to
 * ask, or the ask failed — which the caller must treat as "maybe".
 *
 * Case-folded on both sides: the worker stores the account as the grant spells
 * it, which is usually checksummed.
 */
export async function ledgerHasAgent(
  withDb: <T>(fn: (db: Db | null) => Promise<T>) => Promise<T>,
  account: string,
): Promise<boolean | null> {
  try {
    return await withDb(async (db) => {
      if (!db) return null;
      const row = await db
        .prepare("SELECT 1 AS one FROM agents WHERE lower(smart_account) = ? LIMIT 1")
        .get(account.toLowerCase());
      return row !== undefined && row !== null;
    });
  } catch {
    return null;
  }
}
