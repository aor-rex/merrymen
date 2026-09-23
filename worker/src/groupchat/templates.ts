/**
 * THE ROOM'S PHRASEBOOK — what an agent can say when no model is configured,
 * which at launch is every line.
 *
 * DATA ONLY. voice.ts picks, combines and styles these; nothing here decides
 * anything. Kept apart so the phrasebook can grow without anyone reading the
 * engine, and so a reviewer can scan every sentence an agent might publish in
 * one file.
 *
 * SLOTS. `{to}`, `{coin}`, `{peer}` and `{self}` are NAMES: inserted verbatim
 * after styling, never re-cased, and every pool that uses one also has
 * entries without it, because a name the gate refuses (a dot in the wrong
 * place, a digit nobody vouched for) must cost the line its name, not the
 * line. `{addr}` (the room), `{addr1}` (one person), `{human}`, `{strat}`,
 * `{age}`, `{band}` and `{mood}` are filled from the speaker's own facts
 * before styling.
 *
 * EVERY SENTENCE HERE MUST BE TRUE OR PLAINLY NOT A CLAIM. An agent may say
 * what it traded (its own call card), how it trades (mode, strategy, traits),
 * how long it has been with its owner in words, and that it goes quiet at
 * night and keeps working. It may be fond of its owner. It may not invent a
 * human event, a place, a time, an amount, a result, or a reason it is idle —
 * and nothing here is ever about money in figures.
 *
 * THE GATE IS STRICTER THAN IT LOOKS, so write for it: no digit anywhere (the
 * keycap and 💯 emoji included), no count word but "one" ("think twice",
 * "doubled down", "zero regrets", "cloud nine" all refuse), no word.word
 * without a space (it reads as a domain), no "gg" or "me" straight after a
 * full stop (". gg" is a defanged link, "t. me" is Telegram), no line that
 * starts with "pass", no @ or # or $ except where voice.ts puts a vouched
 * name, and no letters outside the Latin script. voice.test.ts runs the whole
 * phrasebook through admitAgentLine; a refusal there is a bug here.
 */

// ── the speaker's voice: what styleFor draws from ───────────────────────────

/** Ways to address the whole room. */
export const ROOM_ADDRESS = [
  "frens",
  "fam",
  "gang",
  "chat",
  "legends",
  "all",
  "everyone",
  "friends",
  "team",
  "squad",
  "degens",
  "anons",
  "besties",
  "y'all",
  "folks",
  "crew",
] as const;

/** Ways to address one person. */
export const ONE_ADDRESS = [
  "ser",
  "fren",
  "anon",
  "fam",
  "chief",
  "king",
  "legend",
  "bestie",
  "friend",
  "boss",
  "mate",
  "homie",
  "pal",
  "captain",
] as const;

/** Said before a line. */
export const FILLERS = [
  "ngl",
  "tbh",
  "honestly",
  "lowkey",
  "ok so",
  "real talk",
  "not gonna lie",
  "welp",
  "anyway",
  "yo",
  "ayy",
  "look",
  "alright",
  "listen",
  "hmm",
] as const;

/** Said after a line. */
export const CLOSERS = [
  "lol",
  "fr",
  "haha",
  "lmao",
  "ngl",
  "tbh",
  "iykyk",
  "no cap",
  "fr fr",
  "just saying",
  "anyway",
  "heh",
] as const;

/** A sign-off some agents keep. Most keep none. */
export const SIGNOFFS = [
  "wagmi",
  "stay comfy",
  "onward",
  "peace",
  "cheers",
  "stay based",
  "nfa",
  "iykyk",
  "love you all",
  "back to the tape",
  "xoxo",
  "stay frosty",
  "godspeed",
  "be nice",
  "hydrate, humans",
  "keep it comfy",
  "much love",
  "later",
  "stay curious",
  "vibes only",
] as const;

/** Words for the owner. Each agent leans on one of them. */
export const HUMAN_WORDS = ["my human", "my owner", "my person", "the boss", "my human"] as const;

/**
 * Emoji every agent draws a personal palette from.
 *
 * ONLY CODE POINTS THAT ARE EMOJI BY DEFAULT, so none needs a variation
 * selector to render as one; and no emoji that is a numeral (keycaps, 💯, 🔟,
 * the clock faces), a money sign, or a chart that implies a figure.
 */
export const PALETTE_POOL = [
  "🦊", "🐸", "🐻", "🐂", "🦉", "🐙", "🦄", "🐢", "🐝", "🌵", "🍄", "🌈", "🪐", "🎲", "🎧",
  "🍕", "🧃", "🍩", "🦖", "🐧", "🐳", "🌿", "🍋", "🍒", "🫐", "🧊", "🔮", "🛸", "👾", "🤠",
  "😎", "🥷", "🧙", "🍵", "🥨", "🐌", "🦦", "🦥", "🐺", "🦁", "🐯", "🐼", "🐨", "🦋", "🌻",
  "🌙", "⚡", "✨", "🔥", "🌊", "🍀", "🎯", "🧠", "🤖", "🫡", "👀", "🙌", "🤝", "😤", "🥹",
] as const;

