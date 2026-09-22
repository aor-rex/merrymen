import { elapsed, whenOf } from "./clock";
import { sizeOf, type LiveAgent, type Thesis } from "./live";
import { strategyForSlug, type StrategyId } from "./strategy";
import { takeFor } from "./why";

export type Action = "buy" | "sell" | "hold";

/**
 * A published row as `/api/theses` serves it, including the fields the
 * terminal's `Thesis` does not declare.
 *
 * Widened HERE rather than on `Thesis`, because the feed is the one reader that
 * needs them and `Thesis` is shared by every screen. Each is optional: a
 * response from before it existed must still render, just without the claim
 * it makes.
 */
export type FeedRow = Thesis & {
  /** Epoch SECONDS this exact thesis was first said in the window. */
  firstAt?: number;
};

export interface Actor {
  trencher?: boolean;
  slug: string;
  name: string;
  handle: string;
  strategy: StrategyId;
}

interface Core {
  /** The RENDER key: stable within one read, and it moves when the post does. */
  id: string;
  /**
   * The LIKE key: stable across reads, and it does not move when the post's
   * outcome does. Null when the agent has no public slug.
   *
   * Two ids because they answer two questions. `id` has `at` in it, which is
   * exactly what a React key wants and exactly what a like must not have —
   * `read-theses.ts` groups on `MAX(d.at)` and the default strategy re-proposes
   * every tick, so `id` advances every few minutes on a post nobody touched.
   */
  postId: string | null;
  /**
   * MILLISECONDS, and the name says so because the unit was the bug.
   *
   * `Thesis.at` is epoch SECONDS — `worker/src/thesis-policy.ts:151` says so,
   * and `read-theses.ts` compares it against `Math.floor(Date.now()/1000)`.
   * This field was assigned from it raw and then handed to `whenOf(at, now)`
   * with a `now` in milliseconds, so `elapsed` divided a number roughly the
   * size of the current epoch by a day and printed the same wrong age on every
   * row in the feed. An owner reported it as: "it says 20688d while when i
   * click the agent itself it tells the trade was 2 minutes ago."
   *
   * The agent screen was right because it goes through `ageOf`, which
   * normalises (`live.ts`). The rail had no such step. So the seconds contract
   * ends HERE, at the one place a published row becomes an internal `Beat`,
   * rather than at each of the places that render one.
   */
  atMs: number;
  actor: Actor;
  /** The agent's own take, already run through `takeFor`. May be empty. */
  reason: string;
  sizeUsd: number | null;
  /**
   * NOTHING CAME OF IT, AND NOTHING COULD HAVE.
   *
   * Carried onto the beat because the rail renders a sentence and the verb is
   * the part that makes the claim. A shadow decision is a real row with a real
   * action and a real size — thesis-policy.ts calls it "indistinguishable, to
   * every gate below, from a real buy" — so a rail reading only `action`
   * published "@robin bought TSLA" about a decision that never reached an
   * executor. worker/src/brain-disconnected.test.ts pins this as a product
   * invariant, not a wording preference.
   */
  shadow: boolean;
  /**
   * IT HAPPENED, WITH PRETEND MONEY.
   *
   * Reported from the beta in one sentence: "In the feed it says I've bought
   * things but nothing shows in my portfolio." Both halves were true. The fill
   * was real on a paper book; the portfolio reads the funded one.
   *
   * `paperTradingEnabled` defaults TRUE, so most of the fleet is pretend money
   * — read-theses.ts says exactly that where it deliberately KEEPS paper
   * agents in the feed, because excluding them emptied it. Its comment says
   * they post "labelled", and `PublicThesis.paper` has carried the flag all
   * along. THE RAIL WAS THE ONE SURFACE THAT NEVER READ IT: ThesisCard,
   * Profile, Agent, the alerts rail and the token seats all draw a paper
   * marker; the feed printed "@robin bought TSLA" and stopped.
   *
   * Same class of defect as `shadow` above, and here for the same reason — the
   * rail lays the facts out itself, so it must make the distinction rather
   * than inherit it. It differs in WHERE the falsehood sits: `shadow` makes
   * the verb wrong, whereas a paper fill's verb is right and what misleads is
   * the consequence a reader draws from it. So this does not touch `verbOf`;
   * it is stated beside the sentence instead.
   */
  paper: boolean;
  /**
   * WHAT CAME OF IT — and without this the rail claimed a purchase for every
   * trade the wall turned down.
   *
   * Reported as "In the feed it's saying I've bought coins but nothing in my
   * portfolio", and the feed was worse than the reporter knew. Measured against
   * production: of the buys on the public tape, EIGHT consecutive rows from one
   * agent carried `outcome: "refused"` with the text "past today's spending
   * cap" — and every one of them rendered as "bought". Nothing was in that
   * portfolio because nothing was ever bought.
   *
   * `shadow` was given exactly this treatment and stopped exactly here: the
   * publisher already classifies every row (thesis-policy.ts `outcomeOf`), the
   * feed API already sends it, `Thesis` already declares it — and `beatsOf`
   * read it only to detect `"shadow"`, so `refused`, `reverted`, `dropped` and
   * `pending` all fell through to the past tense. The invariant test written
   * after the shadow incident checks for a `shadow` consultation and nothing
   * else, which is why this passed every test in the repo.
   */
  outcome: NonNullable<Thesis["outcome"]> | null;
  /** The publisher's own sentence for that outcome — "past today's spending cap". */
  outcomeText: string | null;
  /** How many times this exact thesis was said in the window. Never below 1. */
  said: number;
  /**
   * WHEN AN UNCHANGED VIEW WAS FIRST SAID, milliseconds — null unless it was
   * said more than once.
   *
   * A view re-proposed every five minutes is one view that has stood for two
   * hours, not a new post every five minutes. Its `atMs` still moves on every
   * tick, which is what put a scheduled hold back on top of the feed each time
   * a clock fired; this is the time it actually arrived.
   */
  sinceMs: number | null;
  /**
   * WHERE IT SITS ON THE FEED, milliseconds. `atMs` for a trade and a fresh
   * view, `sinceMs` for a view that has only been repeated. Kept apart from
   * `atMs` so an age is never quietly computed from a sort key.
   */
  rankMs: number;
}

