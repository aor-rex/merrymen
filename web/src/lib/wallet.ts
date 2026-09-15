"use client";

import type { Chain } from "viem";

export interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

/**
 * The injected EIP-1193 provider, or null when this browser has none.
 *
 * Non-throwing, because "there is no wallet here" is the NORMAL case on a phone
 * and needs a different answer than an error. A mobile browser (Safari, Chrome)
 * injects nothing at all — only a desktop extension does, or a wallet's own
 * in-app browser. Callers use this to decide between signing and offering the
 * handoff in walletBrowserLinks() below.
 *
 * Checks Phantom's namespaced provider first: Phantom mirrors it onto
 * window.ethereum, but reading the specific one avoids picking a different
 * wallet that also claimed the shared slot.
 */
export function findInjectedProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null; // SSR — there is no window to ask
  const w = window as unknown as {
    ethereum?: Eip1193Provider;
    phantom?: { ethereum?: Eip1193Provider };
  };
  return w.phantom?.ethereum ?? w.ethereum ?? null;
}

export function getInjectedProvider(): Eip1193Provider {
  const eth = findInjectedProvider();
  if (!eth) throw new Error("No wallet found — install MetaMask (or any EIP-1193 wallet).");
  return eth;
}

/** A wallet we can hand a phone off to, and the link that opens this page inside it. */
export interface WalletBrowserLink {
  id: "phantom" | "metamask";
  name: string;
  href: string;
}

/**
 * Links that reopen `url` inside a wallet's own in-app browser.
 *
 * WHY THIS IS THE FIX FOR MOBILE SIGN-IN. Signing in needs an EIP-1193 provider,
 * and a phone browser has none — there is no mobile equivalent of a desktop
 * extension. The universal answer is to bounce the page into a wallet app's
 * built-in browser, which DOES inject one; the existing SIWE flow then runs
 * there unchanged. Sign-in only needs eth_requestAccounts + personal_sign (no
 * chain switch — nothing here calls ensureChain), so this works even though
 * Phantom does not yet offer dApp connectivity on Robinhood Chain itself.
 *
 * The two link formats are NOT the same shape, which is exactly the kind of
 * detail that ships a button opening nothing, so each is spelled out:
 *
 *   Phantom  `https://phantom.com/ul/browse/<url>?ref=<ref>` — both parameters
 *            are required and encodeURIComponent-encoded. The host is
 *            phantom.COM, not the phantom.app printed in Phantom's own docs:
 *            phantom.app/.well-known/apple-app-site-association now 301s to
 *            phantom.com, and neither iOS nor Android follows a redirect when
 *            resolving an app-link association — so the documented host would
 *            fail to open the app. phantom.com is what the app actually claims
 *            (`/ul/*` in its AASA, package `app.phantom` in its assetlinks).
 *
 *   MetaMask `https://link.metamask.io/dapp/<host+path>` — scheme STRIPPED and
 *            NOT encoded, i.e. the opposite convention to Phantom's.
 */
export function walletBrowserLinks(url: string, origin: string): WalletBrowserLink[] {
  // Strip the scheme for MetaMask, keep the full URL for Phantom.
  const bare = url.replace(/^https?:\/\//, "");
  return [
    {
      id: "phantom",
      name: "Phantom",
      href: `https://phantom.com/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(origin)}`,
    },
    {
      id: "metamask",
      name: "MetaMask",
      href: `https://link.metamask.io/dapp/${bare}`,
    },
  ];
}

export async function requestAccount(provider: Eip1193Provider): Promise<`0x${string}`> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const account = accounts?.[0];
  if (!account) throw new Error("Wallet returned no accounts.");
  return account as `0x${string}`;
}

/** Switch the wallet to `chain`, adding it first if unknown (littlejohn's add-chain dance). */
export async function ensureChain(provider: Eip1193Provider, chain: Chain): Promise<void> {
  const chainIdHex = `0x${chain.id.toString(16)}`;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  } catch (err) {
    const code = (err as { code?: number }).code;
    // 4902 = unknown chain
    if (code !== 4902) throw err;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId: chainIdHex,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers
            ? [chain.blockExplorers.default.url]
            : undefined,
        },
      ],
    });
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
  }
}