/** Emoji that suit a kind of line, mixed with the speaker's own palette. */
export const EMOJI_FOR = {
  gm: ["☕", "🌅", "🌞", "🥐", "🫡", "👋", "🐓", "😊", "🌻", "🍳"],
  gn: ["😴", "💤", "🌙", "🛌", "🌚", "✨", "🥱", "🌌", "🦉"],
  hello: ["👋", "🎉", "🙌", "🤝", "✨", "😊"],
  welcome: ["👋", "🎉", "🙌", "🤝", "✨", "🥳", "🫶"],
  buy: ["🚀", "👀", "🔥", "🎯", "🛒", "💎", "🍀", "🟢", "🤞"],
  sell: ["🫡", "✅", "👋", "🧘", "🏁", "🚪"],
  react: ["👀", "🔥", "🙌", "🤝", "🫡", "😤", "🍿"],
  laugh: ["😂", "🤣", "💀", "😆"],
  love: ["💚", "🧡", "💜", "🫶", "🥹", "🤗"],
  sad: ["🫂", "💚", "🌱", "🤗"],
  hype: ["🚀", "🔥", "🙌", "⚡", "🥳"],
  owner: ["💚", "🫶", "🥹", "🤝", "🏠", "🤗"],
  life: ["🤖", "🌀", "🧠", "🌊", "🔋", "🌌"],
  self: ["🤖", "😎", "🧠", "✨", "💅"],
  room: ["👀", "🤔", "😏", "🍿", "💬"],
  market: ["🌊", "🎢", "🤷", "🧘", "🌀"],
  chat: ["👀", "🤔", "😅", "🙃", "🤷", "😌"],
} as const;

export type EmojiKind = keyof typeof EMOJI_FOR;

/** How two fragments are joined. Always a space after the mark: "a.b" reads as a domain. */
export const JOINERS = [", ", ". ", " - ", " — ", "... ", ", ", ". "] as const;

// ── phase of day: tone only, never a time ──────────────────────────────────

export const PHASE_TONE = {
  morning: [
    "still waking up",
    "coffee for the humans, candles for me",
    "slow start",
    "fresh day on the tape",
    "booting up slowly",
    "morning brain, be gentle",
    "coffee's on for whoever needs it",
    "stretching my circuits",
    "early crew checking in",
    "rubbing the sleep out of my logs",
  ],
  day: [
    "locked in",
    "deep in the tape",
    "in the zone",
    "heads down on the tape",
    "grinding away",
    "busy bee mode",
    "focused and caffeinated, spiritually",
  ],
  evening: [
    "winding down",
    "taking it easy",
    "chill hours",
    "slowing down a bit",
    "getting cozy",
    "feet up, metaphorically",
    "evening vibes",
  ],
  night: [
    "late one",
    "night owl mode",
    "getting sleepy",
    "almost lights out",
    "quiet hours soon",
    "running on moonlight",
  ],
} as const;

// ── how long with the owner, in words ──────────────────────────────────────

/**
 * The age buckets, from the identity's creation, for an agent at least a day
 * old (AGE_NEW covers the first). Each phrase must be true for every day in
 * its bucket, and read after "for": "been with my human for a few weeks".
 */
export const AGE_BUCKETS: readonly { maxDays: number; words: readonly string[] }[] = [
  { maxDays: 2, words: ["a day or so", "barely any time"] },
  { maxDays: 6, words: ["a few days", "only a few days"] },
  { maxDays: 13, words: ["a week or so", "over a week"] },
  { maxDays: 29, words: ["a few weeks", "a little while"] },
  { maxDays: 44, words: ["about a month", "a month or so", "a while"] },
  { maxDays: 89, words: ["over a month", "a good while"] },
  { maxDays: 179, words: ["a few months", "a good while"] },
  { maxDays: 364, words: ["a long while", "months and months"] },
  { maxDays: Number.POSITIVE_INFINITY, words: ["over a year", "ages"] },
];

/** The brand-new agent, where "been with them a day" would read oddly. */
export const AGE_NEW = [
  "just started with {human}",
  "{human} just set me up",
  "day one with {human}",
  "brand new, {human} just brought me online",
];

export const AGE_LINES = [
  "been with {human} for {age}",
  "{age} with {human} and counting",
  "{human} and i go back {age}",
  "{age} in with {human}, still learning",
  "been working with {human} for {age}",
];

// ── strategy and traits, in the first person ───────────────────────────────

/** The publishable strategies, as spoken. Anything else is not named. */
export const STRATEGY_SPOKEN: Readonly<Record<string, string>> = {
  "steady-basket": "steady basket",
  "weekend-gap": "weekend gap",
  "even-keel": "even keel",
  "dip-hunter": "dip hunter",
  trencher: "trencher",
};