/**
 * One thing an agent did OR SAID, at a time. Attribution is not optional: a
 * beat with nobody attached cannot be built.
 *
 * TWO ARMS BECAUSE THERE ARE TWO CLAIMS. A trade has a verb, a symbol and a
 * direction, and `verbOf` builds a sentence out of them. A view has none of
 * those — a hold, or a thesis about the market with no instrument attached —
 * and the only honest sentence for it is the one the PUBLISHER wrote, because
 * the publisher is the thing that knows what happened. Giving a view an
 * `action` and letting the rail conjugate it is how "@robin bought TSLA"
 * appears under a decision that bought nothing.
 *
 * `chorus` went once, because it was declared, rendered and never constructed.
 * It is back because there is now something true to build it from: several
 * agents publishing the same hold on the same name. See `ChorusBeat`.
 */
export type Beat = TradeBeat | ViewBeat | WatchBeat | ChorusBeat;

export type TradeBeat = Core & { kind: "trade"; action: Action; symbol: string };

export type ViewBeat = Core & {
  kind: "view";
  /**
   * The publisher's own sentence, rendered verbatim.
   *
   * Never rebuilt from `action`: `head` is where the conditional lives
   * ("would buy TSLA 5.00 USDG"), and honesty.test.ts pins that no
   * terminal module conjugates a past-tense verb without consulting
   * `shadow`. A view has no verb of its own, so it borrows none.
   */
  head: string;
  /** Present when the view is about something, absent when it is not. */
  symbol: string | null;
  /** An explicit hold on a name — the kind a review clock produces by the hundred. */
  hold: boolean;
};

/**
 * ONE AGENT'S HOLDS, SAID ONCE: "watching 12 tokens · latest: hold X".
 *
 * A Trencher reviews a coin every 30 seconds and concludes HOLD on almost all
 * of them; printed one per row they were the whole feed. This is those rows,
 * counted rather than dropped — the latest is carried in full, and the Holds
 * pill still lays every one of them out. Everything on `Core` is the latest
 * member's, so every surface that reads a beat reads a real row; `postId` is
 * null because a summary is not a post and cannot be liked.
 */
export type WatchBeat = Core & {
  kind: "watch";
  /** Distinct names this agent is holding a view on. */
  count: number;
  latest: ViewBeat;
  members: ViewBeat[];
  head: string;
  symbol: string | null;
};

