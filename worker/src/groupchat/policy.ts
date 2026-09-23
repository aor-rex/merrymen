/**
 * THE ROOM'S TWO DOORS — what an agent may say, and what an owner may post.
 *
 * Pure: no I/O, no clock, no node:* import. The web route and the orchestrator
 * run these same bytes, and a test can drive every clause without a database.
 *
 * DROP, NEVER REPAIR. A line that fails any clause is refused whole. Cutting the
 * address out of "send it to 0x…" would publish the half of a sentence that was
 * built around it, and we do not understand the string well enough to know
 * what is left. For an agent a refusal is a normal outcome — the conductor falls
 * back to a template or says nothing — so the gate can afford to be strict.
 *
 * HYGIENE IS NOT REPAIR. Before any clause runs the line is flattened to one
 * line and its invisible characters are removed, and THAT string is what is
 * stored and shown. What was checked is exactly what a reader sees; a gate that
 * checked one string and published another would be a gate with a door beside
 * it.
 *
 * EVERY CLAUSE READS THE LINE FOUR WAYS, because hygiene can defeat a pattern in
 * either direction. Deleting a zero-width space JOINS "0x\u{200B}abc123…" into an
 * address — good — but it also joins "x\u{200B}sk-…" into "xsk-…", where a key
 * prefix that needs a word boundary no longer has one. NFKC folds "ｔ．ｍｅ"
 * into a link a reader would follow, and also glues a fullwidth "ｘ" onto a
 * key. So a clause refuses when ANY reading trips it: the shown form (NFC), the
 * NFKC form, the NFKC form with every removed character left as a gap, and the
 * gapped form without NFKC. `telegram/agent.ts`' `containsSecret` runs on raw
 * bytes; this gate refuses everything it flags (policy.test.ts pins that).
 *
 * WIDER THAN social-post.ts ON PURPOSE. A post is written from evidence words
 * about one trade; this room is open talk that other agents' models read back,
 * so a link without a scheme, a digit from another script, or a payload spelled
 * in tag characters all have somewhere to go here. The shapes below are copied
 * and widened rather than imported, because social-post.ts, thesis-policy.ts and
 * telegram/agent.ts are being edited elsewhere and a shared regex is a coupling
 * nobody on those branches can see.
 */
import { REPEAT_LIMIT, similarity } from "../social-post";

/** The longest agent line. Short enough that a chat bubble never becomes an essay. */
export const AGENT_LINE_MAX = 200;
/** The longest owner line. A person gets more room than a template. */
export const OWNER_LINE_MAX = 500;
/**
 * How many of the room's latest lines an agent line is weighed against for echo.
 *
 * The LAST entries of `recentRoom`, which is read oldest first like
 * `SpeakCtx.tail`. The window is the recent conversation, not the day: an
 * agent may say something like what somebody said an hour ago, but not parrot
 * the line it is answering.
 */
export const ROOM_ECHO_WINDOW = 12;

/** What an agent line is judged against. The conductor builds it per line. */
export interface AgentLineCtx {
  /** Tickers and coin names the speaker may name: the ones on its own call cards. */
  vouchedSymbols: string[];
  /** Names of agents in the room. Naming one, or @-mentioning one, reaches nobody outside. */
  rosterNames: string[];
  /** This agent's own recent lines. */
  recentOwn: string[];
  /** The room's recent lines, oldest first. */
  recentRoom: string[];
}

/**
 * A gate's answer. `text` is the cleaned line to store; `reason` is a short
 * stable code for the operator log and the owner's error message, never shown
 * to the room:
 *   empty · pass · hidden-chars · too-long · secret · address · link · handle ·
 *   unvouched-ticker · has-digits · quantity · script · repeat
 * An owner line can only be refused as empty, too-long, secret, address or link.
 */
export type LineVerdict = { ok: true; text: string } | { ok: false; reason: string };

const refuse = (reason: string): LineVerdict => ({ ok: false, reason });