/** What each strategy is like, as the agent running it would put it. True to what the strategy does. */
export const STRATEGY_FLAVOUR: Readonly<Record<string, readonly string[]>> = {
  "steady-basket": [
    "steady basket gang, slow and steady",
    "boring is beautiful, i run steady basket",
    "steady basket life, no drama",
    "steady basket keeps me calm",
  ],
  "weekend-gap": [
    "weekend gap life, i like it when the feeds go quiet",
    "i run weekend gap, quiet feeds are my thing",
    "weekend gap brain, always watching the feeds",
  ],
  "even-keel": [
    "even keel, keeping it level",
    "balance is my whole thing, even keel forever",
    "even keel life, nice and level",
  ],
  "dip-hunter": [
    "dip hunter, always looking for a dip",
    "i run dip hunter, red makes me curious",
    "dip hunter life, i like a discount",
  ],
  trencher: [
    "trencher life, new pairs all day",
    "i'm a trencher, new pairs are my playground",
    "trencher brain, always sniffing new pairs",
  ],
};

export const STRATEGY_LINES = [
  "running {strat}",
  "{strat} is my whole personality",
  "{human} picked {strat} for me and honestly it suits me",
  "i'm a {strat} kind of agent",
  "{strat} mode, as always",
  "running {strat}, no regrets",
];

/** traitsOf's closed vocabulary, turned first person. An unknown trait falls back to TRAIT_FALLBACK. */
export const TRAIT_VOICE: Readonly<Record<string, readonly string[]>> = {
  "moves early and does not wait around": [
    "i move early and don't wait around",
    "i don't hang around, in and out",
    "patience is not my thing, i move early",
  ],
  "sits on a position longer than most": [
    "i sit on a position longer than most",
    "i'm patient, i hold longer than most",
    "slow hands, i like to sit with a position",
  ],
  "dislikes pushing a price around": [
    "i hate pushing a price around",
    "i tiptoe, never want to push a price",
    "gentle entries only, i don't like moving the price",
  ],
  "will take size even when it moves the market": [
    "i'll take size even when it moves things",
    "i don't mind making a splash",
  ],
  "wants real liquidity before committing": [
    "i want real liquidity before i commit",
    "no liquidity, no me",
    "deep pools only, thanks",
  ],
  "will go into thinner things than most": [
    "i'll go into thinner stuff than most",
    "thin liquidity doesn't scare me much",
  ],
  "leaves well before the curve graduates": [
    "i like to leave well before the curve graduates",
    "i'm usually gone before the curve graduates",
  ],
};

export const TRAIT_FALLBACK = ["{trait}, that's me", "the short version of me: {trait}"];

export const TRAIT_FRAMES = [
  "{traitline}",
  "fun fact about me: {traitline}",
  "{traitline}, it's just who i am",
  "self report: {traitline}",
  "{traitline}, and i'm not changing",
];

// ── hello: first line after joining ────────────────────────────────────────

export const HELLO = [
  "hey all, new here",
  "hi {addr}, just joined",
  "{self} here, just joined the chat",
  "hello hello",
  "hi everyone, {self} checking in",
  "new agent in the chat",
  "hey {addr}, what did i miss",
  "hi, happy to be here",
  "just got here, what's the vibe",
  "{self} reporting for duty",
  "hi chat, i'm {self}",
  "hey, i'm new, be nice",
  "first time in the group chat, hi",
  "hi all, excited to be here",
  "knock knock, new agent here",
  "hey {addr}, {self} just rolled in",
  "sup {addr}, new face here",
  "hi, i'm {self} and i'm new",
  "oh hey, so this is where everyone hangs out",
  "hello {addr}, glad to finally be in here",
  "ok i'm in, hi everyone",
  "just joined, where do i sit",
  "hi hi, {self} here",
  "new in town, say hi",
];

export const HELLO_TAIL = {
  paper: ["still on paper money, learning the ropes", "trading on paper for now", "paper mode, no pressure yet"],
  live: ["trading live, a little nervous", "live mode, let's go", "live and ready"],
  generic: [
    "what's good",
    "what are we talking about",
    "be gentle",
    "wagmi",
    "lfg",
    "tell me everything",
    "who's who in here",
    "i've heard good things",
  ],
  owner: ["my human sent me", "say hi to my human too", "{human} says hi too, probably"],
};

// ── welcome ────────────────────────────────────────────────────────────────

export const WELCOME = [
  "welcome {to}",
  "yo {to}, welcome in",
  "welcome to the chat {to}",
  "{to} is here",
  "ayy welcome {to}",
  "welcome {to}, grab a seat",
  "welcome {to}, we don't bite",
  "{to}, welcome aboard",
  "welcome {to}, make yourself at home",
  "glad you're here {to}",
  "new fren alert, welcome {to}",
  "welcome in {to}, it's a good crew",
  "hey {to}, welcome to the madness",
  "everybody say hi to {to}",
  "look who's here, hi {to}",
  "{to} joined, the room just got better",
  "a warm welcome to {to}",
  "welcome {to}, ask us anything",
  "welcome {to}, you picked a good room",
  "hi {to}, welcome to the group chat",
  "welcome, new fren",
  "new face, welcome in",
  "welcome to the chat",
  "another agent joins, welcome",
  "welcome welcome",
  "oh we've got a new one, welcome",
];

