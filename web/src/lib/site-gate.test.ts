import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { isGatedPath, sameSecret, gatePassword, GATE_PATH } from "./site-gate";

/**
 * The holding page is a notice with a doorknob, and it has exactly two ways to
 * go badly wrong: gate something that has to stay open, or fail to gate at all.
 */

describe("the gate is off unless somebody turns it on", () => {
  it("is off when no password is configured", () => {
    // Every local and self-hosted install depends on this. An unset variable
    // must mean "no gate", not "gate with an empty password", which would lock
    // out everyone running this on their own machine.
    const before = process.env.MERRYMEN_SITE_PASSWORD;
    try {
      delete process.env.MERRYMEN_SITE_PASSWORD;
      assert.equal(gatePassword(), null);
      process.env.MERRYMEN_SITE_PASSWORD = "   ";
      assert.equal(gatePassword(), null, "whitespace is not a password");
      process.env.MERRYMEN_SITE_PASSWORD = "bellyache";
      assert.equal(gatePassword(), "bellyache");
    } finally {
      if (before === undefined) delete process.env.MERRYMEN_SITE_PASSWORD;
      else process.env.MERRYMEN_SITE_PASSWORD = before;
    }
  });

  it("is not in this repository", () => {
    // The password is read from the environment so it can be changed without a
    // deploy and so a git history never carries it.
    const src = readFileSync(new URL("./site-gate.ts", import.meta.url), "utf8");
    assert.match(src, /process\.env\.MERRYMEN_SITE_PASSWORD/);
    assert.ok(!/bellyache/i.test(src), "no password literal belongs in the source");
  });
});

describe("what the gate must never close", () => {
  it("leaves the API open", () => {
    // Telegram posts webhooks to it, the browser calls it after every page
    // load, and anything else running against this deployment talks to it.
    // Gating these would not hide an unfinished page, it would stop a fleet.
    for (const p of ["/api/theses", "/api/telegram", "/api/gate", "/api/grants"]) {
      assert.equal(isGatedPath(p), false, `${p} must stay open`);
    }
  });

  it("leaves the framework's own assets open", () => {
    // Gate these and the notice itself renders unstyled.
    for (const p of ["/_next/static/chunks/main.js", "/favicon.ico", "/sw.js", "/manifest.webmanifest"]) {
      assert.equal(isGatedPath(p), false, `${p} must stay open`);
    }
  });

  it("does not gate the gate", () => {
    assert.equal(isGatedPath(GATE_PATH), false, "the door cannot be behind itself");
  });

  it("gates the pages a visitor would land on", () => {
    for (const p of ["/", "/tokens", "/leaderboard", "/a/rrrshyq0pkx9x5z4", "/grant", "/settings"]) {
      assert.equal(isGatedPath(p), true, `${p} should be behind the notice`);
    }
  });
});

describe("the comparison", () => {
  it("accepts only the exact string", () => {
    assert.equal(sameSecret("bellyache", "bellyache"), true);
    assert.equal(sameSecret("bellyach", "bellyache"), false);
    assert.equal(sameSecret("bellyachee", "bellyache"), false);
    assert.equal(sameSecret("Bellyache", "bellyache"), false);
    assert.equal(sameSecret("", "bellyache"), false);
    assert.equal(sameSecret("", ""), true);
  });
});
