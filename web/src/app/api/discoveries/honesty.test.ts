import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * A FAILED READ MUST NOT BECOME A CLAIM ABOUT A COIN.
 *
 * The bug these pin, written down because it shipped and the owner screenshotted
 * it. The three enrichment reads fail as a wave — the RPC refuses the burst and
 * readTokenMeta, readCardFacts and readBlockClock all come back empty at the
 * same instant — and the route rendered that as `bare: m ? m.bare : true`. So
 * every card asserted "Published nothing about itself" and "no socials" about
 * coins that had published plenty, alongside a blank ticker and "— old".
 *
 * `readTokenMeta` returns a MAP specifically so a caller can tell "read and
 * empty" from "not read" — its own docstring says so — and the route threw that
 * distinction away one file away from where the same mistake had just been fixed
 * for the market index. That makes three times in this codebase that "could not
 * ask" was rendered as "nothing there", which is why it is now a test.
 */

// THE READ AND ITS HTTP WRAPPER, SCANNED TOGETHER.
//
// Most of this was one file. The read moved to lib/read-discoveries so a server
// component could share its single-flight memo instead of fetching this process
// over the network, which left the cache-control behaviour here and everything
// else there. The properties below are about the discoveries read AS A WHOLE,
// so the whole is what they read — splitting them across two constants would
// mean deciding, per assertion, which half is allowed to satisfy it, and the
// first one filed under the wrong half would pass by accident forever.
const ROUTE =
  readFileSync(new URL("../../../lib/read-discoveries.ts", import.meta.url), "utf8") +
  readFileSync(new URL("./route.ts", import.meta.url), "utf8");
/**
 * The coins view moved out of the console onto its own page. These assertions
 * follow it: the properties belong to the CARDS and to the ORDER the page
 * checks its empty states in, not to the file that happened to hold them.
 */
const CARDS = readFileSync(new URL("../../../components/TokenCards.tsx", import.meta.url), "utf8");
const PAGE = readFileSync(new URL("../../tokens/TokensClient.tsx", import.meta.url), "utf8");

describe("an unread coin is not accused of silence", () => {
  it("`bare` defaults to FALSE when the metadata read failed", () => {
    // `m ? m.bare : true` is the exact shape of the bug: no metadata read
    // becomes a positive assertion that the launcher published nothing.
    assert.ok(
      !/bare:\s*m\s*\?\s*m\.bare\s*:\s*true/.test(ROUTE),
      "a missing metadata read must never assert that the coin published nothing",
    );
    assert.match(ROUTE, /bare:\s*m\s*\?\s*m\.bare\s*:\s*false/);
  });

  it("the card only says 'published nothing' when the read actually succeeded", () => {
    // Three states, not two: has a description / read and genuinely empty /
    // never read. The middle one is the only one that earns the sentence.
    assert.match(CARDS, /f\.description \?[\s\S]{0,200}?:\s*f\.bare \?/);
  });

  it("a missing ticker renders the ADDRESS, not the word 'unnamed'", () => {
    // "unnamed" is a statement about the coin. The coin has a name; we failed
    // to fetch it. The address is true and still useful.
    assert.ok(!/f\.symbol \|\| "unnamed"/.test(CARDS));
    assert.match(CARDS, /f\.symbol \|\| short\(f\.token\)/);
  });
});