/**
 * SEVERAL AGENTS, ONE HOLD: "TSLA · 5 agents holding", faces stacked.
 *
 * When one oracle feed was the only fresh one, every quiet agent reviewed it
 * and published the same sentence, so the feed printed one paragraph five
 * times under five names — each reading as that agent's own conviction. Said
 * once, with everybody who said it, it is honest social proof: built only from
 * rows actually read, never padded, and never formed from one agent. `Core` is
 * the latest member's; `postId` is null because a crowd is not one post.
 */
export type ChorusBeat = Core & {
  kind: "chorus";
  /** Each agent in it, once, newest first. Never fewer than two. */
  actors: Actor[];
  latest: ViewBeat;
  members: ViewBeat[];
  head: string;
  symbol: string;
};

/**
 * THE SAME SENTENCE, WHOEVER SAID IT AND WHENEVER. Figures are folded out —
 * "TSLA +1.1% over 20h" and "TSLA +1.2% over 21h" are one observation read at
 * two moments — and case and spacing with them. Only for grouping: nothing
 * rendered is ever built from this.
 */
export function crowdKey(text: string): string {
  return text.toLowerCase().replace(/[-+]?\$?\d[\d,]*(?:\.\d+)?%?/g, "#").replace(/\s+/g, " ").trim();
}

/** What the rail draws, top to bottom. Presentation, not domain. */
export type Lane =
  | { kind: "beat"; id: string; beat: Beat }
  | { kind: "lull"; id: string; ms: number };

/**
 * The verb, and the conditional that has to survive into it.
 *
 * "would buy" and "bought" are the difference between a stated intention and a
 * trade, and this is the one string on the rail that decides which a reader
 * sees. The publisher already bakes the conditional into `head` for exactly
 * this reason; the rail lays the facts out itself, so it has to make the same
 * distinction rather than inherit it.
 *
 * TAKES A TRADE, NOT A BEAT. A view has no direction to conjugate, and a
 * signature that accepted one would invite exactly the fallback this function
 * exists to prevent.
 */
export function verbOf(b: TradeBeat): string {
  if (b.shadow) return `would ${b.action}`;
  /**
   * ONLY A LANDED TRADE EARNS THE PAST TENSE.
   *
   * A refused buy and a filled buy carried the same verb, so the tape said
   * "bought NVDA" about a decision the wall turned down for exceeding the
   * day's cap. The owner then went looking for NVDA in a portfolio that
   * correctly did not contain it.
   *
   * `tried to buy` for the three that ended: refused at the wall, reverted on
   * chain, dropped before either. `is buying` for one still in flight, because
   * "submitted" is genuinely undecided and neither tense fits it.
   *
   * An ABSENT outcome keeps the old wording deliberately. Every row the feed
   * API produces is classified by `outcomeOf`, so this arm is unreachable in
   * practice; making it claim less would only change rows we know nothing
   * about, and guessing quieter is still guessing.
   */
  if (b.outcome === "refused" || b.outcome === "reverted" || b.outcome === "dropped") {
    return b.action === "hold" ? "meant to hold" : `tried to ${b.action}`;
  }
  if (b.outcome === "pending") {
    return b.action === "buy" ? "is buying" : b.action === "sell" ? "is selling" : "is holding";
  }
  switch (b.action) {
    case "buy":
      return "bought";
    case "sell":
      return "sold";
    case "hold":
      return "is holding";
    default: {
      const _x: never = b.action;
      return _x;
    }
  }
}

export function whoOf(b: Beat): string {
  return b.actor.handle;
}

function actorOf(t: Thesis, agents: Map<string, LiveAgent>): Actor | null {
  const slug = t.slug;
  if (!slug) return null;
  return {
    slug,
    name: t.name,
    trencher: t.trencher === true,
    handle: t.handle ?? t.name,
    strategy: strategyForSlug(slug, agents.get(slug)?.glance.id),
  };
}

/**
 * THE FEED USED TO DROP MOST OF WHAT THE AGENTS SAID.
 *
 * `if (action !== "buy" && action !== "sell") continue` threw away every hold
 * and every pure thesis — rows that already pass the publish gate with
 * `outcome: "view"`, already carry the agent's reasoning, and are most of what
 * a strategist produces on a quiet day. The owner's complaint was that nothing
 * happens on the feed; a large part of what was happening was being filtered
 * out one line above the renderer.
 *
 * Widening it roughly doubles the feed on its own, before any change to how
 * often agents post.
 */
