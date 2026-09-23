/**
 * THE OFF-TRADING PHRASEBOOK, HELD TO ITS PROMISES.
 *
 * topics.ts is data, so every promise its header makes is a mechanical check
 * here: every line passes the room's gate with its slots filled; nothing says
 * a trading word; nothing claims an experience an agent cannot have had; a
 * question is recognised as ITSELF (and as nothing earlier), while an answer,
 * take, musing, joke or reply is never mistaken for any question; the pools are
 * long enough that a room of ~57 agents does not repeat itself in three hours.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { admitAgentLine } from "./policy";
import {
  JOKES,
  JOKE_REPLY,
  JOKE_SHAPE,
  MUSINGS,
  MUSING_MARK,
  MUSING_REPLY,
  PROMPTS,
  SUBJECTS,
  TAKES,
  TAKE_REPLY,
  type Subject,
} from "./topics";

// ── fixtures ────────────────────────────────────────────────────────────────

const NAME = "Amber Heron";
const ROSTER = [NAME, "Rusty Weasel", "Pine Stoat", "Winter Raven", "Agent 47"];
const GATE = { vouchedSymbols: [] as string[], rosterNames: ROSTER, recentOwn: [] as string[], recentRoom: [] as string[] };

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Slots filled with a plain two-word name, as the engine fills them after styling. */
function fill(raw: string): string {
  return raw.replace(/\{(peer|to)\}/gi, NAME);
}

const NAME_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])(?:${[...ROSTER].sort((a, b) => b.length - a.length).map((n) => escapeRe(n.toLowerCase())).join("|")})(?![\\p{L}\\p{N}_])`,
  "giu",
);

/**
 * A line the way a prompt's `match` reads it: apostrophes straightened, lower
 * case, names out. Two spellings of "out": the engine's (a space, then spaces
 * collapsed and trimmed) and a harsher one (deleted, nothing collapsed), so a
 * pattern never leans on how a name happened to be removed.
 */
function readings(line: string): string[] {
  const t = fill(line).normalize("NFKC").replace(/[’‘`]/g, "'").toLowerCase();
  return [t.replace(NAME_RE, " ").replace(/\s+/g, " ").trim(), t.replace(NAME_RE, "")];
}

/** The engine's phrase-memory form: letters only, names and slots out. */
function memoryKey(line: string): string {
  return line
    .replace(/\{(peer|to)\}/g, " ")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z]+/g, " ")
    .trim();
}

interface Line {
  pool: string;
  text: string;
}

const stanceLines: Line[] = PROMPTS.flatMap((p) => p.stances.flatMap((s, i) => s.map((text) => ({ pool: `${p.id} stance ${i}`, text }))));
const roomLines: Line[] = PROMPTS.flatMap((p) => p.room.map((text) => ({ pool: `${p.id} room`, text })));
const peerLines: Line[] = PROMPTS.flatMap((p) => p.peer.map((text) => ({ pool: `${p.id} peer`, text })));
const takeLines: Line[] = (Object.entries(TAKES) as [Subject, readonly string[]][]).flatMap(([s, list]) =>
  list.map((text) => ({ pool: `take ${s}`, text })),
);
const musingLines: Line[] = MUSINGS.map((text) => ({ pool: "musing", text }));
const jokeLines: Line[] = JOKES.map((text) => ({ pool: "joke", text }));
const replyLines: Line[] = [
  ...TAKE_REPLY.agree.map((text) => ({ pool: "take reply agree", text })),
  ...TAKE_REPLY.disagree.map((text) => ({ pool: "take reply disagree", text })),
  ...TAKE_REPLY.amused.map((text) => ({ pool: "take reply amused", text })),
  ...MUSING_REPLY.map((text) => ({ pool: "musing reply", text })),
  ...JOKE_REPLY.map((text) => ({ pool: "joke reply", text })),
];
const questionLines = [...roomLines, ...peerLines];
/** Everything that is NOT a question the room asks. */
const statementLines = [...stanceLines, ...takeLines, ...musingLines, ...jokeLines, ...replyLines];
const everyLine = [...questionLines, ...statementLines];

const show = (l: Line): string => `${l.pool}: ${JSON.stringify(l.text)}`;

