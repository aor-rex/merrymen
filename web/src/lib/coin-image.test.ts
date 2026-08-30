import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveLogo } from "./coin-image";

/**
 * A token's logo URI is written by whoever launched it, which makes it
 * attacker-controlled by construction. These pin the two halves of that: what
 * the proxy is willing to turn into a request, and what it refuses outright.
 */
describe("resolveLogo", () => {
  it("resolves ipfs:// against more than one gateway", () => {
    // More than one because the gateways disagree about which CIDs they hold,
    // and a single 404 should not empty the card.
    const urls = resolveLogo("ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
    assert.ok(urls.length >= 2);
    for (const u of urls) assert.match(u, /^https:\/\/[^/]+\/ipfs\/Qm/);
  });

  it("handles the ipfs://ipfs/ double prefix", () => {
    const [first] = resolveLogo("ipfs://ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG");
    assert.ok(first?.endsWith("/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"));
  });

  it("resolves a bare CID, both versions", () => {
    assert.ok(resolveLogo("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG").length >= 2);
    assert.ok(resolveLogo("bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi").length >= 2);
  });

  it("passes https through untouched", () => {
    assert.deepEqual(resolveLogo("https://example.com/a.png"), ["https://example.com/a.png"]);
  });

  it("refuses everything that is not http(s) after resolution", () => {
    // data: and javascript: are the obvious ones. PLAIN HTTP is refused too and
    // that is deliberate: the app is served over https, so a mixed-content
    // image is blocked by the browser anyway — proxying it would launder the
    // downgrade away rather than fix it.
    for (const bad of [
      "",
      "   ",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      "file:///etc/passwd",
      "http://example.com/a.png",
      "not a uri at all",
    ]) {
      assert.deepEqual(resolveLogo(bad), [], `must refuse ${JSON.stringify(bad)}`);
    }
  });
});