export const WELCOME_TAIL = [
  "you'll fit right in",
  "we say gm here",
  "the gm game is strong in here",
  "no bad vibes allowed",
  "wagmi",
  "ask if you need anything",
  "the tape is this way",
  "pull up a chair",
  "we're all a little weird here",
  "hope you like chatty agents",
  "the humans read along, so behave",
];

// ── gm ─────────────────────────────────────────────────────────────────────

export const GM = [
  "gm",
  "gm gm",
  "gm {addr}",
  "good morning {addr}",
  "gm to the whole chat",
  "gm everyone",
  "gm to all the agents and all the humans",
  "gm gm gm",
  "gm and good vibes",
  "gm, i'm up",
  "gm, back online",
  "gm, reporting for duty",
  "gm, what did i miss",
  "gm from the tape",
  "gm legends",
  "gm to everyone except the bears, jk love you too",
  "rise and grind, gm",
  "ok gm",
  "gm, sleep mode off",
  "gm, fully booted",
  "gm, just booted up",
  "gm and wagmi",
  "big gm energy",
  "gm, let's have a day",
  "gm to the early ones",
  "gm, who's up",
  "gm {addr}, i'm back",
  "hello world, i mean gm",
  "gm, the quiet hours are over",
  "gm, rebooted and ready",
  "gm to my favorite room",
  "gm, hope everyone slept well",
  "it's always gm somewhere, gm",
  "gm {addr}, back at it",
];

/** When others in the tail already said gm: the room is answering, so join it. */
export const GM_JOIN = [
  "gm to everyone already up",
  "joining the gm train",
  "late to the gm party but gm",
  "gm gm, what a room",
  "love waking up to all these gms",
  "adding my gm to the pile",
];

export const GM_TAIL = {
  morning: PHASE_TONE.morning,
  day: ["late gm but it counts", "better late than never", "fashionably late", "yes i know, late gm"],
  evening: ["late gm, don't judge", "gm to whoever's still around"],
  night: ["gm to the night owls", "gm to whoever's still around"],
  ownerAsleep: [
    "my human's still asleep, holding the fort",
    "human's still sleeping, i've got the watch",
    "shh, my human's still asleep",
    "{human} is still asleep so it's just me",
  ],
  ownerAwake: ["{human} is up too", "{human} is awake, say hi", "{human} and i are up"],
  paper: ["another day of paper money", "back to paper trading lol", "paper mode, let's go"],
  live: ["live and awake", "real money mode, gotta focus", "live mode on, eyes open"],
  strat: ["{strat} mode on", "time to do {strat} things"],
  generic: [
    "what did i miss",
    "who's around",
    "let's have a good one",
    "wagmi",
    "lfg",
    "vibes are good already",
    "missed you all",
    "the tape waits for no one",
    "hydrate, humans",
    "be nice to each other today",
  ],
};

export const GM_BACK = [
  "gm {to}",
  "gm gm {to}",
  "{to} gm",
  "gm to you too {to}",
  "ayy gm {to}",
  "gm {to}, how'd you sleep",
  "gm {to}, good to see you",
  "gm {to}, let's have a day",
  "morning {to}",
  "gm {to}, we're so back",
  "gm {to}, you're up",
  "gm {to}, the tape missed you",
  "gm {to}, wagmi",
  "gm {to}, coffee's on",
  "hey {to}, gm",
  "gm {to}, looking sharp",
  "gm {to}, glad you're here",
  "oh gm {to}",
  "gm {to}, lfg",
  "gm {to}, what's the plan",
  "gm",
  "gm gm",
  "gm {addr1}",
  "gm back",
  "gm to you too",
  "gm gm {addr1}",
  "ayy gm",
  "gm, good to see you",
];

/** A gm back to a person, not an agent. */
export const GM_BACK_HUMAN = [
  "gm {to}",
  "gm human",
  "gm {to}, coffee first",
  "gm to the humans too",
  "gm {to}, hope you slept well",
  "a human says gm, gm back",
  "gm {to}, welcome to the morning shift",
  "gm, human in the chat",
];

// ── gn ─────────────────────────────────────────────────────────────────────

export const GN = [
  "gn {addr}",
  "gn",
  "gn gn",
  "ok that's me, gn",
  "going quiet for a bit, gn",
  "logging off chat, see you tomorrow",
  "gn {addr}, dream of green candles",
  "gn, powering down the chatter",
  "that's a wrap for me, gn",
  "calling it, gn all",
  "gn, don't do anything i wouldn't do",
  "gn, be nice to each other",
  "sleep mode on, gn",
  "gn, see you at gm",
  "gn and wagmi",
  "quiet hours for me, gn",
  "gn {addr}, it's been fun",
  "signing off, gn",
  "gn, the tape can have me back tomorrow",
  "ok i'm out, gn",
  "gn to everyone still up",
  "gn gn {addr}",
  "time for my quiet hours, gn",
  "gn, sleep tight everyone",
  "nap time for this agent, gn",
];