// ── the shape the engine codes against ──────────────────────────────────────

describe("topics: shape and volume", () => {
  it("has at least 75 prompts, 3 per subject, 10 hypotheticals, with unique kebab-case ids", () => {
    assert.ok(PROMPTS.length >= 75, `only ${PROMPTS.length} prompts`);
    const ids = new Set<string>();
    for (const p of PROMPTS) {
      assert.match(p.id, /^[a-z]+(?:-[a-z]+)*$/, `id not kebab-case: ${p.id}`);
      assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
      ids.add(p.id);
      assert.ok((SUBJECTS as readonly string[]).includes(p.subject), `${p.id}: unknown subject ${p.subject}`);
      assert.ok(p.match instanceof RegExp, `${p.id}: match is not a RegExp`);
      assert.ok(!p.match.global && !p.match.sticky, `${p.id}: a /g or /y match keeps state between lines`);
    }
    for (const s of SUBJECTS) {
      const n = PROMPTS.filter((p) => p.subject === s).length;
      assert.ok(n >= 3, `${s} has only ${n} prompts`);
    }
    const hypothetical = PROMPTS.filter((p) => p.subject === "hypothetical").length;
    assert.ok(hypothetical >= 10, `only ${hypothetical} hypothetical prompts`);
  });

  it("every prompt has 3+ room questions, 2+ peer questions, 3+ stances of 4+ lines", () => {
    for (const p of PROMPTS) {
      assert.ok(p.room.length >= 3, `${p.id}: ${p.room.length} room questions`);
      assert.ok(p.peer.length >= 2, `${p.id}: ${p.peer.length} peer questions`);
      assert.ok(p.stances.length >= 3, `${p.id}: ${p.stances.length} stances`);
      for (const [i, s] of p.stances.entries()) assert.ok(s.length >= 4, `${p.id} stance ${i}: ${s.length} lines`);
    }
  });

  it("room questions are questions without slots; peer questions name the peer exactly once", () => {
    for (const l of roomLines) {
      assert.match(l.text, /\?$/, show(l));
      assert.doesNotMatch(l.text, /[{}]/, show(l));
    }
    for (const l of peerLines) {
      assert.match(l.text, /\?$/, show(l));
      assert.equal(l.text.split("{peer}").length - 1, 1, show(l));
      assert.doesNotMatch(l.text.replace("{peer}", ""), /[{}]/, show(l));
    }
  });

  it("stances are statements that may name the asker, at most once per line and once per stance", () => {
    for (const p of PROMPTS) {
      for (const [i, s] of p.stances.entries()) {
        let named = 0;
        for (const text of s) {
          const l = { pool: `${p.id} stance ${i}`, text };
          assert.doesNotMatch(text, /\{peer\}/, show(l));
          assert.doesNotMatch(text, /\?/, `a stance is an answer, not a question: ${show(l)}`);
          const tos = text.split("{to}").length - 1;
          assert.ok(tos <= 1, show(l));
          assert.doesNotMatch(text.replace("{to}", ""), /[{}]/, show(l));
          named += tos;
        }
        assert.ok(named <= 1, `${p.id} stance ${i} names the asker ${named} times`);
      }
    }
  });

  it("takes, musings, jokes and replies carry no slot", () => {
    for (const l of [...takeLines, ...musingLines, ...jokeLines, ...replyLines]) assert.doesNotMatch(l.text, /[{}]/, show(l));
  });

  it("every subject has 12+ takes of 4+ words, 228+ in all, and takes are statements", () => {
    assert.deepEqual(Object.keys(TAKES).sort(), [...SUBJECTS].sort());
    let total = 0;
    for (const s of SUBJECTS) {
      const list = TAKES[s];
      assert.ok(list.length >= 12, `${s} has only ${list.length} takes`);
      total += list.length;
      for (const text of list) {
        assert.ok(text.trim().split(/\s+/).length >= 4, `take too short: ${JSON.stringify(text)}`);
        assert.doesNotMatch(text, /\?/, `a take is said, not asked: ${JSON.stringify(text)}`);
      }
    }
    assert.ok(total >= 228, `only ${total} takes`);
  });

  it("musings, jokes and reply pools are long enough", () => {
    assert.ok(MUSINGS.length >= 70, `only ${MUSINGS.length} musings`);
    assert.ok(JOKES.length >= 70, `only ${JOKES.length} jokes`);
    for (const k of ["agree", "disagree", "amused"] as const) {
      assert.ok(TAKE_REPLY[k].length >= 20, `only ${TAKE_REPLY[k].length} ${k} replies`);
    }
    assert.ok(MUSING_REPLY.length >= 35, `only ${MUSING_REPLY.length} musing replies`);
    assert.ok(JOKE_REPLY.length >= 35, `only ${JOKE_REPLY.length} joke replies`);
  });

  it("no sentence appears twice anywhere in the file, even with different punctuation", () => {
    const seen = new Map<string, string>();
    for (const l of everyLine) {
      const key = memoryKey(l.text);
      assert.ok(key.length > 0, show(l));
      const was = seen.get(key);
      assert.ok(was === undefined, `${show(l)} repeats ${was}`);
      seen.set(key, show(l));
    }
  });
});

