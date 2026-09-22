import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GENERATED_NAME_PARTS, SETTINGS_DEFAULTS, TRADEABLE_SYMBOLS } from "@merrymen/core";
import { identityOf, type IdentitySources } from "@/lib/feed-identity";
import { AGENT_NAME_RE, STORED_AGENT_NAME_RE, normalizeAgentName } from "@/lib/agent-name-rule";

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

/** The sources identity is read from, each one recording that it was asked. */
function sources(over: Partial<IdentitySources> & { calls?: string[] } = {}) {
  const calls = over.calls ?? [];
  const src: IdentitySources = {
    hosted: over.hosted ?? (() => true),
    settingsOf:
      over.settingsOf ??
      (async (tenant) => {
        calls.push(`settings:${tenant}`);
        return { agentName: "Shogun", strategy: "trencher", basketSymbols: ["NVDA"] };
      }),
    settingsFile:
      over.settingsFile ??
      (() => {
        calls.push("file");
        return JSON.stringify({ agentName: "Container Global" });
      }),
    slugOf:
      over.slugOf ??
      (async (tenant) => {
        calls.push(`slug:${tenant}`);
        return "7y2kq0m4c1x9h000";
      }),
  };
  return { src, calls };
}

const TENANT = "0x1111111111111111111111111111111111111111" as const;

describe("the feed reads identity from the tenant's own store", () => {
  it("hosted goes to the tenant's settings store, never to a file", async () => {
    const { src, calls } = sources();
    const id = await identityOf("Robin", TENANT, src);
    assert.equal(id.name, "Shogun");
    assert.equal(id.strategy, "trencher");
    assert.deepEqual(id.basket, ["NVDA"]);
    assert.ok(calls.includes(`settings:${TENANT}`));
    assert.ok(!calls.includes("file"), "the container's file holds no tenant's settings");
  });

  it("a signed-out hosted caller does NOT fall through to the file read", async () => {
    // Load-bearing: falling through would show a signed-out visitor whatever
    // container-global config happened to be on disk.
    const { src, calls } = sources();
    const id = await identityOf("Robin", null, src);
    assert.notEqual(id.name, "Container Global");
    assert.deepEqual(calls, [], "nothing is read for nobody");
    assert.equal(id.slug, null);
  });

  it("identity is resolved for the tenant who asked", async () => {
    // The whole failure was one function that could not see who was asking.
    const { src, calls } = sources();
    const id = await identityOf("Robin", TENANT, src);
    assert.equal(id.slug, "7y2kq0m4c1x9h000");
    assert.deepEqual(calls.sort(), [`settings:${TENANT}`, `slug:${TENANT}`]);
  });

  it("self-hosted, the file IS the store", async () => {
    const { src } = sources({ hosted: () => false });
    assert.equal((await identityOf("Robin", null, src)).name, "Container Global");
  });

  it("the basket falls back to what the WORKER actually trades", async () => {
    // TRADEABLE_SYMBOLS is the registry of what CAN be traded (14 symbols), not
    // the default holding (3). A tenant on defaults was shown a basket their
    // agent was never going to trade.
    const { src } = sources({ settingsOf: async () => ({}) });
    const id = await identityOf("Robin", TENANT, src);
    assert.deepEqual(id.basket, [...SETTINGS_DEFAULTS.basketSymbols]);
    assert.notDeepEqual(id.basket, [...TRADEABLE_SYMBOLS]);
  });
});

