/**
 * "SIGN NOW" — THE ONE MESSAGE THAT CAN END A STALL, WITH THE BUTTON ON IT.
 *
 * An agent that needs a fresh signature cannot trade until its owner gives one,
 * and nothing the agent does on its own will change that. The worker has known
 * the reason every tick for a long time — `agents.live_blocker` — and until now
 * said it only on the dashboard banner. The owner is in Telegram. So this is
 * where the question now gets asked, with a button that opens the signing page.
 *
 * WHAT COUNTS as "needs a signature", and nothing else:
 *   - the three blockers only a new signature clears (`dead-policy` after an
 *     update changed the sealed permission set, `wrong-chain`, `grant-too-wide`)
 *     — the same three `web/src/lib/live-blocker.ts` marks `resign: true`
 *   - the permission running out within a day, or already run out
 * `no-gas`, `no-cash`, `no-executor` and `live-not-enabled` are NOT here: a
 * signature changes nothing about them, and asking for one would teach the
 * owner the button is a ritual.
 *
 * TWO GUARDS, both learned from the web banner:
 *
 *   SETTLE. A corrected grant takes minutes to reach the child that writes the
 *   blocker (orchestrator ferry, then the next tick). For that window the old
 *   blocker sits beside the NEW grant — the web page told owners who had just
 *   signed to sign again, and one reported the product broken. So a blocker
 *   must be seen, for the same grant, across SETTLE_SEC before it is spoken.
 *   Expiry needs no settling: it is read off the grant itself.
 *
 *   REPEAT, BUT RARELY. Once per state, then once a day while it stays true.
 *   Keyed by reason AND grant, so signing a new grant that is still wrong asks
 *   again straight away rather than waiting out yesterday's cooldown.
 *
 * Pure. The notifier reads the inputs and sends; everything that decides is
 * here and tested.
 */

import type { InlineKeyboard } from "./api";

/** Blockers a fresh signature is the fix for. */
export const SIGN_BLOCKERS: ReadonlySet<string> = new Set(["dead-policy", "wrong-chain", "grant-too-wide"]);

export type SignReason = "dead-policy" | "wrong-chain" | "grant-too-wide" | "expiring" | "expired";

/** How long a blocker must hold, for one grant, before it is spoken. */
export const SETTLE_SEC = 6 * 60;
/** How often an unresolved state is repeated. */
export const REPEAT_SEC = 24 * 3600;
/** "Runs out soon" means inside this window. */
export const EXPIRING_WITHIN_SEC = 24 * 3600;

export interface SignInputs {
  /** `agents.live_blocker` for this agent, or null. */
  blocker: string | null;
  /** The stored grant's expiry (unix seconds), or null when there is no grant. */
  grantExpiresAt: number | null;
  /** The stored grant's signing time, which identifies it. */
  grantedAt: number | null;
  now: number;
}

/** What needs signing right now, and the key it is remembered by — or null. */
export function signNeed(i: SignInputs): { reason: SignReason; key: string; settles: boolean } | null {
  if (i.grantExpiresAt === null) return null; // no grant: onboarding, not a stall
  const grant = `${i.grantedAt ?? 0}-${i.grantExpiresAt}`;
  if (i.grantExpiresAt <= i.now) return { reason: "expired", key: `sign:expired:${grant}`, settles: false };
  // A blocker outranks "expiring": fixing the blocker IS a new signature, which
  // resets the expiry too, so there is one thing to ask for, not two.
  if (i.blocker && SIGN_BLOCKERS.has(i.blocker)) {
    return { reason: i.blocker as SignReason, key: `sign:${i.blocker}:${grant}`, settles: true };
  }
  if (i.grantExpiresAt - i.now < EXPIRING_WITHIN_SEC) {
    return { reason: "expiring", key: `sign:expiring:${grant}`, settles: false };
  }
  return null;
}

/** What the notifier keeps between passes. */
export interface SignWatch {
  key: string;
  /** When this key was first seen, for the settle window. */
  since: number;
}

/**
 * Should the prompt go out on this pass?
 *
 * `lastSentAt` is the per-key record the notifier already keeps for condition
 * alerts (`firedAlerts`). Returns the watch to store either way.
 */
export function signDecision(
  need: { key: string; settles: boolean } | null,
  watch: SignWatch | null,
  lastSentAt: number | undefined,
  now: number,
): { send: boolean; watch: SignWatch | null } {
  if (!need) return { send: false, watch: null };
  const w = watch && watch.key === need.key ? watch : { key: need.key, since: now };
  if (need.settles && now - w.since < SETTLE_SEC) return { send: false, watch: w };
  if (lastSentAt !== undefined && now - lastSentAt < REPEAT_SEC) return { send: false, watch: w };
  return { send: true, watch: w };
}

/** Hours, rounded down but never below one — "runs out in 0h" is not a time. */
function hoursLeft(expiresAt: number, now: number): number {
  return Math.max(1, Math.floor((expiresAt - now) / 3600));
}

/**
 * The message, in words an owner does not have to learn.
 *
 * No "grant", "policy", "wall" or "session key": the owner signed something
 * that lets the agent trade, and that is what it is called here. Every variant
 * says the signature is free, because "sign" next to money reads as "pay".
 */
export function signPromptText(reason: SignReason, i: SignInputs, name: string): string {
  const who = name.trim() || "your agent";
  switch (reason) {
    case "dead-policy":
      return (
        `✍️ <b>${escHtml(who)} needs a fresh signature to keep trading.</b>\n` +
        `An update changed how trading permission works, and the one you signed before can't be used anymore. ` +
        `Signing again is free and takes a few seconds. Nothing else needs doing.`
      );
    case "wrong-chain":
      return (
        `✍️ <b>${escHtml(who)} can't trade: your permission was signed for a different network.</b>\n` +
        `Sign a new one on Robinhood Chain. It's free, and your funds stay where they are.`
      );
    case "grant-too-wide":
      return (
        `✍️ <b>${escHtml(who)} can't place its first trade.</b>\n` +
        `The permission you signed covers too many tokens and exchanges to switch on. ` +
        `Sign again with fewer of them. It's free.`
      );
    case "expiring":
      return (
        `⏳ <b>${escHtml(who)}'s trading permission runs out in about ${hoursLeft(i.grantExpiresAt ?? i.now, i.now)}h.</b>\n` +
        `Sign a new one to keep it trading. It's free, and it doesn't touch your funds.`
      );
    case "expired":
      return (
        `⛔ <b>${escHtml(who)}'s trading permission ran out, so it has stopped trading.</b>\n` +
        `Sign a new one to start it again. It's free, and your funds are untouched.`
      );
  }
}

/**
 * The signing page — the same href the dashboard's own re-sign button uses
 * (web/src/terminal/App.tsx `resignHref`), so the two cannot open different
 * places. `#resign` scrolls to the signing form. The grant screen reads `chain`
 * to pre-select the network the button promised; without it a wrong-chain
 * owner re-signs on the network being replaced (autonomy.ts `ownerRemedy`
 * explains the loop that caused), so it is set for that case only.
 */
export function signUrl(base: string, reason: SignReason): string {
  const root = `${base.replace(/\/+$/, "")}/grant`;
  return reason === "wrong-chain" ? `${root}?chain=4663#resign` : `${root}#resign`;
}

export function signKeyboard(url: string): InlineKeyboard {
  return [[{ text: "✍️ Sign now", url }]];
}

/** Local HTML escape — this module must not import the network client. */
function escHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
