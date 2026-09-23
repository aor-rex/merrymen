/**
 * WHAT A TICK THAT PROPOSED NOTHING TELLS THE OWNER, AND WHAT IT POSTS.
 *
 * Lifted out of the tick in index.ts so a test can run it: the decision was
 * three ternaries and a guard inside main(), and a revert of any of them passed
 * every test in the repo. Then the writing was lifted too (IdleChannel, below),
 * because a revert of THAT — the change gate, the level, the post's register —
 * passed every test as well. index.ts now only calls `tell`.
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
 * anything. `last` is the owner sentence already said; IdleChannel keeps it.
 */
import type { AssetMode } from "../../packages/core/src/index";
import { addDecision, addEvent, newDecisionId, ownerNotice } from "./store";
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

/**
 * WHAT THE OWNER'S NOTICE SHOWS NOW: the newest warn among the agent's newest
 * events, by the rule the desk, the rail and the Android app apply
 * (store.ownerNotice). `atMs` is when it was written.
 */
export interface ShownNotice {
  message: string;
  atMs: number;
}

/**
 * HOW LONG A NEWER NOTICE KEEPS THE DESK before a standing reason is said again.
 *
 * Long enough that a line somebody else just wrote — a discovery failure, a
 * refusal — is read before it is covered; short against a breaker that stays
 * tripped for days. A warn written every tick is younger than this every time
 * it is asked, so the breaker waits for it rather than alternating with it:
 * the table never carries two warnings a tick.
 */
export const RESTATE_AFTER_MS = 10 * 60_000;

/** Where the idle channel writes, and what it reads back. idleChannelOnStore binds the store's own. */
export interface IdleSinks {
  addEvent(agentId: string, level: "ok" | "warn", message: string): Promise<void>;
  addDecision(row: ReturnType<typeof idleViewRow>): Promise<void>;
  newDecisionId(): string;
  /** The owner's notice as it stands: null when none shows, undefined when it could not be read. */
  shownNotice(agentId: string): Promise<ShownNotice | null | undefined>;
  now?(): number;
  log?(line: string): void;
}

/**
 * THE TICK'S IDLE WRITE, WHOLE — what used to be the idle block in main().
 *
 * That block kept `lastIdleReason` itself and wrote what idleNotice decided,
 * and no test booted it: dropping the change gate, or publishing the owner's
 * sentence as the post, passed every test in the repo. So the state and both
 * writes live here, and index.ts only calls `tell` with the store's sinks.
 *
 * AND A WARNING THAT STILL STANDS IS KEPT WHERE THE OWNER READS IT. A reason
 * that cannot be a post (a tripped breaker) reaches the owner only as a warn
 * event, and the desk notice, the rail and the Android app show only the
 * newest warn among the newest 40 events. Written once, at the change, it is
 * covered by the next warn anybody writes — for a Trencher the discovery
 * retry line, which then read as the reason for days — or aged out by the
 * running commentary, and the desk showed nothing while the breaker was still
 * tripped. So while such a reason stands and the notice no longer shows it,
 * it is said again: at once when nothing shows, and otherwise once the notice
 * that replaced it has had RESTATE_AFTER_MS. Still once per change for
 * everything else — a reason that posts is never restated, because its view
 * row would repeat with it.
 */
export class IdleChannel {
  /** The owner sentence standing — `lastIdleReason`, as the tick knew it. */
  private last: string | null = null;
  /** Whether the standing sentence went out as a warning, the one kind that is restated. */
  private standingWarn = false;
  private readonly restateAfterMs: number;

  constructor(
    private readonly sinks: IdleSinks,
    opts: { restateAfterMs?: number } = {},
  ) {
    this.restateAfterMs = opts.restateAfterMs ?? RESTATE_AFTER_MS;
  }

  async tell(input: {
    agentId: string;
    strategyName: string;
    idle: Why | null | undefined;
    modeEmptied: string | null;
  }): Promise<void> {
    const notice = idleNotice({ idle: input.idle, modeEmptied: input.modeEmptied, last: this.last });
    this.last = notice.last;
    if (notice.event) {
      this.standingWarn = notice.event.level === "warn";
      this.sinks.log?.(`[tick] idle — ${notice.event.message}`);
      await this.sinks.addEvent(input.agentId, notice.event.level, notice.event.message);
      // THE STRUCTURAL REASON A QUIET FLEET READS AS A DEAD FEED: only
      // `decisions` can become a post, so the silence is also written as a
      // `view` (idleViewRow) — inside the same change gate as the event, or an
      // unchanged reason would write an identical row every tick. EXCEPT A
      // SILENCE THAT IS ACCOUNT STATE: idleNotice gives it no view.
      if (notice.view !== null) {
        await this.sinks.addDecision(
          idleViewRow({ id: this.sinks.newDecisionId(), agentId: input.agentId, strategyName: input.strategyName, reason: notice.view }),
        );
      }
      return;
    }
    // Nothing new to say. A reason that still stands, and went out as a
    // warning, is said again if the owner's notice no longer shows it. (A new
    // reason always arrives with an event above, which resets standingWarn.)
    if (notice.last !== null && this.standingWarn && (await this.covered(input.agentId, notice.last))) {
      this.sinks.log?.(`[tick] idle (restated) — ${notice.last}`);
      await this.sinks.addEvent(input.agentId, "warn", notice.last);
    }
  }

  /** Is the standing warning no longer what the owner's notice shows — and past its grace? */
  private async covered(agentId: string, standing: string): Promise<boolean> {
    let shown: ShownNotice | null | undefined;
    try {
      shown = await this.sinks.shownNotice(agentId);
    } catch {
      shown = undefined;
    }
    // Unread is not "nothing shows": a write on a guess is how a table fills
    // with the same line.
    if (shown === undefined) return false;
    if (shown === null) return true;
    if (shown.message === standing) return false;
    const now = this.sinks.now?.() ?? Date.now();
    return now - shown.atMs >= this.restateAfterMs;
  }
}

/**
 * THE CHANNEL THE TICK USES: the store's own writers, and the owner's notice
 * read by the desk's rule (store.ownerNotice). Bound here rather than in
 * main(), so the binding itself is run by a test — owner-notice.integration
 * drives this, on the real store — and not only read.
 */
export function idleChannelOnStore(log?: (line: string) => void): IdleChannel {
  return new IdleChannel({ addEvent, addDecision, newDecisionId, shownNotice: ownerNotice, log });
}
