import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { refusalMessage } from "./session";

/**
 * The bug this file exists to prevent, written down because it shipped.
 *
 * `createAgentWallet` and `restoreAgentWallet` took seven POSITIONAL
 * parameters, four of them optional and three of them the same type. Adding
 * `ponsAdapterAddress` before `hostedAs` shifted every call site by one, so the
 * signed-in wallet address went into the adapter slot and `hostedAs` became
 * undefined. Nothing failed to compile — an optional address is an optional
 * address whatever it is meant to be — and nothing failed a test.
 *
 * The result was two separate faults from one edit. Every newly created hosted
 * wallet was refused by the server, because no `hostedAs` means no binding. And
 * the owner's own wallet address was being sealed into the wall as a Pons
 * adapter: a call target, and a spender named in every approve permission.
 *
 * The structural fix is the options object. These tests pin it, because the
 * next person to add a parameter will not have read the story.
 */

const SESSION_SRC = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
const GRANT_PAGE_SRC = readFileSync(new URL("../app/grant/page.tsx", import.meta.url), "utf8");

describe("mint entry points take NAMED options", () => {
  it("createAgentWallet and restoreAgentWallet take an options object", () => {
    assert.match(SESSION_SRC, /export async function createAgentWallet\(o: MintOptions\)/);
    assert.match(SESSION_SRC, /export async function restoreAgentWallet\(\s*ownerPrivateKey: `0x\$\{string\}`,\s*o: MintOptions,/);
  });

  it("no caller passes them positionally", () => {
    // The exact shape that broke: a call whose fifth argument is an adapter and
    // whose sixth is a wallet, distinguishable only by reading the signature.
    const calls = [...GRANT_PAGE_SRC.matchAll(/(createAgentWallet|restoreAgentWallet)\(([\s\S]{0,400}?)\)\s*;/g)];
    assert.ok(calls.length >= 3, `expected the three call sites, found ${calls.length}`);
    for (const [, name, args] of calls) {
      assert.match(args, /\{/, `${name} must be called with an options object`);
      assert.match(args, /onStatus:/, `${name} must name onStatus`);
    }
  });

  it("every call site that can be hosted passes hostedAs BY NAME", () => {
    // No hostedAs means no binding means the server refuses the wallet. Naming
    // it is what makes that impossible to do by accident.
    const named = (GRANT_PAGE_SRC.match(/hostedAs:/g) ?? []).length;
    assert.equal(named, 3, "all three mint call sites must pass hostedAs by name");
  });

  it("no call site passes an adapter where a wallet belongs", () => {
    // The specific corruption: session.address landing in the adapter slot.
    assert.ok(
      !/v4AdapterAddress:\s*session/.test(GRANT_PAGE_SRC),
      "a session wallet must never be passed as an adapter address",
    );
    assert.ok(
      !/ponsAdapterAddress:\s*session/.test(GRANT_PAGE_SRC),
      "a session wallet must never be passed as an adapter address",
    );
  });
});

describe("refusalMessage", () => {
  it("surfaces the server's OWN reason for a 403", () => {
    // Two different refusals arrive as 403 and need different actions: no
    // binding at all, versus a binding that does not verify. A single
    // hardcoded sentence told the reader their brand-new wallet belonged to
    // someone else, which sent them hunting a wallet mix-up that did not exist
    // and hid the real bug for a whole debugging session.
    const msg = refusalMessage(403, "this grant isn't linked to your login — create it again from a signed-in browser");
    assert.match(msg, /isn't linked to your login/);
    assert.ok(!/isn't owned by the wallet/.test(msg), "must not assert an ownership problem it cannot know about");
  });

  it("still says something useful when the server sent no reason", () => {
    assert.match(refusalMessage(403), /won't arm/);
  });

  it("keeps the actionable text for the other hosted refusals", () => {
    assert.match(refusalMessage(401), /Sign in with your wallet/);
    assert.match(refusalMessage(422), /bug on our side/);
    assert.match(refusalMessage(503), /try again/);
  });

  it("falls through to the server for anything unmapped", () => {
    assert.equal(refusalMessage(500, "boom"), "boom");
    assert.match(refusalMessage(500), /refused the grant \(500\)/);
  });
});