describe("a wave failure is reported once, not per coin", () => {
  it("the route carries a per-page chain status", () => {
    assert.match(ROUTE, /export interface ChainStatus/);
    assert.match(ROUTE, /meta:\s*boolean/);
    assert.match(ROUTE, /facts:\s*boolean/);
    assert.match(ROUTE, /clock:\s*boolean/);
  });

  it("each of the three reads is tracked SEPARATELY", () => {
    // ageSec comes from the clock, a third call that fails on its own — a row
    // can have meta and facts and still have no age, so one boolean would be
    // wrong about which fields are actually missing.
    assert.match(ROUTE, /chain\.meta = /);
    assert.match(ROUTE, /chain\.facts = /);
    assert.match(ROUTE, /chain\.clock = /);
  });

  it("the console renders the gap once, above the grid", () => {
    assert.match(CARDS, /function chainGap/);
    // Computed ONCE at the top of the page and rendered above the grid, never
    // per card — the three on-chain reads fail as a wave, so thirty copies of
    // "unknown" would read as thirty broken coins instead of one bad read.
    assert.match(PAGE, /const gap = disc \? chainGap\(disc\) : "";/);
    assert.match(PAGE, /\{gap && <div className="mm-readfail">/);
  });

  it("chainGap tolerates a payload from before the field existed", () => {
    // A cached response mid-deploy has no `chain`, and reading `.meta` off
    // undefined would blank the whole page over a missing banner.
    assert.match(CARDS, /if \(!c\) return "";/);
  });
});

describe("a degraded read is not cached like a good one", () => {
  it("the enrichment reads are sequential, not a burst", () => {
    // The burst is what the node refuses. All three used to run in one
    // Promise.all straight after two heavy log sweeps.
    assert.ok(
      !/Promise\.all\(\[\s*readTokenMeta/.test(ROUTE),
      "the three enrichment reads must not fire as one burst",
    );
    assert.match(ROUTE, /await readTokenMeta[\s\S]{0,400}?await sleep\([\s\S]{0,200}?await readCardFacts/);
  });

  it("a degraded render gets a short life, a whole one the full TTL", () => {
    // Measured in production: one bad render was served x-nextjs-cache: HIT for
    // six consecutive polls — about two and a half minutes — while the
    // underlying read had already recovered. The cache, not the RPC, is what
    // made a blink into an outage.
    // Every read counts, including the launchpad sweep that produces the rows.
    assert.match(ROUTE, /const degraded =[\s\S]{0,160}?!chain\.launchpad/);
    for (const k of ["meta", "facts", "clock"]) {
      assert.match(ROUTE, new RegExp(`const degraded =[\\s\\S]{0,160}?!chain\\.${k}`));
    }
    assert.match(ROUTE, /payload\.degraded/);
    assert.match(ROUTE, /s-maxage=10, stale-while-revalidate=0/);
  });

  it("single-flight, because the route is dynamic and every tab polls it", () => {
    // Without it, N tabs missing together each fire two heavy log sweeps plus
    // three enrichment reads — manufacturing the very burst this fixes.
    assert.match(ROUTE, /let inFlight: Promise<Payload> \| null/);
    assert.match(ROUTE, /if \(inFlight\) return inFlight;/);
    // Anchored to a real export, not a mention: the comment above the memo
    // explains what it replaced, and matching prose would fail forever.
    assert.ok(!/^export const revalidate/m.test(ROUTE), "ISR cannot refuse to cache a degraded render");
    assert.match(ROUTE, /^export const dynamic = "force-dynamic";/m);
  });
});

/**
 * "COULD NOT READ THE LAUNCHPAD" IS NOT "THE LAUNCHPAD IS QUIET".
 *
 * The same mistake as `bare`, one level up, and the one actually biting today.
 * The node caps an eth_getLogs response at 10,000 entries, and the activity
 * sweep asks for BOTH sides of every curve trade on the chain. Measured
 * 2026-08-30 over the 9,000-block window: buys alone 6,024, buys+sells over the
 * cap — the node answers `-32000 logs matched by query exceeds limit of 10000`,
 * readCurveActivity returns null, and the page rendered "Nothing launched in
 * the last few minutes has anyone trading it" about a launchpad running at
 * roughly 940 launches an hour.
 *
 * That is deterministic above a level of activity, not bad luck: it arrives for
 * good the day the chain gets busy.
 */
describe("a launchpad that could not be read is not reported as quiet", () => {
  it("the route tracks the launchpad read separately from the enrichment", () => {
    assert.match(ROUTE, /launchpad:\s*boolean/);
    assert.match(ROUTE, /chain\.launchpad = true;/);
  });

  it("the page distinguishes unreadable from quiet, and checks the flag first", () => {
    const unreadable = PAGE.indexOf("!disc.chain.launchpad");
    const quiet = PAGE.indexOf("Nothing launched in the last few minutes");
    assert.ok(unreadable > 0, "the page must handle an unreadable launchpad");
    assert.ok(unreadable < quiet, "the unreadable case must be checked BEFORE the empty-list case");
  });
});
