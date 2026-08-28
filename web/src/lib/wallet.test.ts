/**
 * The mobile wallet handoff links — the sign-in path for a phone.
 *
 * A phone browser injects no EIP-1193 provider, so sign-in there depends
 * entirely on these two URLs being byte-correct. They are the classic silent
 * failure: a wrong host or the wrong encoding still renders a perfectly good
 * button that opens nothing, and nothing in a type system or a render test
 * notices. Each format is pinned against the platform's own claim rather than
 * against the vendor docs, because on Phantom those two disagree.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { walletBrowserLinks } from "./wallet";

const URL_ = "https://app.merrymen.dev/app?x=1";
const ORIGIN = "https://app.merrymen.dev";

const linkFor = (id: "phantom" | "metamask") => {
  const found = walletBrowserLinks(URL_, ORIGIN).find((w) => w.id === id);
  assert.ok(found, `${id} link missing`);
  return found;
};

test("phantom: universal link on the host the APP claims, not the one the docs print", () => {
  const href = linkFor("phantom").href;
  // phantom.app/.well-known/apple-app-site-association 301s to phantom.com, and
  // neither iOS nor Android follows a redirect when resolving an app-link
  // association — so the phantom.app host printed in Phantom's docs would open
  // a web page instead of the wallet. phantom.com is what carries /ul/* in the
  // live AASA and app.phantom in assetlinks.json.
  assert.ok(href.startsWith("https://phantom.com/ul/browse/"), `wrong base: ${href}`);
  assert.ok(!href.includes("phantom.app"), "phantom.app no longer opens the app");
});

test("phantom: both url and ref are encodeURIComponent-encoded, as the docs require", () => {
  const href = linkFor("phantom").href;
  // The documented example encodes every ':' and '/' in the target (%3A%2F%2F).
  // encodeURI would leave the slashes intact and is NOT what Phantom shows.
  assert.ok(href.includes(encodeURIComponent(URL_)), "target url must be component-encoded");
  assert.ok(href.endsWith(`?ref=${encodeURIComponent(ORIGIN)}`), `ref missing/unencoded: ${href}`);
  // The encoded target must not leak a raw "://" into the path segment.
  const path = href.slice("https://phantom.com/ul/browse/".length).split("?")[0];
  assert.ok(!path.includes("://"), "the target url was not encoded");
  assert.ok(path.includes("%3A%2F%2F"), "expected %3A%2F%2F, the documented encoding");
});

test("phantom: ref is present — the docs mark it required, not optional", () => {
  assert.match(linkFor("phantom").href, /\?ref=.+/);
});

test("metamask: the opposite convention — scheme stripped, NOT encoded", () => {
  const href = linkFor("metamask").href;
  assert.ok(href.startsWith("https://link.metamask.io/dapp/"), `wrong base: ${href}`);
  const tail = href.slice("https://link.metamask.io/dapp/".length);
  // Documented shape is /dapp/app.uniswap.org — a bare host+path. Encoding it
  // (or leaving https:// on) is the mistake this pins.
  assert.equal(tail, "app.merrymen.dev/app?x=1");
  assert.ok(!tail.startsWith("https"), "scheme must be stripped for MetaMask");
  assert.ok(!tail.includes("%3A"), "MetaMask's path is not percent-encoded");
});

test("the two wallets do NOT share an encoding convention", () => {
  // Stated as a test because it is the single easiest thing to 'tidy up' into a
  // shared helper later, which would silently break one of the two.
  const [p, m] = [linkFor("phantom").href, linkFor("metamask").href];
  assert.ok(p.includes("%3A%2F%2F"), "phantom encodes");
  assert.ok(!m.includes("%3A%2F%2F"), "metamask does not");
});

test("http origins are handled without producing a doubled scheme", () => {
  const links = walletBrowserLinks("http://localhost:3100/app", "http://localhost:3100");
  const mm = links.find((w) => w.id === "metamask")!.href;
  assert.equal(mm, "https://link.metamask.io/dapp/localhost:3100/app");
});