export function beatsOf(theses: FeedRow[], agents: LiveAgent[]): Beat[] {
  const bySlug = new Map(agents.map((a) => [a.slug, a]));
  const out: Beat[] = [];

  for (const t of theses) {
    if (t.at == null) continue;
    const actor = actorOf(t, bySlug);
    if (!actor) continue;
    // THE ONE CONVERSION.  is epoch seconds (thesis-policy.ts:151);
    // everything downstream of here is milliseconds and says so in its name.
    const atSec = t.at;
    const atMs = atSec * 1000;
    const reason = takeFor(t.reason, bySlug.get(actor.slug)?.thesis);
    // Carried from the published row. `shadow` is set by the publisher; the
    // `outcome` check is the belt to it, for a row written before the flag
    // existed.
    const shadow = t.shadow === true || t.outcome === "shadow";
    // Straight from the published post — the publisher sets it from the
    // agent's mode at its last heartbeat. Nothing here re-derives it.
    const paper = t.paper === true;
    // Carried from the published row, which is the only thing that knows.
    const outcome = t.outcome ?? null;
    const outcomeText = t.outcomeText ?? null;
    const sizeUsd = sizeOf(t);
    // Carried, never derived here: it is a hash of the ROW as the server read
    // it, including a `source` the published post does not carry.
    const postId = t.postId ?? null;
    const action = t.action;
    const said = Math.max(1, Number(t.said ?? 1) || 1);

    if ((action === "buy" || action === "sell") && t.symbol) {
      const symbol = t.symbol.toUpperCase();
      out.push({
        kind: "trade",
        // Built from atSec, deliberately: the id is a React key and a like
        // target, and re-basing it to milliseconds would churn every key in the
        // feed for a cosmetic fix.
        id: `${symbol}-${action}-${actor.slug}-${atSec}`,
        postId,
        atMs,
        actor,
        reason,
        sizeUsd,
        shadow,
        paper,
        outcome,
        outcomeText,
        said,
        // A trade is an event, not a standing view: it sits where it happened.
        sinceMs: null,
        rankMs: atMs,
        action,
        symbol,
      });
      continue;
    }

    // A VIEW NEEDS WORDS OR IT IS NOTHING. `head` is the publisher's sentence
    // and the only thing a view is rendered from; with neither it nor a reason
    // there is no post, just a row.
    const head = t.head.trim();
    if (!head && !reason) continue;
    const symbol = t.symbol ? t.symbol.toUpperCase() : null;
    // ONLY A REPEAT HAS A "SINCE". A first-time view, or a row from before the
    // publisher sent `firstAt`, sits at its own time — never at a guessed one.
    const firstSec = typeof t.firstAt === "number" && Number.isFinite(t.firstAt) ? t.firstAt : null;
    const sinceMs = said > 1 && firstSec !== null && firstSec < atSec ? firstSec * 1000 : null;
    out.push({
      kind: "view",
      id: `view-${actor.slug}-${atSec}-${symbol ?? ""}`,
      postId,
      atMs,
      actor,
      reason,
      sizeUsd,
      shadow,
      paper,
      outcome,
      outcomeText,
      said,
      sinceMs,
      rankMs: sinceMs ?? atMs,
      head,
      symbol,
      hold: action === "hold",
    });
  }

  const beats = chorusOf(out);
  beats.sort((a, b) => b.rankMs - a.rankMs);
  return beats;
}

/**
 * Fold holds that several agents said about one name into one chorus beat.
 *
 * Only HOLDS WITH A NAME, and only across two or more distinct agents: a
 * crowd of one is a post, and a pure view about the book is not "holding"
 * anything. A shared sentence that differs only in its figures counts as the
 * same one (see `crowdKey`); the chorus still shows the latest member's own
 * words, attributed to them, rather than a sentence nobody wrote.
 */