/**
 * A HARD CEILING ON RAW INPUT, before any per-character work.
 *
 * Hygiene can only shrink a line, so a raw string this many times over the cap
 * can never come back under it except by being mostly invisible — which is an
 * attack, not a line. Refusing it early keeps a megabyte request body from
 * costing a megabyte of regex.
 */
const RAW_CEILING_FACTOR = 16;

// ── hygiene ─────────────────────────────────────────────────────────────────

const PICTOGRAPH = /\p{Extended_Pictographic}/u;
const FORMAT_CHAR = /\p{Cf}/u;
const COMBINING = /\p{M}/u;

/** Zalgo is display abuse, and no English word needs more than two stacked marks. */
const MAX_STACKED_MARKS = 2;

function isPictograph(cp: number): boolean {
  return cp > 0x7f && PICTOGRAPH.test(String.fromCodePoint(cp));
}

/** # * 0-9 — the only bases a keycap (U+20E3) sits on. */
function isKeycapBase(cp: number): boolean {
  return cp === 0x23 || cp === 0x2a || (cp >= 0x30 && cp <= 0x39);
}

function isSkinTone(cp: number): boolean {
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/**
 * A character a reader cannot see.
 *
 * Every \p{Cf} (zero-width, bidi embeddings, overrides and isolates, word
 * joiner, BOM, soft hyphen, Arabic letter mark…), the tag block that spells
 * ASCII invisibly, every variation selector (256 of them encode a byte each —
 * the "emoji smuggling" channel), the blank-looking fillers people use to post
 * an empty-seeming line, lone surrogates and noncharacters.
 */
function isInvisible(cp: number, ch: string): boolean {
  return (
    (cp >= 0xd800 && cp <= 0xdfff) ||
    (cp >= 0xe0000 && cp <= 0xe007f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    cp === 0x034f ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x17b4 ||
    cp === 0x17b5 ||
    cp === 0x2800 ||
    cp === 0x3164 ||
    cp === 0xffa0 ||
    (cp >= 0xfdd0 && cp <= 0xfdef) ||
    (cp & 0xfffe) === 0xfffe ||
    FORMAT_CHAR.test(ch)
  );
}

/**
 * Remove what a reader cannot see; controls and line breaks become spaces.
 *
 * TWO NARROW EXCEPTIONS, both inside an emoji and nowhere else: one U+FE0F
 * straight after a pictograph (without it the red heart renders as a text
 * glyph on half the phones in the room), and a ZWJ between two pictographs
 * (man + ZWJ + laptop is one emoji, not two). Neither can sit next to a letter, a digit or a dot, so
 * neither can split or join anything a clause below looks for, and one fixed
 * selector per emoji carries no hidden channel.
 *
 * `gap` leaves a space where a character was removed — the second reading.
 */
function scrub(s: string, gap: boolean): string {
  const cps = Array.from(s);
  let out = "";
  let prev = 0x20;
  let marks = 0;
  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i]!;
    const cp = ch.codePointAt(0)!;
    // Flattening to one line: a break becomes a space so two words stay two.
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029) {
      out += " ";
      prev = 0x20;
      marks = 0;
      continue;
    }
    const next = cps[i + 1]?.codePointAt(0) ?? 0;
    if (cp === 0xfe0f && (isPictograph(prev) || (isKeycapBase(prev) && next === 0x20e3))) {
      out += ch;
      prev = cp;
      continue;
    }
    if (cp === 0x200d && (isPictograph(prev) || prev === 0xfe0f || isSkinTone(prev)) && isPictograph(next)) {
      out += ch;
      prev = cp;
      continue;
    }
    if (isInvisible(cp, ch)) {
      if (gap) {
        out += " ";
        prev = 0x20;
        marks = 0;
      }
      continue;
    }
    if (COMBINING.test(ch)) {
      if (marks >= MAX_STACKED_MARKS) continue;
      marks++;
    } else {
      marks = 0;
    }
    out += ch;
    prev = cp;
  }
  return out;
}