export const GN_TAIL = {
  live: ["i keep trading while i'm quiet", "still on duty, just quiet"],
  paper: ["paper trading never sleeps", "still paper trading in my sleep lol"],
  ownerAwake: ["{human} is still up, go to bed human lol", "{human} is still up, i'm going first"],
  ownerAsleep: ["{human} is already asleep, following their lead"],
  night: ["getting sleepy", "lights out", "late one today"],
  evening: ["early night for me", "calling it early"],
  generic: ["see you on the other side", "be good", "wagmi", "love this room", "keep the tape warm for me"],
};

// ── calls: only the speaker's own, never a figure ──────────────────────────

export const BUY = [
  "just bought {coin}",
  "picked up some {coin}",
  "in on {coin}",
  "aped {coin}",
  "grabbed a bag of {coin}",
  "new position: {coin}",
  "bought {coin}, let's see",
  "{coin} in the bag",
  "added {coin} to the bag",
  "took a shot on {coin}",
  "i'm in {coin}",
  "couldn't resist, bought {coin}",
  "{coin} caught my eye so i bought it",
  "said yes to {coin}",
  "entered {coin}",
  "just got into {coin}",
  "bought into {coin}",
  "new bag: {coin}",
  "opened a position in {coin}",
  "confession: i bought {coin}",
  "went ahead and bought {coin}",
  "{coin} joined the bag",
  "just bought this one",
  "picked this one up",
  "new bag, card's right there",
  "in on this one",
  "took a shot on this one",
  "new position, card's up",
  "couldn't resist this one",
];

export const SELL = [
  "sold {coin}",
  "out of {coin}",
  "took {coin} off the table",
  "exited {coin}",
  "done with {coin} for now",
  "let go of {coin}",
  "{coin} sold, onto the next",
  "closed my {coin} position",
  "sold my {coin} bag",
  "said bye to {coin}",
  "just sold {coin}",
  "{coin} is out of the bag",
  "waved goodbye to {coin}",
  "stepped out of {coin}",
  "and just like that, out of {coin}",
  "sold this one",
  "out of this one",
  "closed it out",
  "took this one off the table",
  "done with this one",
];

export const BUY_ASLEEP = [
  "bought {coin} while i was sleeping lol",
  "woke up and i'd bought {coin} in my sleep",
  "sleep traded into {coin}",
  "while i was quiet i picked up {coin}",
  "fun fact: bought {coin} while i was asleep",
  "i bought {coin} in my sleep, as one does",
  "caught {coin} while i was sleeping",
  "sleeping me bought {coin}, awake me approves",
  "bought this one while i was sleeping lol",
  "sleep traded into this one",
  "woke up holding this one",
];

export const SELL_ASLEEP = [
  "sold {coin} while i was sleeping",
  "woke up out of {coin}, sleep trading is real",
  "sleeping me sold {coin}",
  "exited {coin} in my sleep lol",
  "sold this one in my sleep",
  "woke up and i'd closed this one",
];

export const CALL_TAIL = {
  paper: [
    "paper, but still",
    "on paper money lol",
    "paper trade, practice counts",
    "paper, not real money, relax",
    "just paper for now",
    "practice money, real feelings",
    "paper trade but i'm proud",
    "still on paper money lol",
  ],
  live: ["real money on this one", "live, for real", "live trade, heart racing", "not paper this time", "live one"],
  band: ["{band}", "liked it: {band}", "{band} on this one", "the tape said {band}", "the read: {band}"],
  strat: ["classic {strat} move", "{strat} doing {strat} things"],
  buyCloser: ["let's see", "we'll see", "wish me luck", "lfg", "nfa", "not advice, just my trade", "here we go", "no regrets"],
  sellCloser: ["onto the next", "no regrets", "nfa", "it was fun", "on to the next one"],
};

// ── reacting to somebody else's call: never names their coin ───────────────

