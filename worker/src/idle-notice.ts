/**
 * WHAT A TICK THAT PROPOSED NOTHING TELLS THE OWNER, AND WHAT IT POSTS.
 *
 * Lifted out of the tick in index.ts so a test can run it: the decision was
 * three ternaries and a guard inside main(), and a revert of any of them passed
 * every test in the repo. index.ts still does the writing — this only decides
 * what gets written, from the same inputs.
 *
 * An empty intent list is what a healthy quiet tick looks like AND what a
 * strategy that cannot act looks like. Over one weekend that ambiguity read, to
 * every owner of a basket agent, as "no trading is being done" — when in fact
 * all 24 equity feeds were stale and the strategy was correctly refusing to buy
 * without a reference price. So a strategy hands back WHY, and it is said:
 *
 *   - to the OWNER, as an event, in the owner's register (renderWhy's default,
 *     remedies included);
 *   - to the FEED, as a `view` decision in the public register — unless the
 *     reason is account state (publishesIdle).
 *
 * ONCE PER CHANGE, not once per tick: a stale weekend is 360 ticks, and this
 * repo already carries the incident where 1,242 identical rows told nobody
 * anything. `last` is the owner sentence already said; the caller keeps it.
 */
import type { AssetMode } from "../../packages/core/src/index";
import { publishesIdle, renderWhy, type Why } from "./strategies/reasons";
import { publicationSourceFor } from "./thesis-policy";

/**
 * A MODE THAT LEAVES NOTHING TO TRADE MUST SAY SO.
 *
 * The one way the asset mode could be worse than no feature at all: an owner
 * picks "crypto only" with a basket of equities, every strategy resolves zero
 * legs, and the agent goes quiet with nothing on any screen to connect the
 * silence to the dropdown they just moved. That is the exact shape of the
 * trencher incident index.ts already carries — "it didn't take any trades
 * yet", then "I think I'm stuck in paper mode".
 *
 * `legs(mode)` counts what the strategies would resolve under that mode — the
 * caller passes legsForUniverse, the function makeStrategy resolves legs from,
 * so this cannot disagree with them. ONLY WHEN THE MODE IS WHAT EMPTIED IT: an
 * empty basket is an empty basket, and blaming the mode for one would be a
 * different wrong sentence. The count with no mode applied is what tells the
 * two apart. The plain fact, with no remedy; see MODE_EMPTIED_REMEDY.
 */
export function modeEmptiedFact(mode: AssetMode, legs: (mode: AssetMode) => number): string | null {
  if (mode === "all") return null;
  if (legs(mode) > 0 || legs("all") === 0) return null;
  return (
    `nothing in your basket is ${mode === "stocks" ? "a stock" : "a coin"}, and your asset mode is ` +
    `${mode === "stocks" ? "Stocks only" : "Crypto only"} — so there is nothing to trade`
  );
}

/**
 * The owner's half of an emptied asset mode: they are the one person who can
 * change it. The public half is the plain fact — "Change the mode in Settings"
 * on a public feed is an instruction to a stranger about somebody else's
 * account; it was live for weeks and is the exact texture of a worker log
 * leaking onto a desk. `renderWhy` draws the same line for its own
 * remedy-bearing arms.
 */
export const MODE_EMPTIED_REMEDY = "Change the mode in Settings, or add something it allows to your basket.";

export interface IdleNotice {
  /** The owner sentence now standing, for the next tick's change test. */
  last: string | null;
  /** The owner's event, when the sentence changed to something. */
  event: { level: "ok" | "warn"; message: string } | null;
  /** The public view's reason, when there is an event and it may be a post. */
  view: string | null;
}

export function idleNotice(input: {
  /** The strategy's own reason, when it gave one. */
  idle: Why | null | undefined;
  /**
   * A MODE THAT LEAVES NOTHING TO TRADE, as the plain fact, or null. Computed
   * by the caller from the same inputs makeStrategy resolves legs from, so it
   * cannot disagree with them. A strategy's own reason wins over it.
   */
  modeEmptied: string | null;
  last: string | null;
}): IdleNotice {
  const { idle, modeEmptied, last } = input;
  const owner = idle ? renderWhy(idle) : modeEmptied === null ? null : `${modeEmptied}. ${MODE_EMPTIED_REMEDY}`;
  if (owner === last) return { last, event: null, view: null };
  if (owner === null) return { last: null, event: null, view: null };
  const posts = !idle || publishesIdle(idle);
  return {
    last: owner,
    // A REASON THAT DOES NOT POST IS A WARNING. "ok" is the running commentary
    // and no owner surface renders it — the desk notice, the rail and the
    // Android app all read warn and above — so for most reasons the owner
    // meets it as the public view. A tripped breaker has no view: it is the
    // account's losses and stays off the feed. At "ok" it had no surface at
    // all, and the refusal WARN it replaced ("policy rejected swap:
    // drawdown-breaker") stopped being written the moment the strategies
    // stopped proposing — so the desk went on showing whatever warned last,
    // for a Trencher a now-false "no pool passes the entry checks".
    event: { level: posts ? "ok" : "warn", message: owner },
    view: posts ? (idle ? renderWhy(idle, "public") : modeEmptied) : null,
  };
}

/**
 * THE ROW THAT MAKES A SILENCE A POST.
 *
 * A tick that proposes nothing used to write its reason to `events` and
 * nothing else — and only `decisions` can become a post, so an agent that
 * looked at the market and concluded "not today, and here is why" talked to a
 * table nobody reads. A decision with NO ACTION is a `view`: thesis-policy
 * classifies it, and the feed renders it from the publisher's own words. So
 * this row has no action, no symbol and no size — that absence is what makes
 * it a view, and `outcomeOf` is what turns the absence into the word.
 *
 * THROUGH publicationSourceFor, NOT A TEMPLATE. The template spelled the
 * strategist's source `strategy:llm-strategist(anthropic:claude-opus-4)` — a
 * key SOURCE_POLICY has never contained — so the sentence written to prove the
 * agent was thinking published nothing at all (strategist-publish.test.ts).
 */
export function idleViewRow(args: { id: string; agentId: string; strategyName: string; reason: string }): {
  id: string;
  agent_id: string;
  source: string;
  reason: string;
} {
  return { id: args.id, agent_id: args.agentId, source: publicationSourceFor(args.strategyName), reason: args.reason };
}