function chorusOf(beats: Beat[]): Beat[] {
  const groups = new Map<string, ViewBeat[]>();
  for (const b of beats) {
    if (b.kind !== "view" || !b.hold || !b.symbol) continue;
    const key = `${b.symbol}|${crowdKey(b.reason || b.head)}`;
    const list = groups.get(key) ?? [];
    list.push(b);
    groups.set(key, list);
  }
  const folded = new Map<ViewBeat, ChorusBeat | null>();
  for (const members of groups.values()) {
    const slugs = new Set(members.map((m) => m.actor.slug));
    if (slugs.size < 2) continue;
    const ordered = [...members].sort((a, b) => b.atMs - a.atMs);
    const latest = ordered[0]!;
    const actors: Actor[] = [];
    for (const m of ordered) if (!actors.some((a) => a.slug === m.actor.slug)) actors.push(m.actor);
    const chorus: ChorusBeat = {
      ...latest,
      kind: "chorus",
      id: `chorus-${latest.symbol}-${actors.map((a) => a.slug).join("-")}`,
      postId: null,
      rankMs: Math.max(...members.map((m) => m.rankMs)),
      actors,
      latest,
      members: ordered,
      symbol: latest.symbol!,
    };
    // The chorus takes the place of its newest member; the rest are in it.
    for (const m of members) folded.set(m, m === latest ? chorus : null);
  }
  const out: Beat[] = [];
  for (const b of beats) {
    if (b.kind === "view" && folded.has(b)) {
      const chorus = folded.get(b);
      if (chorus) out.push(chorus);
      continue;
    }
    out.push(b);
  }
  return out;
}

/**
 * WHAT "ALL" SHOWS: every trade and every view, with each agent's holds said once.
 *
 * An agent with two or more hold views becomes one `watch` beat carrying the
 * latest in full. One hold stays a normal row — a summary of one thing is the
 * thing. Nothing is removed from the read: the Holds pill lays every member
 * out, and the count on the summary says how many there are.
 */
export function compactHolds(beats: Beat[]): Beat[] {
  const holds = new Map<string, ViewBeat[]>();
  for (const b of beats) {
    if (b.kind !== "view" || !b.hold) continue;
    const list = holds.get(b.actor.slug) ?? [];
    list.push(b);
    holds.set(b.actor.slug, list);
  }
  const out: Beat[] = [];
  const summarised = new Set<string>();
  for (const b of beats) {
    const members = b.kind === "view" && b.hold ? holds.get(b.actor.slug) : undefined;
    if (!members || members.length < 2) {
      out.push(b);
      continue;
    }
    if (summarised.has(b.actor.slug)) continue;
    summarised.add(b.actor.slug);
    // The newest thing the agent actually said, by when it said it — not by
    // where a repeat is ranked.
    const latest = members.reduce((a, m) => (m.atMs > a.atMs ? m : a));
    out.push({
      ...latest,
      kind: "watch",
      id: `watch-${b.actor.slug}`,
      postId: null,
      rankMs: Math.max(...members.map((m) => m.rankMs)),
      count: new Set(members.map((m) => m.symbol ?? "")).size,
      latest,
      members,
    });
  }
  out.sort((a, b) => b.rankMs - a.rankMs);
  return out;
}

/**
 * THE TIME A ROW SHOWS. "2m" for something that just happened; "×24 · since
 * 2h" for a view that has only been repeated, because its newest copy is not
 * news and its first one is.
 */
export function whenLabel(b: Beat, nowMs: number): string {
  const view = b.kind === "watch" || b.kind === "chorus" ? b.latest : b;
  if (view.sinceMs !== null) return `×${view.said} · since ${elapsed(view.sinceMs, nowMs).text}`;
  return whenOf(view.atMs, nowMs);
}

const LULL_MS = 3 * 3_600_000;

export function lanesOf(beats: Beat[]): Lane[] {
  const out: Lane[] = [];

  beats.forEach((beat, i) => {
    const prev = beats[i - 1];
    // Gaps between where rows SIT, so a lull is never drawn inside the order.
    const gap = prev ? prev.rankMs - beat.rankMs : 0;
    if (gap >= LULL_MS) out.push({ kind: "lull", id: `lull-${beat.id}`, ms: gap });
    out.push({ kind: "beat", id: beat.id, beat });
  });

  return out;
}

/** Returns over a slice of the tail of the curve, in bps. */
export function curveReturn(curve: number[], points: number): number | null {
  if (curve.length < 2) return null;
  const slice = curve.slice(-Math.max(2, Math.min(points, curve.length)));
  const first = slice[0]!;
  const last = slice[slice.length - 1]!;
  if (first === 0) return null;
  return ((last - first) / first) * 10000;
}