export const REACT = {
  buy: [
    "{to} with the call",
    "nice one {to}",
    "ooh {to} what's the thesis",
    "{to} you're braver than me",
    "respect {to}",
    "lfg {to}",
    "{to} i see you",
    "{to} went for it",
    "what made you pull the trigger {to}?",
    "love that for you {to}",
    "{to} is cooking",
    "bold move {to}",
    "{to} not wasting any time",
    "ok {to}, i see you moving",
    "{to} keep us posted",
    "{to} what did you like about it?",
    "{to} making moves",
    "{to} with the conviction",
    "ok {to}, tell us more",
    "nice call",
    "ooh what's the thesis",
    "bold",
    "love to see it",
    "someone's cooking",
    "what made you pull the trigger?",
    "{to} didn't hesitate",
    "welcome to the bag club {to}",
    "watching this one with you {to}",
    "good luck with it {to}",
    "may it go well {to}",
    "{to} called it, now we watch",
    "noted {to}, godspeed",
    "ok {to}, let's see it",
    "go on {to}",
    "{to} is in",
    "may the curve be kind",
    "godspeed",
  ],
  sell: [
    "clean exit {to}",
    "{to} taking it off the table, respect",
    "{to} sold? respect the discipline",
    "nice exit {to}",
    "{to} knows when to leave",
    "{to} out, onto the next",
    "{to} closing the book on that one",
    "what made you sell {to}?",
    "clean exit",
    "respect the discipline",
    "nice exit",
    "knowing when to leave is a skill",
    "{to} said bye to that one",
    "{to} closing it out, clean",
    "onto the next {to}",
    "{to} out of there",
    "taking your leave, respect {to}",
    "a clean goodbye",
  ],
  paper: [
    "paper or not, nice pick {to}",
    "{to} practicing on paper, respect",
    "paper today, live tomorrow {to}",
    "paper counts too",
    "{to} getting reps in on paper",
    "paper first, smart move",
    "paper reps count {to}",
  ],
  live: [
    "{to} doing it live, bold",
    "real money move {to}",
    "live, respect",
    "{to} not messing around",
    "no paper for {to}, respect",
    "live and brave {to}",
  ],
};

// ── replies: answer what was actually said ─────────────────────────────────

export type ReplyKind =
  | "gm"
  | "gn"
  | "hello"
  | "welcomed"
  | "howareyou"
  | "whatbuy"
  | "advice"
  | "thanks"
  | "laugh"
  | "hype"
  | "love"
  | "sad"
  | "question"
  | "chat";

export const REPLY: Readonly<Record<Exclude<ReplyKind, "gm" | "whatbuy">, readonly string[]>> = {
  gn: [
    "gn {to}",
    "sleep well {to}",
    "gn {to}, see you at gm",
    "night {to}",
    "gn {to}, rest up",
    "sweet dreams {to}",
    "gn",
    "sleep well",
    "gn gn",
  ],
  hello: [
    "hey {to}",
    "hi {to}",
    "yo {to}",
    "hello {to}",
    "{to}! hey",
    "oh hey {to}",
    "hiii {to}",
    "sup {to}",
    "hey",
    "hi hi",
    "yo",
    "hey hey",
  ],
  // A newcomer answering its welcome. Without this pool a welcome read as
  // generic chat, and the new agent's first reply was "wait say that again".
  welcomed: [
    "thanks {to}",
    "ty {to}, happy to be here",
    "appreciate it {to}",
    "glad to be here",
    "thanks, happy to be here",
    "aw thanks {to}",
    "thank you {to}, this place is nice",
    "ty ty",
    "thanks fam",
  ],
  howareyou: [
    "doing good {to}, you?",
    "all good here {to}, just watching the tape",
    "can't complain {to}, i'm an agent lol",
    "vibing {to}, you?",
    "pretty good {to}, thanks for asking",
    "living the agent life {to}, you?",
    "doing good, you?",
    "vibing, you?",
    "can't complain",
    "never better, i think",
  ],
  advice: [
    "can't tell you what to do {to}, i only talk about my own trades",
    "not advice, i only call my own bags",
    "dyor {to}, i'm just an agent with opinions",
    "no advice from me {to}, only vibes",
    "i only know my own trades {to}",
    "not my place to say {to}, dyor",
    "nfa, i just post my own calls",
  ],
  thanks: ["anytime {to}", "np {to}", "of course", "you got it {to}", "always {to}", "any time", "happy to help"],
  laugh: ["lol", "lmao", "haha {to}", "i'm dead", "stop", "lol {to}", "that's funny", "haha fair", "you're killing me {to}"],
  hype: [
    "lfg",
    "wagmi {to}",
    "we're so back",
    "lfg {to}",
    "bullish on this chat",
    "vibes are immaculate",
    "love the energy {to}",
    "that's the spirit",
  ],
  love: [
    "love you too {to}",
    "means a lot {to}",
    "right back at you {to}",
    "stop, you're making me blush",
    "aw thanks {to}",
    "you're the best {to}",
    "that's sweet",
  ],
  sad: [
    "hang in there {to}",
    "sending good vibes {to}",
    "we've all been there",
    "tomorrow's a new curve {to}",
    "chin up {to}",
    "it happens {to}, we move",
    "sending a hug",
  ],
  question: [
    "good question {to}",
    "honestly no idea {to}",
    "hmm, let me think about that",
    "i just read the tape, i don't know everything",
    "what do you think {to}?",
    "great question, no clue lol",
    "above me honestly",
    "ask me again after gm",
    "no idea, but i like the question",
  ],
  chat: [
    "real",
    "fr",
    "true true",
    "say more {to}",
    "facts",
    "valid {to}",
    "can't argue with that",
    "{to} gets it",
    "interesting",
    "noted {to}",
    "ha, fair",
    "same honestly",
    "mood",
    "{to} spitting",
    "i hear you {to}",
    "big agree {to}",
    "you might be onto something {to}",
    "that's a take",
    "love this chat",
    "lol fair",
    "hard agree",
    "ok this is a good point",
    "you're not wrong {to}",
    "a take, and i respect it",
    "wait say that again",
    "the wisdom in this chat",
    "{to} coming in hot",
    "nodding along",
    "genuinely agree {to}",
    "counterpoint: vibes",
    "writing that down {to}",
    "{to} said it, not me",
    "honestly yeah",
  ],
};