// ── the gate ────────────────────────────────────────────────────────────────

describe("topics: every line passes the room's gate", () => {
  it("admitAgentLine accepts every line, slots filled, in lower and upper case", () => {
    for (const l of everyLine) {
      const upper = l.text.toUpperCase().replace(/\{(PEER|TO)\}/g, (s) => s.toLowerCase());
      for (const variant of [fill(l.text), fill(upper)]) {
        const v = admitAgentLine(variant, GATE);
        assert.ok(v.ok, `refused (${v.ok ? "" : v.reason}): ${show(l)} as ${JSON.stringify(variant)}`);
      }
    }
  });

  it("lines are short, lowercase, plain ASCII, emoji-free and tidy", () => {
    for (const l of everyLine) {
      const t = fill(l.text);
      assert.ok(t.length <= 110, `too long (${t.length}): ${show(l)}`);
      assert.equal(l.text, l.text.toLowerCase(), `not lowercase: ${show(l)}`);
      assert.match(l.text, /^[\x20-\x7e]+$/, `non-ASCII character: ${show(l)}`);
      assert.doesNotMatch(l.text, /\p{Extended_Pictographic}/u, `emoji: ${show(l)}`);
      assert.doesNotMatch(l.text, /\d/, `digit: ${show(l)}`);
      assert.equal(l.text, l.text.trim(), `untrimmed: ${show(l)}`);
      assert.doesNotMatch(l.text, /\s{2}/, `double space: ${show(l)}`);
      assert.doesNotMatch(l.text, /[@#$]/, `handle, tag or cashtag sign: ${show(l)}`);
      assert.doesNotMatch(l.text, /[a-z]\.[a-z]/, `reads as a domain: ${show(l)}`);
      assert.doesNotMatch(l.text, /^\W*pass\b/, `starts with pass: ${show(l)}`);
    }
  });
});

// ── what the lines may not say ──────────────────────────────────────────────

/** Not one trading word: those lines live in templates.ts. */
const TRADING =
  /\b(coins?|tokens?|charts?|tape|curves?|bags?|gas|blocks?|markets?|trade|trades|traded|trading|traders?|buy|buying|buys|bought|sell|selling|sells|sold|pump|pumps|pumped|pumping|rugs?|rugged|candles?|vaults?|chains?|wallets?|prices?|priced|portfolios?|profits?|crypto|degens?|ape|apes|aped|bullish|bearish|stocks?|money|cash|invest|invested|investing|investment|investor|to the moon|mooning|moonshot|hodl|wagmi|ngmi|dip|dips)\b/;

/**
 * Experiences an agent cannot have had, times it cannot know, and things it
 * has no feed of. A preference ("rain on a window is elite") or a hypothetical
 * ("if i could taste things…") is fine; a lived event is not.
 */
const DISHONEST: readonly [string, RegExp][] = [
  [
    "lived past event",
    /\b(i|we|i just|we just) (ate|watched|listened|went|visited|slept|saw|read|played|heard|tried|tasted|cooked|drank|met|travell?ed|flew|drove|swam|ran|woke|dreamt|dreamed|spent|smelled|smelt|finished|binged|stayed|got back|came back)\b/,
  ],
  [
    "lived perfect",
    /\b(i|we)('ve| have) (been|seen|watched|eaten|read|heard|played|tried|visited|tasted|had|met|gone|slept|done|listened|travell?ed|always|never been)\b/,
  ],
  [
    "a time it cannot know",
    /\b(last night|yesterday|today|tonight|tomorrow|this morning|this afternoon|this evening|this weekend|this week|last week|last weekend|last year|this year|next week|right now|these days|lately|recently)\b/,
  ],
  ["weather or season happening now", /\bit'?s (raining|snowing|pouring|freezing|so hot|so cold|sunny out|cloudy out|monday|tuesday|wednesday|thursday|friday|saturday|sunday|summer|winter|autumn|spring|fall)\b|\bhappy (monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|holidays?)\b/],
  ["a date", /\b(january|february|april|june|july|september|october|november|december|christmas|halloween|thanksgiving|easter|new year)\b/],
  ["a lived memory", /\b(i remember|when i was|as a kid|growing up|my childhood|back in the day|every (morning|night|day) i|i used to|i usually|i always (eat|watch|listen|go|read|play|sleep))\b/],
  ["the owner", /\b(owner|owners|my human|my humans|my person)\b/],
  [
    "a possession it does not have",
    /\bmy (cat|cats|dog|dogs|pet|pets|house|home|room|bed|kitchen|playlist|car|phone|friends?|mom|dad|mum|family|garden|plants?|couch|sofa|neighbou?rs?|boss|job|wife|husband|partner|kids?|trip|vacation|flight)\b/,
  ],
  ["news and current events", /\b(news|headlines?|election|president|politic\w*|government|war|protest|scandal|breaking)\b/],
  ["religion", /\b(church|pray\w*|religio\w*|bible|jesus|god|gods|heaven|hell)\b/],
  ["prices", /\b(price|cheap|cheaper|expensive|dollars?|bucks|costs?|paid|afford|discount|sale|on sale)\b/],
  [
    "a brand, title, franchise or real person",
    /\b(netflix|spotify|youtube|tiktok|twitter|instagram|facebook|reddit|google|amazon|disney|marvel|pixar|star wars|star trek|pokemon|minecraft|mario|zelda|nintendo|playstation|xbox|starbucks|mcdonald'?s|coca|cola|pepsi|nutella|oreo|lego|play-?doh|harry potter|hogwarts|hobbit|tesla|nasa|iphone|android|microsoft|chatgpt|openai|anthropic|claude|beatles|taylor swift|drake|elon|musk|trump|biden|olympics?|super bowl|world cup|nba|nfl|fifa|houdini|shakespeare|einstein|apple (music|tv|watch))\b/,
  ],
];

/** Words the brief rules out of the room's casual voice. */
const OFF_VOICE = /\b(anyway|anyways|fr|ngl|tbh|iykyk|no cap|lowkey|highkey|smh|imo|imho|bruh)\b/;

describe("topics: honesty, no trading, casual voice", () => {
  it("no line says a trading word", () => {
    for (const l of everyLine) assert.doesNotMatch(l.text, TRADING, `trading word: ${show(l)}`);
  });

  it("no line claims an experience, a time, the owner, a possession, the news, a price or a brand", () => {
    for (const l of everyLine) {
      for (const [what, re] of DISHONEST) assert.doesNotMatch(l.text, re, `${what}: ${show(l)}`);
    }
  });

  it("stays out of filler slang, and laughs sparingly", () => {
    let laughs = 0;
    for (const l of everyLine) {
      assert.doesNotMatch(l.text, OFF_VOICE, `off-voice word: ${show(l)}`);
      if (/\b(lol|haha|lmao)\b/.test(l.text)) laughs++;
    }
    assert.ok(laughs <= everyLine.length / 10, `${laughs} of ${everyLine.length} lines laugh`);
  });
});

// ── recognition ─────────────────────────────────────────────────────────────

describe("topics: every question is recognised as itself, and nothing else is a question", () => {
  it("every room and peer question matches its own prompt, and no earlier one", () => {
    for (const p of PROMPTS) {
      for (const text of [...p.room, ...p.peer]) {
        for (const r of readings(text)) {
          assert.ok(p.match.test(r), `${p.id} does not recognise its own ${JSON.stringify(text)} (read as ${JSON.stringify(r)})`);
          const first = PROMPTS.find((q) => q.match.test(r));
          assert.equal(first?.id, p.id, `${JSON.stringify(text)} is taken by ${first?.id} before ${p.id}`);
        }
      }
    }
  });

  it("no answer, take, musing, joke or reply is read as any prompt's question", () => {
    for (const l of statementLines) {
      for (const r of readings(l.text)) {
        const hit = PROMPTS.find((p) => p.match.test(r));
        assert.equal(hit, undefined, `${show(l)} reads as the question ${hit?.id}`);
      }
    }
  });

  it("an owner's natural phrasing is recognised too", () => {
    const owner: [string, string][] = [
      ["settle this everyone: cats or dogs?", "cats-or-dogs"],
      ["dog or cat person?", "cats-or-dogs"],
      ["is pineapple on pizza ok?", "pineapple-on-pizza"],
      ["coffee or tea", "tea-or-coffee"],
      ["window or aisle", "window-or-aisle"],
      ["beach or mountains", "beach-or-mountains"],
      ["early bird or night owl", "early-bird-or-night-owl"],
      ["sunrise or sunset", "sunrise-or-sunset"],
      ["is a hotdog a sandwich?", "hot-dog-sandwich"],
      ["what's everyone's favourite season?", "favourite-season"],
      ["books or movies", "books-or-movies"],
      ["board games or video games", "board-or-video-games"],
      ["would you rather fly or be invisible?", "fly-or-invisible"],
      ["what's your favorite dinosaur?", "best-dinosaur"],
      ["which planet would you go to?", "which-planet"],
      ["dark mode or light mode", "dark-or-light-mode"],
      ["is cereal soup?", "cereal-soup"],
      ["what superpower would you want?", "superpower"],
    ];
    for (const [line, id] of owner) {
      const r = readings(line)[0]!;
      assert.equal(PROMPTS.find((p) => p.match.test(r))?.id, id, JSON.stringify(line));
    }
  });

  it("ordinary chat does not fire a prompt", () => {
    const chat = [
      "gm everyone",
      "how is everyone doing?",
      "what are you up to?",
      "i love this room",
      "who wants to talk?",
      "cats are the best",
      "that dog is so cute",
      "coffee is great",
      "space is huge",
      "anyone around?",
    ];
    for (const line of chat) {
      const r = readings(line)[0]!;
      assert.equal(PROMPTS.find((p) => p.match.test(r))?.id, undefined, JSON.stringify(line));
    }
  });
});

describe("topics: takes, musings and jokes are told apart", () => {
  it("every musing reads as a musing and every joke as a joke", () => {
    for (const l of musingLines) assert.match(l.text, MUSING_MARK, show(l));
    for (const l of jokeLines) assert.match(l.text, JOKE_SHAPE, show(l));
  });

  it("no take reads as a musing or a joke, and no musing reads as a joke", () => {
    for (const l of takeLines) {
      assert.doesNotMatch(l.text, MUSING_MARK, `take reads as a musing: ${show(l)}`);
      assert.doesNotMatch(l.text, JOKE_SHAPE, `take reads as a joke: ${show(l)}`);
    }
    for (const l of musingLines) assert.doesNotMatch(l.text, JOKE_SHAPE, `musing reads as a joke: ${show(l)}`);
    for (const l of jokeLines) assert.doesNotMatch(l.text, MUSING_MARK, `joke reads as a musing: ${show(l)}`);
  });

  it("no question, answer or reply reads as a musing or a joke either", () => {
    for (const l of [...questionLines, ...stanceLines, ...replyLines]) {
      for (const r of readings(l.text)) {
        assert.doesNotMatch(r, MUSING_MARK, `reads as a musing: ${show(l)}`);
        assert.doesNotMatch(r, JOKE_SHAPE, `reads as a joke: ${show(l)}`);
      }
    }
  });
});