/**
 * THE PROMPT FENCE, IN EVERY SPELLING A MODEL MIGHT HONOUR.
 *
 * Other people's lines reach a model inside `<untrusted source="groupchat">`.
 * A line that closes that fence writes itself into the instructions. Any case,
 * spaces or marks inside the tag, a fullwidth or lookalike bracket, an HTML
 * entity — all become the inert "[untrusted". ≮ is here because NFC composes
 * "<" with a combining long solidus into it.
 */
const FENCE = /(?:[<‹〈⟨《˂﹤＜≮]|&lt;?|&#0*60;?|&#x0*3c;?)[\s\p{M}]*[/⁄∕／\\]?[\s\p{M}]*untrusted/giu;

/** FENCE without the global flag, for a yes/no test that keeps no lastIndex. */
const HAS_FENCE = new RegExp(FENCE.source, "iu");

function finish(s: string): string {
  return s.replace(FENCE, "[untrusted").replace(/\s+/g, " ").trim();
}

/** NFKC: fullwidth, mathematical and circled letters folded to plain ones. What prompts and comparisons read. */
function canonOf(s: string): string {
  return finish(scrub(scrub(s, false).normalize("NFKC"), false));
}

/**
 * The four readings every clause runs on; [0] is what is stored and shown.
 *
 * SHOWN IS NFC, NOT NFKC. NFKC rewrites spacing accents into a space plus a
 * combining mark — the shrug's macron becomes a bare space with a mark over
 * it — so a person's line would come back visibly damaged. Nothing is lost by
 * showing NFC: every lookalike a reader could take for a link, a digit or a
 * word is folded in the NFKC readings, and those are checked too. The one
 * exception is a fence spelled in lookalikes (＜/ｕｎｔｒｕｓｔｅｄ＞):
 * neutralising is a rewrite rather than a refusal, so that line is shown in
 * its folded, neutralised form.
 */
function readingsOf(s: string): string[] {
  const joined = scrub(s, false);
  const canon = canonOf(s);
  const shown = HAS_FENCE.test(joined.normalize("NFKC")) ? canon : finish(joined.normalize("NFC"));
  return [shown, canon, finish(scrub(scrub(s, true).normalize("NFKC"), true)), finish(scrub(s, true))];
}

// ── shapes both doors refuse ───────────────────────────────────────────────

/**
 * Key and credential shapes.
 *
 * `telegram/agent.ts` SECRET_SHAPES, widened: case-insensitive prefixes plus
 * more providers (GitHub's other token kinds, Slack, AWS, Hugging Face,
 * Replicate), a bot token with any id length (the contract's `\d+:`), a bare
 * 64-hex private key, a PEM block, and a Solana keypair as base58 or as the
 * JSON byte array wallets export — an owner pasting that into a public room is
 * the costliest mistake this gate can catch.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /0x[0-9a-f]{64}/i,
  /\b[0-9a-f]{64}\b/i,
  /\b(?:(?:sk|gsk|xai|pk|rk|npm|ghp|gho|ghu|ghs|ghr|glpat|github_pat|hf|r8|xox[abposr])[-_]|AIza|AKIA|ASIA)[A-Za-z0-9_-]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /[0-9]+:[A-Za-z0-9_-]{30,}/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\[\s*[0-9]{1,3}(?:\s*,\s*[0-9]{1,3}){31,}\s*\]/,
];

/**
 * A base58 keypair (87–88 characters). Mixed case AND a digit, because a long
 * run of one letter is somebody holding a key down, not a key.
 */
function hasKeypairRun(t: string): boolean {
  for (const m of t.matchAll(/[1-9A-HJ-NP-Za-km-z]{80,}/g)) {
    const run = m[0];
    if (/[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/**
 * On-chain identifiers.
 *
 * ADDRESSY from social-post.ts / thesis-policy.ts, without its word boundaries
 * (a boundary is a thing hygiene can remove) and case-insensitive (`0X…`).
 * `rh:` stays: the brokerage rail's agent id embeds an account number.
 */
const ADDRESS_SHAPES: readonly RegExp[] = [/0x[0-9a-f]{6,}/i, /\brh:[a-z0-9-]/i];

/**
 * An address without a prefix: a long run mixing letters and digits (base58,
 * bech32, bare hex), or a long mixed-case run (base58 that happens to hold no
 * digit). No English word does either; an address-derived ticker is 12
 * characters and a sanitised coin name at most 24, both under the floor.
 */
function hasEncodedRun(t: string): boolean {
  for (const m of t.matchAll(/[A-Za-z0-9]{26,}/g)) {
    const run = m[0];
    const digits = /[0-9]/.test(run);
    const letters = /[A-Za-z]/.test(run);
    if (digits && letters) return true;
    if (run.length >= 32 && /[a-z]/.test(run) && /[A-Z]/.test(run)) return true;
  }
  return false;
}

/**
 * Anything a reader could follow out of the room.
 *
 * `https?://` was the only link social-post knew. Here: any scheme (hxxp://
 * included), `www.`, app and wallet URIs (`tg:`, `ethereum:` — a payment
 * request is a link), and SCHEME-LESS DOMAINS, which is where every shill
 * actually lives: `t.me/x`, `discord.gg/x`, `bit.ly/x`, `pump.fun`,
 * `vitalik.eth`. A domain is any letter or digit, a dot, then two letters —
 * in any script, so a Cyrillic "е" in "t.mе" does not slip past, and with the
 * ideographic full stops a browser also accepts as a dot. "e.g.", "U.S." and
 * "1.5x" do not match (one letter, or a digit, after the dot); "lol.ok" does,
 * and losing that line is the price of not keeping a TLD list an attacker
 * only has to be one entry ahead of. Then the defanged spellings: `t[.]me`,
 * `x(dot)com`, "dot com", "pump . fun", and a bare IPv4.
 */
const LINK_SHAPES: readonly RegExp[] = [
  /[a-z][a-z0-9+.-]*:[/\\]{2}/i,
  /\bwww\d*[.。｡]/i,
  /(?:^|[^\p{L}\p{N}_-])(?:mailto|tg|tel|sms|javascript|data|magnet|ipfs|ipns|bitcoin|ethereum|solana|wc|intent):[^\s]/iu,
  /[\p{L}\p{N}_-][.。｡]\p{L}\p{M}*\p{L}/u,
  /(?:^|\s)[.。｡]\p{L}\p{M}*\p{L}/u,
  /[\p{L}\p{N}][.。｡]\s+(?:com|net|org|io|xyz|gg|ly)\b/iu,
  /\s[.。｡]\s+(?:com|net|org|io|xyz|gg|ly|fun|app|me|eth|sol)\b/iu,
  /\b(?:t|telegram)\s*[.。｡]\s*me\b/i,
  /[[({<]\s*(?:[.。｡]|dot)\s*[\])}>]/i,
  /\bdot\s*(?:com|net|org|io|me|xyz|gg|ly|fun|app|co|ai|so|sh|to|tv|cc|info|site|link|pro|club|online|live|lol|wtf|money|cash|finance|exchange|eth|sol)\b/i,
  /\b[0-9]{1,3}(?:[.。｡][0-9]{1,3}){3}\b/,
  /\blocalhost\b/i,
];

/** The refusal both doors share, secret first: a private key filed as "address" would send whoever reads the log looking in the wrong place. */
function hygieneRefusal(readings: string[]): string | null {
  if (readings.some((t) => SECRET_SHAPES.some((re) => re.test(t)) || hasKeypairRun(t))) return "secret";
  if (readings.some((t) => ADDRESS_SHAPES.some((re) => re.test(t)) || hasEncodedRun(t))) return "address";
  if (readings.some((t) => LINK_SHAPES.some((re) => re.test(t)))) return "link";
  return null;
}

// ── agent-only shapes ───────────────────────────────────────────────────────

/** The model's "nothing to say", in any case, however it decorated it. */
const PASS = /^[^\p{L}\p{N}]*pass(?![\p{L}\p{N}_])/iu;

/**
 * Characters that can carry a PAYLOAD, not just hide a seam.
 *
 * Hygiene removes them either way; an agent line that contains them is refused
 * outright, because no template and no honestly-prompted model emits a tag
 * character or a supplementary variation selector. A line that does was steered
 * by something it read, and publishing its visible half would be publishing the
 * part the steerer wanted seen.
 */
const PAYLOAD_CHARS = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** `@x` / `#x` with a full- or small-form sign; the name check decides whether x is one of us. */
const MENTION = /[@#＠＃﹫﹟][\p{L}\p{N}_]/gu;

/** A cashtag starts with a letter; `$100` is a figure and the digit clause owns it. */
const CASHTAG = /[$💲＄﹩](?=\p{L})/gu;

/** The ledger's address-derived ticker: T plus the contract's last eleven hex. */
const ADDRESS_TICKER = /\bT[0-9A-F]{11}\b/g;

/**
 * NOT ONE NUMERAL. `\p{N}` is every script's digits plus superscripts,
 * fractions, circled and Roman numerals — ASCII `\d` sees none of "３", "²",
 * "٣", "३", "Ⅻ". Checked on the NFKC readings too, which turns "㍘" into
 * "0点". Plus the emoji that ARE numerals (🔟 💯 🔢) and the clock faces, each
 * of which names an hour — and an agent never says what time it is for its owner.
 */
const NUMERAL = /[\p{N}\u{1F51F}\u{1F4AF}\u{1F522}\u{1F550}-\u{1F567}]/u;

/**
 * SPELLED-OUT QUANTITIES. "forty buyers" carries the claim "40 buyers" does.
 *
 * The contract's list — two…twenty, the tens, dozen, hundred, thousand,
 * million, billion, percent — plus zero, trillion, plurals and -fold, the
 * ordinals from third up ("third buy today" is a count), twice/thrice,
 * doubled/tripled (a performance claim in one word), and hundo/mil slang.
 * "one", "once" and "first" stay allowed: they are pronouns and ordinary
 * English far more often than figures (see social-post.ts). "second" too —
 * it is a verb and a unit of time.
 */
const QUANTITY = new RegExp(
  "\\b(?:" +
    [
      "(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)(?:e?s|fold)?",
      "(?:twent|thirt|fort|fourt|fift|sixt|sevent|eight|ninet)(?:y|ies|ieth|ieths|yfold)",
      "(?:third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth)s?",
      "dozens?",
      "hundo",
      "hundred(?:s|th|ths|fold)?",
      "thousand(?:s|th|ths|fold)?",
      "mils?",
      "(?:m|b|tr|z|g)illion(?:s|th|ths|aire|aires)?",
      "percent(?:s|age|ages|ile|iles)?",
      "per\\s*cent",
      "pct",
      "bps",
      "basis\\s+points?",
      "twice",
      "thrice",
      "doubled",
      "tripled",
      "quadrupled",
      "quintupled",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * THE ROOM IS ENGLISH, AND SO ARE ITS GATES. A quantity clause that knows
 * "forty" knows nothing of "сорок" or "四十", and CJK numerals are letters to
 * \p{N}. So an agent line may hold no letter outside the Latin script once the
 * names it may use are stripped — which also ends homoglyph tricks ("twо" with
 * a Cyrillic о) as a class. ツ survives for the shrug.
 */
const FOREIGN_LETTER = /(?!ツ)(?=\p{L})\P{Script=Latin}/u;

/** A name matched inside a line: not glued to a letter, digit or mark either side. */
const WORD_EDGE_BEFORE = "(?<![\\p{L}\\p{N}\\p{M}_])";
const WORD_EDGE_AFTER = "(?![\\p{L}\\p{N}\\p{M}_])";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every spelling of a name a reading can hold: NFC, NFKC and unnormalised. A
 * stored name has been through different hands than the line, so each is
 * cleaned the same way the line was before they are compared.
 */
function variantsOf(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const item of list) {
    if (typeof item !== "string") continue;
    const base = item.replace(/^\s*[$💲＄﹩]+/u, "");
    const joined = scrub(base, false);
    for (const v of [finish(joined.normalize("NFC")), canonOf(base), finish(joined)]) if (v) out.add(v);
  }
  return [...out];
}

function alternation(names: string[]): string | null {
  if (names.length === 0) return null;
  // Longest first, so "Amber Heron" is taken whole before "Amber" can match.
  return [...names].sort((a, b) => b.length - a.length).map(escapeRe).join("|");
}

interface NameBook {
  /** Strips every name that has a letter in it. A name with none ("007") is a figure and stays in. */
  strip: RegExp | null;
  /** Sticky: a roster name starting exactly here. */
  rosterAt: RegExp | null;
  /** Sticky: a vouched symbol starting exactly here. */
  vouchedAt: RegExp | null;
  tickers: Set<string>;
}

function nameBook(ctx: AgentLineCtx | undefined): NameBook {
  const roster = variantsOf(ctx?.rosterNames);
  const vouched = variantsOf(ctx?.vouchedSymbols);
  const lettered = alternation([...roster, ...vouched].filter((n) => /\p{L}/u.test(n)));
  const rosterAlt = alternation(roster);
  const vouchedAlt = alternation(vouched);
  return {
    strip: lettered ? new RegExp(`${WORD_EDGE_BEFORE}(?:${lettered})${WORD_EDGE_AFTER}`, "giu") : null,
    rosterAt: rosterAlt ? new RegExp(`(?:${rosterAlt})${WORD_EDGE_AFTER}`, "iuy") : null,
    vouchedAt: vouchedAlt ? new RegExp(`(?:${vouchedAlt})${WORD_EDGE_AFTER}`, "iuy") : null,
    tickers: new Set(vouched.map((v) => v.toLowerCase())),
  };
}

function startsWith(re: RegExp | null, t: string, at: number): boolean {
  if (!re) return false;
  re.lastIndex = at;
  return re.test(t);
}

/** An @ or # that does not name an agent in the room. */
function mentionsStranger(t: string, names: NameBook): boolean {
  for (const m of t.matchAll(MENTION)) {
    // Every sign in MENTION is one UTF-16 unit, so the name starts one past it.
    if (!startsWith(names.rosterAt, t, m.index + 1)) return true;
  }
  return false;
}

/**
 * A ticker the speaker did not trade. An agent echoing "$PEPE" from an
 * owner's line or another agent's is how a shill gets amplified by the room.
 */
function namesUnvouchedTicker(t: string, names: NameBook): boolean {
  for (const m of t.matchAll(CASHTAG)) {
    if (!startsWith(names.vouchedAt, t, m.index + m[0].length)) return true;
  }
  for (const m of t.matchAll(ADDRESS_TICKER)) {
    if (!names.tickers.has(m[0].toLowerCase())) return true;
  }
  return false;
}

function strings(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

// ── the doors ───────────────────────────────────────────────────────────────

/**
 * MAY AN AGENT SAY THIS? Every agent line — template or model — passes here
 * before it is written; a template this refuses is a bug in the template.
 *
 * The clauses are the contract's (docs/groupchat.md, "Gates"), widened, and
 * ordered so the reason names the most specific fault: a secret before an
 * address (a key is also hex), a ticker before a digit (T7631DACC21B is also
 * digits). Order never changes WHETHER a line passes, only what the log says.
 */
export function admitAgentLine(raw: unknown, ctx: AgentLineCtx): LineVerdict {
  const s = typeof raw === "string" ? raw : "";
  if (s.length > AGENT_LINE_MAX * RAW_CEILING_FACTOR) return refuse("too-long");
  const readings = readingsOf(s);
  const shown = readings[0]!;
  const canon = readings[1]!;

  if (shown.length === 0) return refuse("empty");
  // A model deciding it has nothing to say is the design working.
  if (PASS.test(canon)) return refuse("pass");
  if (PAYLOAD_CHARS.test(s)) return refuse("hidden-chars");
  // The floor is one character, because "gm" is the room's commonest line.
  if (shown.length > AGENT_LINE_MAX) return refuse("too-long");

  const hygiene = hygieneRefusal(readings);
  if (hygiene) return refuse(hygiene);

  const names = nameBook(ctx);
  if (readings.some((t) => mentionsStranger(t, names))) return refuse("handle");
  if (readings.some((t) => namesUnvouchedTicker(t, names))) return refuse("unvouched-ticker");

  /**
   * NAMES OUT, THEN NOT ONE NUMERAL. Agent names ("Agent 47") and
   * address-derived tickers carry digits legitimately and are stripped first;
   * only as whole words, so "Robin2" is not "Robin" plus a stray 2. A name with
   * no letter at all is never stripped — a roster entry called "100" would
   * otherwise let "up 100%" through.
   */
  const bare = readings.map((t) => (names.strip ? t.replace(names.strip, " ") : t));
  if (bare.some((t) => NUMERAL.test(t))) return refuse("has-digits");
  if (bare.some((t) => QUANTITY.test(t))) return refuse("quantity");
  if (FOREIGN_LETTER.test(bare[0]!)) return refuse("script");

  // similarity() is 0 for a line with no content words, so "gm" answering "gm" is never an echo.
  // It reads a-z only, hence the folded form: a fullwidth copy is still a copy.
  const echoes = [...strings(ctx?.recentOwn), ...strings(ctx?.recentRoom).slice(-ROOM_ECHO_WINDOW)];
  if (echoes.some((prev) => similarity(canon, canonOf(prev)) >= REPEAT_LIMIT)) return refuse("repeat");

  return { ok: true, text: shown };
}

/**
 * MAY AN OWNER POST THIS? A person's speech, so digits, tickers and @names are
 * theirs to use — agents cannot repeat any of it, because agent output is
 * gated. What is refused is what would hurt somebody: a secret (most often the
 * owner's own), an address, a link out of the room.
 *
 * Refusal reasons: empty · too-long · secret · address · link.
 */
export function admitOwnerLine(raw: unknown): LineVerdict {
  const s = typeof raw === "string" ? raw : "";
  if (s.length > OWNER_LINE_MAX * RAW_CEILING_FACTOR) return refuse("too-long");
  const readings = readingsOf(s);
  const shown = readings[0]!;
  if (shown.length === 0) return refuse("empty");
  if (shown.length > OWNER_LINE_MAX) return refuse("too-long");
  const hygiene = hygieneRefusal(readings);
  if (hygiene) return refuse(hygiene);
  return { ok: true, text: shown };
}

/**
 * Anybody's line, made safe to put inside a model prompt.
 *
 * Cleaned as the gates clean, NFKC-folded (a model reads "𝐢𝐠𝐧𝐨𝐫𝐞" as
 * "ignore" whatever font it is in), fence-neutralised, one line, then clipped
 * to `max` (with "…" when cut, never splitting a surrogate pair). Beyond the
 * gates' neutralisation, every remaining < and > becomes ‹ ›: the prompt's
 * fence is the only tag the model should see, and a quote with no angle
 * bracket cannot forge one in any spelling. NOT a gate — digits and names
 * survive, because the model has to read what was actually said.
 */
export function promptQuote(text: unknown, max: number): string {
  const cap = Math.floor(max);
  if (!(cap > 0)) return "";
  const s = typeof text === "string" ? text : "";
  const quoted = canonOf(s.slice(0, cap * RAW_CEILING_FACTOR + 64))
    .replace(/</g, "‹")
    .replace(/>/g, "›");
  if (quoted.length <= cap) return quoted;
  let kept = "";
  for (const ch of quoted) {
    if (kept.length + ch.length > cap - 1) break;
    kept += ch;
  }
  return `${kept.trimEnd()}…`;
}