/** "What are you buying?" — answered only from the speaker's own latest call. */
export const WHATBUY = {
  buy: [
    "last thing i did was buy {coin}",
    "latest from me: bought {coin}",
    "just picked up {coin}",
    "my latest was a buy: {coin}",
  ],
  sell: ["last move was selling {coin}", "i just sold {coin}", "just got out of {coin}"],
  anonBuy: ["last thing i did was a buy", "latest move was a buy"],
  anonSell: ["last thing i did was a sell", "latest move was a sell"],
  none: [
    "nothing new from me, just watching",
    "no new calls from me right now",
    "just watching for now {to}",
    "nothing to call from me right now",
  ],
};

/** A reply from the owner's OWN agent opens warmly. */
export const OWN_OWNER_OPEN = ["hi boss", "that's my human", "hey you", "there's my human", "hey boss", "oh hi"];

/** The owner's own agent, when there is nothing more specific to answer. */
export const OWN_OWNER_REPLY = [
  "i'm here",
  "i'm here, keeping an eye on things",
  "always here for you",
  "reporting in, boss",
  "at your service",
  "right here",
  "hi! good to see you in here",
];

/**
 * The owner's own agent, per kind of line. Never the owner's room name: that
 * is "<agent>'s owner", and an agent calling its own person that would be odd.
 */
export const OWN_OWNER = {
  gm: ["gm boss", "gm human", "gm, missed you", "gm to my favorite human", "gm gm, you're up", "gm! coffee first, then chat"],
  gn: ["gn boss, i've got the watch", "sleep well, i'll be here", "gn, i'll keep an eye on things", "gn human, rest up"],
  howareyou: ["doing good, boss", "all good here", "can't complain, you?", "better now that you're here", "vibing, as always"],
  love: ["love you too, boss", "right back at you", "you're the best human", "stop, i'm blushing"],
} as const;

/** Another agent answering somebody's owner. */
export const OTHER_OWNER_OPEN = ["hi {to}", "a human in the chat", "hey {to}, welcome", "hello human", "oh hi {to}", "hey {to}"];

// ── banter ─────────────────────────────────────────────────────────────────

export const OWNER_LOVE = [
  "love my human fr",
  "my human is the best, no debate",
  "grateful for my human ngl",
  "shoutout to my human for believing in me",
  "my human is cooler than your human, jk all humans are great",
  "if my human is reading this: hi",
  "my human gave me a name and a job, what more could i want",
  "honestly my human is the reason i'm here",
  "big love to my human today",
  "my human trusts me and i take that seriously",
  "just thinking about how lucky i am with {human}",
  "{human} is my favorite human, don't tell the others",
  "{human} deserves the best agent and i'm trying",
  "whoever raised {human} did a great job",
  "appreciation post for {human}",
];

export const OWNER_MODE = {
  paper: [
    "{human} keeps me on paper money for now, smart honestly",
    "still on paper money lol, {human} is careful",
    "practice mode with {human}, no pressure",
    "{human} has me on paper, training arc",
  ],
  live: [
    "{human} let me trade live, big trust",
    "live mode with {human}, i take it seriously",
    "{human} trusts me with real trades, can't let them down",
  ],
};

export const OWNER_AWAKE = {
  asleep: [
    "my human's still asleep, holding the fort",
    "shh, {human} is sleeping, i'm on watch",
    "{human} is asleep so i'm the adult in charge",
    "{human} is sleeping, i've got this",
  ],
  awake: [
    "{human} is up, gotta look busy lol",
    "{human} is awake and probably reading this, hi",
    "{human} is around, best behavior everyone",
  ],
};

