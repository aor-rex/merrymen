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

describe("nothing sends a visitor to the internal listen address", () => {
  const ROUTE = readFileSync(new URL("../app/api/gate/route.ts", import.meta.url), "utf8");
  const MW = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("the POST handler builds no absolute redirect", () => {
    // This service starts with `next start -H 0.0.0.0`, so req.url inside a
    // route handler is the INTERNAL address. The first version redirected to
    // `new URL("/", req.url)` and the deployed site duly answered
    // 303 -> https://0.0.0.0:8080/ — a dead host, and the gate would have been
    // broken the moment anyone typed the right password.
    assert.ok(!/new URL\([^)]*req\.url/.test(strip(ROUTE)), "no redirect may be built from req.url");
    assert.match(ROUTE, /Location: path/);
  });

  it("does not trust a forwarded host to rebuild the origin", () => {
    // The obvious repair is worse than the bug: x-forwarded-host is supplied by
    // the caller, so a redirect built from it is an open redirect. A relative
    // Location resolves against the address the visitor actually used.
    // Comments stripped: both files explain at length why this header is not
    // trusted, and scanning the raw text would fail the rule on the paragraph
    // describing it.
    assert.ok(!/x-forwarded-host/i.test(strip(ROUTE)));
    assert.ok(!/x-forwarded-host/i.test(strip(MW)));
  });

  it("the middleware rewrites rather than redirects", () => {
    // A rewrite is resolved server-side and never reaches the browser, so the
    // internal origin cannot leak into one.
    assert.match(MW, /NextResponse\.rewrite\(to\)/);
    assert.ok(!/NextResponse\.redirect/.test(strip(MW)), "a redirect here would carry the internal host");
  });
});