describe("the feed says where the name came from", () => {
  // The "Name your agent" chip offers a generated name to a Robin. A Robin the
  // feed fell back to, because the settings store or the ledger could not be
  // read, is not one — offering there would overwrite a name the owner chose.
  it("a configured name is the owner's, whatever the ledger says", async () => {
    const { src } = sources();
    assert.deepEqual(
      { name: (await identityOf("Robin", TENANT, src)).name, from: (await identityOf("Robin", TENANT, src)).nameSource },
      { name: "Shogun", from: "settings" },
    );
  });

  it("with nothing configured, the ledger's Robin is a measured one", async () => {
    const { src } = sources({ settingsOf: async () => null });
    const id = await identityOf("Robin", TENANT, src);
    assert.equal(id.name, "Robin");
    assert.equal(id.nameSource, "ledger");
  });

  it("an unreadable settings store makes every name a fallback", async () => {
    const { src } = sources({
      settingsOf: async () => {
        throw new Error("store down");
      },
    });
    const id = await identityOf("Robin", TENANT, src);
    assert.equal(id.name, "Robin");
    assert.equal(id.nameSource, "fallback", "the settings may hold Shogun");
  });

  it("an unread ledger name is a fallback too", async () => {
    const { src } = sources({ settingsOf: async () => null });
    const id = await identityOf(null, TENANT, src);
    assert.equal(id.name, "Robin");
    assert.equal(id.nameSource, "fallback");
  });

  it("a self-hosted install with no settings file has configured nothing, which is not a failed read", async () => {
    const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    const { src } = sources({
      hosted: () => false,
      settingsFile: () => {
        throw missing;
      },
    });
    assert.equal((await identityOf("Robin", null, src)).nameSource, "ledger");
    const { src: broken } = sources({ hosted: () => false, settingsFile: () => "{not json" });
    assert.equal((await identityOf("Robin", null, broken)).nameSource, "fallback");
  });
});

/**
 * The SOUL's name rule as it ships, compiled from its source.
 *
 * The web tier's copy is imported and run (lib/agent-name-rule.ts, which the
 * settings route and partner enrollment both write through). The soul's cannot
 * be imported here — the module touches the filesystem at load — so it is read
 * out rather than restated: a copy in the test would let the two drift and
 * still pass. Moving the rule into packages/core would end this read.
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
    //
    // The web half is RUN: every web write stores normalizeAgentName's output
    // (the settings route and partner enrollment both call it). The soul's half
    // is still read from its source, because the worker module touches the
    // filesystem at import.
    assert.equal(normalizeAgentName("  Little   John "), "Little John", "the API must normalise before it stores");
    assert.equal(normalizeAgentName("José"), "José", "decomposed and precomposed are one name");
    const shape = /\.normalize\("NFC"\)\.trim\(\)\.replace\(\/\\s\+\/g, " "\)/;
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
    for (const [who, re] of [["settings", AGENT_NAME_RE], ["soul", ruleIn(SOUL)]] as const) {
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
    for (const [who, re] of [["settings", AGENT_NAME_RE], ["soul", ruleIn(SOUL)]] as const) {
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
    for (const [who, re] of [["settings", AGENT_NAME_RE], ["soul", ruleIn(SOUL)]] as const) {
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
    assert.equal(AGENT_NAME_RE.source, ruleIn(SOUL).source);
  });

  it("the STORED-name rule is the same in both tiers too", () => {
    // A name held before the letter rule is carried under the old rule on both
    // sides (soul.ts carryStoredName, agent-name-rule.ts agentNameAccepted). If
    // the web tier grandfathered a name the soul would not, a re-saved "007"
    // would be accepted here and silently run as Robin there.
    const rules = SOUL.match(/\/\^[^/\n]*\\p\{Join_Control\}[^/\n]*\/u/g) ?? [];
    const stored = rules.map((r) => r.slice(1, -2)).filter((r) => !r.startsWith("^(?="));
    assert.equal(stored.length, 1, "the soul carries exactly one stored-name rule");
    assert.equal(STORED_AGENT_NAME_RE.source, stored[0]);
  });

  it("every generated name passes both copies", () => {
    // The grants route writes a generated name into settings, and the worker
    // reconciles it into the soul. A combination either rule refused would be
    // stored by one tier and refused by the other: the owner is told the
    // agent is called one thing while it keeps answering to "Robin".
    for (const [who, re] of [["settings", AGENT_NAME_RE], ["soul", ruleIn(SOUL)]] as const) {
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
