/**
 * WHAT A SETTING CHANGED FROM CHAT IS ALLOWED TO BECOME.
 *
 * ── THE BUG THIS ANSWERS ─────────────────────────────────────────────────
 *
 * `/strategy` and `/cap` called `patchSettingsFile` and nothing else. That
 * writes the CHILD's settings.json — and hosted, `writeSettingsForChild`
 * replaces that file wholesale from the tenant store on a fifteen-second
 * reconcile. So the bot replied "strategy → dip-hunter", the owner watched it
 * revert, and nothing anywhere said why. Self-hosted there is no orchestrator
 * and both always worked, which is how it survived.
 *
 * `/link` hit this first and solved it by writing a second, child-owned record
 * the parent promotes into the tenant's stored settings. This is that promotion
 * for the two settings a chat can change.
 *
 * ── WHY IT LIVES HERE AND NOT IN THE ORCHESTRATOR ────────────────────────
 *
 * The orchestrator is a process entry point: importing it starts a fleet, so
 * nothing in it can be executed by a test. This decision governs what a BEARER
 * link code is able to write into a tenant's sealed configuration, which is not
 * a decision to leave unexecutable — so it is a pure function here and the
 * orchestrator calls it.
 */

import type { MerrymenSettings } from "../../../packages/core/src/index";

/**
 * WHAT A CHAT MAY CHANGE, and nothing else.
 *
 * An allowlist rather than a filter of forbidden keys, because the cost of the
 * two mistakes is not symmetric: a field missing from an allowlist does not
 * take effect, while a field missing from a denylist takes effect with full
 * force. A child is reached through a bearer link code, so this is the boundary
 * between "the owner changed their strategy from their phone" and "whoever
 * holds that code rewrote the tenant's configuration".
 *
 * Both entries are settings Telegram could ALREADY change before any of this
 * existed; what changed is that they now survive. Widening this set is a
 * security decision, not a convenience one — in particular it may never admit
 * the remote-execution fields, which worker/src/settings.ts forces off hosted
 * precisely because a chat can reach them.
 */
export const CHAT_SETTABLE: ReadonlySet<string> = new Set(["strategy", "telegramMaxActionUsdg"]);

/** A chat-originated change, as the child recorded it. */
export interface ChatSettings {
  at: number;
  patch: Record<string, unknown>;
}

/**
 * A chat-originated settings patch, or null.
 *
 * Validated rather than cast. This value is promoted into a tenant's SEALED
 * SETTINGS, so a malformed record is not a shape to tolerate — it is a write
 * nobody asked for, and the only safe reading of one is that there is nothing
 * to promote.
 */
export function readChatSettings(v: unknown): ChatSettings | null {
  if (!v || typeof v !== "object") return null;
  const r = v as { at?: unknown; patch?: unknown };
  if (typeof r.at !== "number" || !Number.isFinite(r.at) || r.at <= 0) return null;
  if (!r.patch || typeof r.patch !== "object" || Array.isArray(r.patch)) return null;
  return { at: r.at, patch: r.patch as Record<string, unknown> };
}

/**
 * The settings to store, or null when there is nothing to do.
 *
 * GUARDED ON `at`, AND THE MARKER IS STORED RATHER THAN REMEMBERED. `put`
 * replaces the whole sealed blob and the dashboard is its other writer, so an
 * unconditional write on a fifteen-second loop would discard a tenant's save.
 * Keeping the marker in the parent's memory would be worse than useless across
 * a redeploy: it would forget, re-promote the last chat change, and undo
 * everything saved on the web since.
 *
 * THE RACE THAT REMAINS, stated rather than papered over: a dashboard save
 * lands in the window between a chat change and the next reconcile, and the
 * chat change — older, but not yet promoted — overwrites it. At most fifteen
 * seconds wide, and strictly better than the status quo, where the chat change
 * never lands at all. Closing it properly needs one writer, not two.
 */
export function promotedSettings(
  stored: Partial<MerrymenSettings>,
  chat: ChatSettings | null,
): Partial<MerrymenSettings> | null {
  if (!chat) return null;
  const promotedAt = typeof stored.telegramSettingsAt === "number" ? stored.telegramSettingsAt : 0;
  if (chat.at <= promotedAt) return null;
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(chat.patch)) if (CHAT_SETTABLE.has(k)) patch[k] = v;
  // The marker moves even when the allowlist emptied the patch, so a value this
  // build does not accept is refused ONCE rather than retried every fifteen
  // seconds for the life of the tenant.
  return { ...stored, ...patch, telegramSettingsAt: chat.at } as Partial<MerrymenSettings>;
}
