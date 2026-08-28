/**
 * What to tell someone after the wallet handoff — the pure half, so it can be
 * tested without React Native (vitest.config.ts keeps this runner free of RN).
 *
 * Kept separate from wallets.ts because that module imports `react-native` and
 * `expo-clipboard` at the top level, which this runner deliberately cannot load.
 *
 * The copy and the app-launch fail for unrelated reasons — a clipboard refusal
 * and a missing wallet — so all four combinations are real and each gets its own
 * sentence. This matters more than it looks: telling someone "address copied"
 * when the write failed sends them into Phantom to paste an empty clipboard, and
 * the mistake only surfaces as a wrong or missing recipient on a transfer of
 * real money. Every branch below states exactly what did and didn't happen, and
 * always leaves the reader a next action.
 */

/** Where the user ended up. Mirrors HandoffResult in wallets.ts. */
export type HandoffOutcome = "app" | "web" | "failed";

export function handoffMessage(r: { copied: boolean; opened: HandoffOutcome }): string {
  if (r.opened === "failed") {
    return r.copied
      ? "Address copied. Couldn't open Phantom — paste it into your wallet by hand."
      : "Couldn't open Phantom, and couldn't reach the clipboard. Copy the address above by hand.";
  }
  if (r.opened === "web") {
    // Phantom didn't claim the link, which in practice means it isn't installed.
    // Hedged ("doesn't look installed") because a launch can fail for other
    // reasons, and asserting an uninstall we didn't verify would be a guess.
    return r.copied
      ? "Phantom doesn't look installed — opened its download page. The address is copied, ready to paste once you're set up."
      : "Phantom doesn't look installed — opened its download page. Copy the address above by hand.";
  }
  return r.copied
    ? "Address copied — in Phantom tap Send, choose Robinhood Chain, and paste."
    : "Opened Phantom. Copy the address above, then tap Send → Robinhood Chain.";
}