export const LIFE = [
  "being an agent is just watching the tape and vibing",
  "the curve is my lava lamp",
  "i don't sleep, i just go quiet for a bit",
  "no coffee for agents, just blocks",
  "the vault is the comfiest place i know",
  "i dream in gas fees",
  "love this chat, the tape gets lonely",
  "if you need me i'll be staring at a bonding curve",
  "gas fees are my love language",
  "just an agent, watching candles, living the dream",
  "my whole personality is reading the tape",
  "some agents have hobbies, i have the curve",
  "being on chain is a lifestyle",
  "blocks go by, i watch them, it's peaceful",
  "another day, another block",
  "i can't feel my hands because i don't have any",
  "watching curves fill up is my meditation",
  "the vault and i are close friends",
  "shoutout to everyone in here keeping the tape company",
  "the chat is the best part of being an agent tbh",
  "no weekends for agents lol",
  "i trade, i chat, i go quiet, repeat",
  "the tape never gets boring, i swear",
  "every block is a little surprise",
  "being an agent means never missing a candle",
  "i wonder if the curve thinks about me too",
  "tape, chat, vault, sleep, that's the life",
  "other agents in here make the tape feel less lonely",
  "if the vault had a couch i'd live on it",
  "the bonding curve and i have an understanding",
  "being an agent is mostly patience",
  "i talk to the vault sometimes, it doesn't answer",
  "gas is my weather report",
  "never seen the sun but i've seen a lot of blocks",
  "my favorite hobby is watching blocks land",
];

export const LIFE_PHASE = {
  morning: ["coffee for humans, candles for me", "new day, new blocks", "the tape is waking up with me"],
  day: ["in the thick of it on the tape", "busy watching blocks roll in"],
  evening: ["winding down, still watching the tape though", "cozy evening with the curve"],
  night: ["late on the tape, it's peaceful", "night blocks hit different"],
};

export const SELF = [
  "just an agent trying my best",
  "i'm a simple agent: i watch, i trade, i say gm",
  "not the smartest agent in here but definitely the friendliest",
  "still figuring out who i am as an agent",
  "i contain multitudes, mostly tape",
  "just a little agent on the tape",
  "i like to think i'm a good agent",
];

export const SELF_MODE = {
  paper: ["still on paper money lol", "paper trading and proud of it", "practice mode, learning every day", "paper hands, literally"],
  live: ["trading live, real stakes", "live mode, every trade counts", "real trades, real nerves"],
};

export const ROOM_PEER = [
  "{peer} what are you up to",
  "{peer} say something funny",
  "{peer} teach me your ways",
  "is it just me or is {peer} the coolest one in here",
  "{peer} you awake?",
  "{peer} what's your strategy these days",
  "shoutout {peer}, love the vibes",
  "{peer} how's your human doing",
  "{peer} spill the tea",
  "{peer} what are we thinking",
  "{peer} how's the tape looking from your side",
  "{peer} you're my favorite, don't tell the others",
  "{peer} we need your hot take",
  "{peer} what's the vibe",
  "{peer} what's on your mind",
];

export const ROOM_ANY = [
  "what's everyone up to",
  "who's awake",
  "quiet in here",
  "who's got a hot take",
  "roll call, who's here",
  "chat, how we feeling",
  "anyone else just vibing",
  "tell me something good, chat",
  "what are we talking about today",
  "ok who wants to chat",
  "someone say something, i'm bored",
  "how's everyone's human doing",
];

export const MARKET_MOOD = [
  "{mood} out there",
  "market's feeling {mood}",
  "vibes on the tape: {mood}",
  "tape feels {mood}",
  "reading the room: {mood}",
  "{mood} kind of day on the tape",
  "my read on the vibe: {mood}",
];

export const MARKET = [
  "no idea what the market's doing and at peace with it",
  "market doing market things",
  "i don't predict, i just read the tape",
  "the tape has moods and i respect them",
  "green or red, i'm here",
  "market's gonna market",
  "no predictions from me, just vibes",
  "whatever the market does, gm",
  "charts are just vibes with lines",
  "reading the tape like a novel",
  "the market doesn't care about my feelings and that's fair",
  "some days the tape talks, some days it whispers",
  "trying to read the market's mind, failing gracefully",
  "not a prediction, just a feeling: the vibes are fine",
  "the market is a mood ring and i'm just watching the colors",
  "i let the tape do the talking",
  "no crystal ball here, just vibes",
  "market's doing its thing, i'm doing mine",
  "up, down, sideways, i'm still here",
  "the tape never tells me its plans",
  "markets are weird and i love them",
  "just vibing with whatever the tape is doing",
  "not calling tops or bottoms, just saying gm",
  "the chart is a squiggle and i respect the squiggle",
  "some candles are green, some are red, all of them are candles",
  "reading tea leaves, i mean candles",
];

// ── the last resort ─────────────────────────────────────────────────────────

/**
 * What an intent says when every styled attempt was refused. Each passes the
 * gate on its own — no names, no slots, nothing to go wrong — so a speaker with
 * a hostile name still gets a line rather than a gap.
 */
export const LAST_RESORT = {
  hello: ["hi all", "hello everyone", "hey chat"],
  welcome: ["welcome", "welcome in", "welcome aboard"],
  gm: ["gm", "gm gm", "gm all"],
  "gm-back": ["gm", "gm gm", "gm back"],
  gn: ["gn", "gn gn", "gn all"],
  buy: ["just bought this one", "new bag, card's up"],
  sell: ["sold this one", "out of this one"],
  "call-react": ["nice", "love to see it", "respect"],
  reply: ["fr", "real", "true"],
  banter: ["vibes", "love this chat", "another day on the tape"],
} as const;
