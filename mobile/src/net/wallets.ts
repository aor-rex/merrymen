import { Linking } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { HandoffOutcome } from "./handoffMessage";

/**
 * Handing the owner off to their phone wallet to fund the smart account.
 *
 * WHY THIS IS A COPY-AND-OPEN AND NOT A PREFILLED SEND. Phantom publishes
 * exactly two deeplink shapes — versioned provider methods at
 * `https://phantom.app/ul/v1/<method>` (connect, signMessage, signTransaction…)
 * and the session-less `swap` / `fungible` / `browse` methods. **None of them
 * opens a send screen with a recipient and amount filled in**; there is no
 * `/ul/v1/send`, `/transfer` or `/pay`. Three plausible-looking alternatives are
 * all dead ends here, and each was checked rather than assumed:
 *
 *   • EIP-681 (`ethereum:0xTOKEN@4663/transfer?address=…`) is the standard EVM
 *     payment URI and Phantom does not implement it — its deeplink docs cover
 *     Solana only. On iOS an unhandled `ethereum:` link doesn't even offer a
 *     chooser, it dead-ends on "Safari cannot open the page".
 *   • Solana Pay (`solana:`) does prefill, but it is Solana-only and Robinhood
 *     Chain is an EVM L2 — wrong rail entirely.
 *   • Connecting Phantom as a signer (WalletConnect / EIP-1193) can't work
 *     either: Phantom's own Robinhood Chain FAQ says "dApp connectivity is not
 *     currently available" on this chain.
 *
 * So the honest maximum is one tap that copies the address AND opens the wallet,
 * leaving the user a single paste. That is also the pattern that survives every
 * case a deeplink would strand — a different wallet, an exchange withdrawal, a
 * second device — which is why the address stays on screen either way.
 *
 * Phantom DOES hold Robinhood Chain (mainnet 4663 and, under Testnet Mode, the
 * testnet) on the same EVM address it already uses for Ethereum/Base/Polygon, so
 * once the user is in the app the send itself works.
 */

/**
 * Phantom's registered custom scheme. Documented as `phantom://<version>/<method>`;
 * bare, it simply opens the app, which is all this needs — there is no method
 * worth invoking (see the header: none of them prefill a send).
 */
const PHANTOM_APP_URL = "phantom://";

/**
 * Where to land someone who doesn't have Phantom installed. A plain https page,
 * so the fallback is a real page with install links rather than another failure.
 */
const PHANTOM_WEB_URL = "https://phantom.app/";

/**
 * What actually happened, so the UI can say something true rather than assume.
 * Defined next to the message copy it drives (handoffMessage.ts), which is the
 * pure half — this module can't be imported by the test runner, that one can.
 */
export type HandoffResult = HandoffOutcome;

/**
 * Open the Phantom app, falling back to its website when it isn't installed.
 *
 * Deliberately drives `openURL` directly and catches, rather than gating on
 * `canOpenURL`. `canOpenURL` is the wrong tool on both platforms: iOS *rejects*
 * for a scheme absent from `LSApplicationQueriesSchemes`, and Android 11+
 * silently answers `false` under package-visibility filtering unless a
 * `<queries>` entry is declared — so it reports "not installed" for a wallet
 * that is. `openURL` is subject to neither restriction, and its rejection is a
 * truthful signal that nothing handled the link. Not gating also keeps this
 * change free of any native config, so it needs no prebuild.
 */
export async function openPhantom(): Promise<HandoffResult> {
  try {
    await Linking.openURL(PHANTOM_APP_URL);
    return "app";
  } catch {
    // Nothing on the device claimed phantom:// — almost always "not installed".
    try {
      await Linking.openURL(PHANTOM_WEB_URL);
      return "web";
    } catch {
      return "failed";
    }
  }
}

/**
 * The funding handoff: put the address on the clipboard, THEN open the wallet,
 * so the user arrives in Phantom with only a paste left to do.
 *
 * Copy first and await it. Opening the wallet backgrounds this app, and on both
 * platforms a clipboard write racing an app switch is a write that may not land
 * — which would drop the user into a send screen with nothing to paste, the
 * exact dead end this function exists to remove.
 *
 * Returns whether the copy succeeded alongside where the user was sent, because
 * the two fail independently and the caller has to be able to say which.
 */
export async function fundWithPhantom(
  address: string,
): Promise<{ copied: boolean; opened: HandoffResult }> {
  let copied = false;
  try {
    await Clipboard.setStringAsync(address);
    copied = true;
  } catch {
    // A clipboard refusal must not cancel the handoff — the address is still on
    // screen to read, and the wallet is still the right place to be.
  }
  return { copied, opened: await openPhantom() };
}
