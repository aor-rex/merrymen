import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GENERATED_NAME_PARTS } from "@merrymen/core";

/**
 * THE NAME MUST BE READ BACK FROM WHERE IT WAS WRITTEN.
 *
 * The bug, written down because the owner hit it four times and reasonably
 * concluded the save was broken. It never was.
 *
 * Hosted, a tenant's settings are written to the per-tenant sealed store
 * (`getSettingsStore().put(tenant, …)` in api/settings). The web container's own
 * `~/.merrymen/settings.json` is written by nothing, and could not hold a
 * particular tenant's settings even if it existed — it is one file per
 * container, shared by every tenant. /api/feed read exactly that file, so the
 * read always threw and every hosted tenant got the fallback: the name went
 * null and the console fell back to the ledger's "Robin", while strategy and
 * basket showed house defaults regardless of what had been configured.
 *
 * It passed local testing because self-hosted the file IS the store, so the two
 * halves agree there and only there.
 */

const FEED = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
const SETTINGS = readFileSync(new URL("../settings/route.ts", import.meta.url), "utf8");
const WORKER = readFileSync(new URL("../../../../../worker/src/index.ts", import.meta.url), "utf8");
const SOUL = readFileSync(new URL("../../../../../worker/src/soul.ts", import.meta.url), "utf8");


/**
 * Characters that are invisible, or that a source file must never contain.
 *
 * BUILT, NOT WRITTEN. A NUL escape typed through one escaping layer too few
 * becomes a raw NUL byte — the accident worker/src/wiring.test.ts exists to
 * catch, and which it caught here. The same applies to the joiners and the
 * bidi override: written literally they are invisible in an editor, so a
 * reader cannot tell them apart from a typo.
 */
const ZWNJ = String.fromCharCode(0x200c); // zero-width non-joiner: Persian, Indic
const RLO = String.fromCharCode(0x202e); // right-to-left override: a spoofing tool
const ZWSP = String.fromCharCode(0x200b); // zero-width space: not a joiner
const NUL = String.fromCharCode(0x0);
const ACUTE = String.fromCharCode(0x301); // a combining mark, which cannot lead

describe("the feed reads identity from the tenant's own store", () => {
  it("hosted goes to the settings store, never to a file", () => {
    assert.match(FEED, /import \{ getSettingsStore \} from "@merrymen\/settings-store"/);
    assert.match(FEED, /if \(isHostedMode\(\)\)[\s\S]{0,300}?getSettingsStore\(\)\.get\(tenant\)/);
  });

  it("a signed-out hosted caller does NOT fall through to the file read", () => {
    // Load-bearing: falling through would show a signed-out visitor whatever
    // container-global config happened to be on disk.
    assert.match(FEED, /if \(!tenant\) return IDENTITY_FALLBACK;/);
  });

  it("identity is threaded with the tenant at every call site", () => {
    // The whole failure was one function that could not see who was asking.
    assert.match(FEED, /async function readIdentitySettings\(tenant: `0x\$\{string\}` \| null\)/);
    assert.match(FEED, /async function identityOf\(fromLedger: string, tenant: `0x\$\{string\}` \| null\)/);
    for (const m of FEED.matchAll(/identityOf\(([^)]*)\)/g)) {
      if (m[1]!.includes(":")) continue; // the declaration itself
      assert.match(m[0], /,\s*tenant\)|,\s*null\)/, `identityOf must be given a tenant: ${m[0]}`);
    }
  });

  it("the basket falls back to what the WORKER actually trades", () => {
    // TRADEABLE_SYMBOLS is the registry of what CAN be traded (14 symbols), not
    // the default holding (3). A tenant on defaults was shown a basket their
    // agent was never going to trade.
    assert.match(FEED, /const DEFAULT_BASKET = \[\.\.\.SETTINGS_DEFAULTS\.basketSymbols\]/);
    // Anchored to the IMPORT, not any mention — the comment above the constant
    // explains what it replaced, and matching prose would fail forever.
    assert.ok(!/^import[\s\S]*?TRADEABLE_SYMBOLS[\s\S]*?from "@merrymen\/core"/m.test(FEED));
  });
});

