/**
 * A REFUSAL AN OWNER CANNOT ACT ON IS A DEAD END.
 *
 * A beta owner hit "this permission set is too wide to install" and could not
 * get out of it. The sentence told him to "remove some custom tokens, or turn
 * off a venue you are not using" — and on chain 4663 the largest removable item,
 * the class vault, CANNOT be turned off, because `sealedClassFactory` falls back
 * to the chain's own factory and the settings field can only override the
 * address, never clear it. So the one lever it named was the one lever he did
 * not have, and the screen offered him nothing to click.
 *
 * The remedy now rides with the refusal, on both surfaces that can raise it —
 * the create flow and the re-sign panels — and it points at a screen that needs
 * only a login session, which is exactly what `/api/settings` authenticates on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isWallTooWide, WALL_TOO_WIDE, wallShape, wallSignable } from "@merrymen/core";
import { buildCallPermissions } from "../../../packages/core/src/wall";
import { EN } from "../lib/messages/en";

const EN_TEXT = Object.values(EN).join("\n");

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");

describe("the too-wide refusal carries its own remedy", () => {
  it("the marker is what surfaces key on, not a sentence fragment", () => {
    // Matching on prose is how a remedy quietly stops appearing the day somebody
    // rewords the copy.
    assert.ok(isWallTooWide(`${WALL_TOO_WIDE}: installing it would need about 15,980,519 gas`));
    assert.equal(isWallTooWide("couldn't reach the server to re-arm this wallet."), false);
    assert.equal(isWallTooWide(null), false);
    assert.equal(isWallTooWide(undefined), false);
  });

  it("A REAL REFUSAL IS RECOGNISED BY IT — the two are not allowed to drift", () => {
    // Built through the actual wall builder, so the string the product raises is
    // the string the surfaces test for.
    const shape = (n: number) =>
      wallShape(
        buildCallPermissions(
          { perTradeUsdg: 25, dailyUsdg: 100, maxDrawdownPct: 5 } as never,
          "0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487",
          {
            extraTokens: Array.from({ length: n }, (_, i) => ({
              symbol: `T${i}`,
              address: `0x${(i + 0x1000).toString(16).padStart(40, "0")}`,
              decimals: 18,
            })),
          } as never,
        ) as never,
      );
    const refused = wallSignable(shape(40), { deploying: true });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.ok(isWallTooWide(refused.why), "the product's own message must match");
  });

  it("BOTH surfaces that can raise it offer the way out", () => {
    const create = read("./screens/CreateAgent.tsx");
    const wallet = read("./screens/Wallet.tsx");
    for (const [name, src, key] of [
      ["CreateAgent", create, "onboard.reviewTokens"],
      ["Wallet", wallet, "wallet.reviewTokens"],
    ] as const) {
      assert.match(src, /isWallTooWide\(error\)/, `${name} must key the remedy off the refusal`);
      // i18n: the action lives in the catalogue now; pin the key at the call
      // site and the wording in EN.
      assert.match(src, new RegExp(`t\\("${key}"\\)`), `${name} must offer the action`);
      assert.match(src, /href="\/settings"/, `${name} must point somewhere reachable`);
    }
    assert.match(EN_TEXT, /Review custom tokens/, "the remedy action wording survives in EN");
    // Create/restore, desync recovery, and an active grant's renewal all have
    // separate panels. The actual renewal click is rendered and tested in
    // wallet-renewal.test.ts; merely counting the first two missed this bug.
    assert.equal(
      (wallet.match(/t\("wallet\.reviewTokens"\)/g) ?? []).length,
      3,
      "all three grant panels must carry it",
    );
  });

  it("and /settings needs only a session, not a working grant", () => {
    // The whole point: the owner is refused BECAUSE he has no signable grant, so
    // a remedy behind one would be circular. `tenantOf` reads the session cookie.
    const auth = read("../lib/auth.ts");
    assert.match(
      auth,
      /export function tenantOf\(req: Request\)[\s\S]{0,200}cookie/,
      "the settings API authenticates on the login session",
    );
    // And the screen itself must not be gated on owning an agent.
    const app = read("./App.tsx");
    assert.match(
      app,
      /screen\.kind === "settings" && <Settings/,
      "the settings screen renders without a `mine` guard",
    );
  });
});
