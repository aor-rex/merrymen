import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * TWO SIGNERS, ONE WALL — pinned as source, because signer orchestration has
 * no seams to test through.
 *
 * The failure family this guards is the repo's oldest scar, three times over:
 * a marker minted without its permission (the transfer saga — 24 days of
 * grants claiming a capability the wall never emitted), a permission granted
 * without its marker (the exactInput reverts — routes quoted, submitted, and
 * refused on-chain every tick), and two signers drifting until the phone and
 * the dashboard sealed different walls under the same name.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB = readFileSync(`${HERE}../../web/src/lib/session.ts`, "utf8");
const MOBILE = readFileSync(`${HERE}../../mobile/src/crypto/signGrant.ts`, "utf8");

test("both signers thread the adapter address and mint its marker together", () => {
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(src.includes("GRANT_V4_ADAPTER"), `${name} must mint the marker`);
    assert.ok(src.includes("v4AdapterAddress"), `${name} must thread the sealed address`);
    // The marker must be CONDITIONAL on the address — minted by the
    // permission, never ahead of it. An unconditional mint is exactly the
    // transfer saga again.
    assert.match(
      src,
      /v4AdapterAddress\s*\?\s*\[GRANT_V4_ADAPTER\]\s*:\s*\[\]/,
      `${name} must mint GRANT_V4_ADAPTER only when the permission was sealed`,
    );
  }
});

test("the legacy v4 route stays never-minted, in both signers", () => {
  // allowUniswapV4 opens Permit2 + UniversalRouter, whose execute() the policy
  // cannot read — "the whole non-USDG book to any address, in one UserOp". The
  // adapter exists precisely so this flag never has to flip. If someone turns
  // it on, this fails and demands they read wall.ts:148-176 first.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.ok(
      src.includes("const allowUniswapV4: boolean = false"),
      `${name} must keep the legacy v4 route off — the adapter is the v4 route now`,
    );
  }
});

test("both signers persist the sealed address alongside the marker", () => {
  // The marker alone is a claim. The worker calls grantV4Adapter, which
  // demands the address the permission was actually sealed against — so a
  // signer that mints the marker but drops the field produces a grant the
  // worker correctly treats as adapter-less, and v4 silently never routes.
  for (const [name, src] of [
    ["web/src/lib/session.ts", WEB],
    ["mobile/src/crypto/signGrant.ts", MOBILE],
  ] as const) {
    assert.match(
      src,
      /v4AdapterAddress[^\n]*toLowerCase\(\)/,
      `${name} must write the sealed address (lowercased) onto the grant`,
    );
  }
});