/**
 * The name rule as each file actually ships it, compiled from the source.
 *
 * Reading it out rather than restating it here is the point: a copy in the test
 * would let the two drift and still pass, which is the exact failure the
 * duplication comment in settings/route.ts warns about.
 */
function ruleIn(src: string): RegExp {
  // Found by the one class no other regex in either file carries, not by how
  // the rule happens to begin — the letter lookahead moved its first token.
  const m = src.match(/\/\^[^/\n]*\\p\{Join_Control\}[^/\n]*\/u/);
  assert.ok(m, "the name rule must be present and recognisable");
  return new RegExp(m[0].slice(1, -2), "u");
}

describe("the two name normalisers agree", () => {
  it("the API stores the SAME shape the soul does", () => {
    // The soul does `raw.normalize("NFC").trim().replace(/\s+/g, " ")`; the API
    // did a bare `.trim()`. The shared regex admits internal double spaces, so
    // "Little  John" was stored verbatim and collapsed by the soul — and the
    // reconcile's `cfg.agentName !== getName()` then stayed true forever. That
    // was one wasted write per re-arm before; once the reconcile runs every
    // tick it would be an identity-file rewrite every tick, silently, because
    // setName returns ok and logs nothing.
    //
    // ANCHORED ON BOTH FILES, not on one spelling. Pinning the literal made
    // this fail the moment NFC was added to both — a true statement reported
    // as a broken one, which is the failure mode that teaches people to edit
    // the assertion rather than read it.
    const shape = /\.normalize\("NFC"\)\.trim\(\)\.replace\(\/\\s\+\/g, " "\)/;
    assert.match(SETTINGS, shape, "the API must normalise before it stores");
    assert.match(SOUL, shape, "and the soul must do the identical thing");
  });

  it("BOTH ACCEPT A NAME IN THE OWNER'S OWN ALPHABET", () => {
    // This was `[A-Za-z0-9]` in both places, so José, Müller, Робин and 小红
    // were refused — at the END of the create wizard, in the same request that
    // carried the strategy, the caps and the paper/live choice, so one accent
    // discarded the whole form. And the message said "letters and numbers",
    // which is wrong guidance rather than merely unhelpful: é IS a letter, so
    // a reader who complied failed again.
    //
    // RUN, NOT MATCHED. An earlier version of this test compared the source
    // text and passed while `\p{Join_Control}` was silently missing its
    // backslash — which parses, and admits `{`, `}` and `_`. Building the
    // shipped rule and running names through it cannot be fooled that way.
    for (const [who, re] of [["settings", ruleIn(SETTINGS)], ["soul", ruleIn(SOUL)]] as const) {
      for (const name of [
        "Robin", "José", "Müller", "Łukasz", "Nguyễn", "Робин", "小红", "로빈",
        "रोबिन", "โรบิน", "রোবিন", "ரோபின்", "رَوبِن", "דוד", "Ελένη",
        "O'Brien", "St. John", "Jean-Luc", `محمد${ZWNJ}رضا`,
      ]) {
        assert.ok(re.test(name), `${who} must accept "${name}"`);
      }
    }
  });

  it("and neither admits a bidi override, which is what the narrow rule really bought", () => {
    // `[A-Za-z0-9]` excluded format characters as a side effect. The
    // replacement has to exclude them on purpose: a name is rendered next to
    // an agent's figures, and U+202E exists to make text display as something
    // other than what it is. `\p{Join_Control}` is the one exception, because
    // Persian and several Indic orthographies need ZWNJ inside a single word.
    for (const [who, re] of [["settings", ruleIn(SETTINGS)], ["soul", ruleIn(SOUL)]] as const) {
      for (const [name, why] of [
        [`Robin${RLO}evil`, "right-to-left override"],
        [`Robin${ZWSP}x`, "zero-width space"],
        [`Robin${NUL}`, "null"],
        [`${ACUTE}Robin`, "leading combining mark"],
        ["-Robin", "leading punctuation"],
        [" Robin", "leading space"],
        ["", "empty"],
        ["a".repeat(25), "over 24 characters"],
      ] as const) {
        assert.ok(!re.test(name), `${who} must refuse a name with a ${why}`);
      }
    }
  });

  it("a name has at least one letter, so it can never be read as a figure", () => {
    // A name renders beside an agent's return on a page that ranks people.
    // "99.5" or "1000" there reads as a number nobody measured — the same
    // failure as showing a figure for data nobody read, arriving by the name
    // field instead. Digits stay welcome inside a name that has a letter.
    for (const [who, re] of [["settings", ruleIn(SETTINGS)], ["soul", ruleIn(SOUL)]] as const) {
      for (const name of ["007", "2024", "99.5", "1 2 3", "4-20", "١٢٣", "१२३"]) {
        assert.ok(!re.test(name), `${who} must refuse the letterless "${name}"`);
      }
      for (const name of ["R2", "2Pac", "Agent 47", "7 Oaks", "小红2"]) {
        assert.ok(re.test(name), `${who} must still accept "${name}"`);
      }
    }
  });

  it("the two copies are still byte-identical", () => {
    // Behaviour above is what matters, but a drift that no listed name happens
    // to exercise would still split the web tier from the soul, and the worker
    // then silently keeps the old name. Same source, same rule.
    assert.equal(ruleIn(SETTINGS).source, ruleIn(SOUL).source);
  });

  it("every generated name passes both copies", () => {
    // The grants route writes a generated name into settings, and the worker
    // reconciles it into the soul. A combination either rule refused would be
    // stored by one tier and refused by the other: the owner is told the
    // agent is called one thing while it keeps answering to "Robin".
    for (const [who, re] of [["settings", ruleIn(SETTINGS)], ["soul", ruleIn(SOUL)]] as const) {
      for (const a of GENERATED_NAME_PARTS.adjectives) {
        for (const n of GENERATED_NAME_PARTS.nouns) {
          assert.ok(re.test(`${a} ${n}`), `${who} refuses the generated "${a} ${n}"`);
        }
      }
    }
  });
});

describe("the worker reconciles a rename whatever state the grant is in", () => {
  it("the reconcile runs BEFORE the kill, expiry and unchanged returns", () => {
    // PINNED AS SOURCE because index.ts exports nothing, so the ORDER inside
    // syncGrant cannot be reached any other way — the same reason
    // grant-expiry.test.ts pins its guard. What the reconcile DOES is executed
    // in worker/src/name-reconcile.test.ts against the real soul.
    //
    // Each return below it is a state in which a rename was lost. Below the
    // unchanged short-circuit, an armed agent never took one: a name forces no
    // re-arm, so `unchanged` is true forever. Below the expiry return, an
    // agent whose key lapsed never took one: the owner renamed it, the store
    // accepted it, and the leaderboard kept "Robin" for good. The reconcile is
    // a soul write and one UPDATE, no chain call, so it can run first.
    const sync = WORKER.slice(WORKER.indexOf("async function syncGrant()"));
    const reconcile = sync.indexOf("await reconcileName(");
    assert.ok(reconcile > 0, "syncGrant must reconcile the name");
    for (const [what, marker] of [
      ["kill", "if (!grant) {"],
      ["expiry", "grantExpired("],
      ["unchanged short-circuit", "if (unchanged) return true;"],
    ] as const) {
      const at = sync.indexOf(marker);
      assert.ok(at > 0, `sanity: the ${what} return still exists`);
      assert.ok(reconcile < at, `the name reconcile must run before the ${what} return`);
    }
  });
});
