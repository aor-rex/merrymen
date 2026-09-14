/**
 * WHAT A STALE HIGH-WATER MARK SHOULD BE, DERIVED — never assumed.
 *
 * The drawdown breaker divides by `agents.hwm_usdg`. When capital leaves an
 * account and nothing books the withdrawal, that peak keeps counting money that
 * went home, and the account is refused every buy forever on a drawdown it never
 * suffered. Shogun: peak 49.915968, equity 24.915968, 5008bps against a signed
 * 500bps cap, on a book that had never sold anything.
 *
 * THE ONE THING THIS MUST NOT DO IS ERASE A REAL LOSS. A tenant who lost money
 * AND withdrew has a genuine drawdown behind part of that gap, and the breaker
 * is doing its job for that part. So the peak is not set to equity, not set to
 * contributions, and not nudged until the refusal stops. It is DERIVED:
 *
 *     proposed peak = capital in − capital out + profit already ratcheted in
 *
 * Every term is evidence. `capital in` and `capital out` come from the chain,
 * classified by `classifyUsdgMovement` — so an account→vault transfer that
 * funded a buy is a trade, not a withdrawal, and a vault→account leg of a
 * recovery is not a deposit. `profit already ratcheted in` is Σ
 * `fee_accruals.profit_usdg`: the only durable record of the peak being raised
 * by performance rather than by capital. An agent that never made a profit has
 * no such rows, and for it the peak simply IS net contributions.
 *
 * A tenant with real trading losses lands on a proposed peak equal to what they
 * put in, equity below it, and their drawdown intact — which is the whole point.
 *
 * TWO CLAMPS, both protective, both reported when they fire:
 *   • never raise a peak. Raising one widens a drawdown and can halt a healthy
 *     account; a repair that can do that is not a repair.
 *   • never propose below current equity. That would hand the difference to
 *     `accrueAboveHwm` as profit and charge a performance fee on the owner's own
 *     money, which is the failure the accounting anchor exists to prevent.
 *
 * AND IT REFUSES. An unclassifiable movement, an incomplete scan, or a swept
 * position whose basis nobody knows all mean the derivation rests on a guess.
 * `capital-classify.ts` says this outright about its own `ambiguous` arm — "a
 * repair tool is expected to refuse these rather than guess" — and this is that
 * tool. A refusal is reported per tenant with the reason, never rounded away.
 *
 * PURE. Given facts, returns a plan. Nothing here reads a chain or a database,
 * so every rule above is testable against hand-built numbers.
 */

/** Everything the plan is derived from, per tenant. Each null is "not known". */
export interface TenantCapitalFacts {
  tenant: string;
  smartAccount: string;
  name: string | null;
  /** The engine's own newest equity mark. Null when it has never published one. */
  equityUsdg: number | null;
  /** The EFFECTIVE peak the breaker divides by (gross − withdrawn). */
  currentHwmUsdg: number | null;
  /** The owner's own signed ceiling, from `grant.caps.maxDrawdownPct`. */
  maxDrawdownBps: number | null;

  /** Σ external capital into the managed system (account ∪ class vault). */
  depositsUsdg: number | null;
  /** Σ external capital out of it — to the owner, or anywhere outside. */
  withdrawalsUsdg: number | null;
  /** account↔vault legs and the like. Counted, never totalled: they are not capital. */
  internalMoves: number;
  /** Swap legs. Counted for the same reason. */
  tradeLegs: number;
  /** Movements the classifier refused to decide. Any at all blocks a proposal. */
  ambiguousMoves: number;

  /**
   * Non-USDG capital the owner took home, valued at COST.
   *
   * A swept class position leaves as tokens, so no USDG log names it and the
   * flow classifier is blind to it by construction. Cost is the only figure
   * this book can honestly say left with it — a curve mark has no oracle behind
   * it and would be an invented number in the figure the fee is measured
   * against.
   */
  sweptAtCostUsdg: number | null;
  /** Swept positions whose basis is unknown. Unpriceable, so unproposable. */
  sweptUnpriceable: number;

  /** Σ `fee_accruals.profit_usdg` — the peak's performance component. */
  ratchetedProfitUsdg: number | null;

  /** False when the chain could not be read end to end. Blocks a proposal. */
  scanComplete: boolean;
  /** Why the scan is incomplete, or any other caveat worth printing. */
  scanNote: string | null;
}

export interface HwmRepairPlan {
  facts: TenantCapitalFacts;
  /** What the breaker reads today. Null when equity or the peak is unknown. */
  currentDrawdownBps: number | null;
  /** Would the breaker refuse a buy right now? */
  refusingNow: boolean;
  /** Net capital still under management: deposits − withdrawals − swept-at-cost. */
  netContributionsUsdg: number | null;
  /** The derived peak, before the clamps. */
  derivedHwmUsdg: number | null;
  /** What this proposes to write. Null when it refuses. */
  proposedHwmUsdg: number | null;
  /** proposed − current. Never positive: this only ever lowers a peak. */
  deltaUsdg: number | null;
  /** What the breaker would read afterwards. */
  proposedDrawdownBps: number | null;
  /** True when no write is proposed, whatever the reason. */
  ambiguous: boolean;
  /** One sentence an operator decides on. Always populated. */
  reason: string;
}

const bps = (hwm: number, equity: number): number =>
  hwm <= 0 ? 0 : Math.max(0, Math.floor(((hwm - equity) / hwm) * 10_000));

/**
 * Round to the smallest unit USDG actually has.
 *
 * These figures arrive as doubles out of a REAL column and a sum of them drifts:
 * 55.701312 − 25.785344 − 5 is 24.915968000000003 in IEEE-754. A sixth-decimal
 * unit is the finest amount that can exist, so anything past it is noise from
 * the representation — and it is not harmless noise, because `derived >=
 * currentHwm` decides whether a peak is corrected at all and a hair either side
 * flips it.
 *
 * Rounded rather than truncated: the drift goes both ways, and truncation would
 * bias every derived figure downward by up to a micro, which is a (tiny) bias in
 * the direction of charging a fee.
 */
const micro = (n: number): number => Math.round(n * 1e6) / 1e6;

const f = (n: number): string => n.toFixed(6);

/** Derive one tenant's plan. PURE. */
export function planHwmRepair(facts: TenantCapitalFacts): HwmRepairPlan {
  const base = {
    facts,
    currentDrawdownBps:
      facts.currentHwmUsdg === null || facts.equityUsdg === null
        ? null
        : bps(facts.currentHwmUsdg, facts.equityUsdg),
    refusingNow: false,
    netContributionsUsdg: null as number | null,
    derivedHwmUsdg: null as number | null,
    proposedHwmUsdg: null as number | null,
    deltaUsdg: null as number | null,
    proposedDrawdownBps: null as number | null,
    ambiguous: true,
  };
  base.refusingNow =
    base.currentDrawdownBps !== null &&
    facts.maxDrawdownBps !== null &&
    base.currentDrawdownBps >= facts.maxDrawdownBps;

  // ── the refusals, each naming what is missing ─────────────────────────────
  if (facts.currentHwmUsdg === null) {
    return { ...base, reason: "the durable peak could not be read — nothing to correct against" };
  }
  if (facts.equityUsdg === null) {
    return {
      ...base,
      reason:
        "no equity mark on record, so there is no way to check a proposal against what the account is " +
        "actually worth",
    };
  }
  if (!facts.scanComplete) {
    return {
      ...base,
      reason: `the chain scan did not cover this account's whole history${facts.scanNote ? ` — ${facts.scanNote}` : ""}`,
    };
  }
  if (facts.depositsUsdg === null || facts.withdrawalsUsdg === null) {
    return { ...base, reason: "capital totals could not be derived from the chain" };
  }
  if (facts.ambiguousMoves > 0) {
    return {
      ...base,
      reason:
        `${facts.ambiguousMoves} USDG movement(s) could not be classified as capital or as a trade. ` +
        `Counting them either way changes the peak, so nothing is proposed`,
    };
  }
  if (facts.sweptUnpriceable > 0) {
    return {
      ...base,
      reason:
        `${facts.sweptUnpriceable} position(s) were swept out of the class vault with no cost basis on ` +
        `record. The withdrawal is real and its size is unknown, and guessing it would move the figure ` +
        `the performance fee is measured against`,
    };
  }
  if (facts.ratchetedProfitUsdg === null) {
    return {
      ...base,
      reason:
        "the performance component of the peak could not be read, so contributed capital cannot be " +
        "separated from profit already earned on it",
    };
  }

  // ── the derivation ────────────────────────────────────────────────────────
  const swept = facts.sweptAtCostUsdg ?? 0;
  const net = micro(facts.depositsUsdg - facts.withdrawalsUsdg - swept);
  const derived = micro(net + facts.ratchetedProfitUsdg);
  const out = { ...base, netContributionsUsdg: net, derivedHwmUsdg: derived };

  if (derived < 0) {
    return {
      ...out,
      reason:
        `the derivation gives a negative peak (${f(derived)} USDG) — more capital left than the chain ` +
        `shows arriving, which means the movements behind it are not all understood`,
    };
  }

  // NEVER RAISE. A higher peak widens the drawdown and can halt an account that
  // is trading perfectly well. This tool exists to lift a refusal that should
  // never have happened, not to create one.
  if (derived >= facts.currentHwmUsdg) {
    return {
      ...out,
      proposedHwmUsdg: facts.currentHwmUsdg,
      deltaUsdg: 0,
      proposedDrawdownBps: base.currentDrawdownBps,
      ambiguous: false,
      reason:
        `no change — the recorded peak (${f(facts.currentHwmUsdg)}) is already at or below the capital ` +
        `behind it (${f(derived)}), so any drawdown here is real`,
    };
  }

  // NEVER BELOW EQUITY. The difference would be handed to accrueAboveHwm as
  // profit on the next tick and charged a performance fee — on the owner's own
  // money. Reported when it fires, because it means the derivation and the
  // balance disagree and somebody should know which.
  const clamped = micro(Math.max(derived, facts.equityUsdg));
  const clampNote =
    clamped > derived
      ? ` (raised from the derived ${f(derived)} to current equity so the next tick cannot book the ` +
        `difference as profit and charge a fee on it)`
      : "";

  const proposed = micro(Math.min(clamped, facts.currentHwmUsdg));
  return {
    ...out,
    proposedHwmUsdg: proposed,
    deltaUsdg: micro(proposed - facts.currentHwmUsdg),
    proposedDrawdownBps: bps(proposed, facts.equityUsdg),
    ambiguous: false,
    reason:
      `${f(facts.depositsUsdg)} in − ${f(facts.withdrawalsUsdg)} out` +
      (swept > 0 ? ` − ${f(swept)} swept out at cost` : "") +
      (facts.ratchetedProfitUsdg > 0 ? ` + ${f(facts.ratchetedProfitUsdg)} profit already in the peak` : "") +
      ` = ${f(proposed)}${clampNote}`,
  };
}

/** The report, as lines an operator decides on. Every tenant, affected or not. */
export function repairLines(plans: readonly HwmRepairPlan[]): string[] {
  const L: string[] = [];
  const affected = plans.filter((p) => !p.ambiguous && (p.deltaUsdg ?? 0) < 0);
  const ambiguous = plans.filter((p) => p.ambiguous);
  const refusing = plans.filter((p) => p.refusingNow);

  L.push(
    `HWM REPAIR — REPORT ONLY. ${plans.length} tenant(s) examined · ${affected.length} would change · ` +
      `${ambiguous.length} ambiguous · ${refusing.length} currently refused by the breaker`,
  );
  L.push("");

  for (const p of plans) {
    const x = p.facts;
    L.push(`── ${x.tenant}${x.name ? `  (${x.name})` : ""}`);
    L.push(`   account ${x.smartAccount}`);
    L.push(
      `   equity ${x.equityUsdg === null ? "UNKNOWN" : f(x.equityUsdg)}   ` +
        `hwm ${x.currentHwmUsdg === null ? "UNKNOWN" : f(x.currentHwmUsdg)}   ` +
        `cap ${x.maxDrawdownBps ?? "UNKNOWN"}bps   ` +
        `breaker reads ${p.currentDrawdownBps ?? "UNKNOWN"}bps${p.refusingNow ? "  ← REFUSING EVERY BUY" : ""}`,
    );
    L.push(
      `   chain: deposits ${x.depositsUsdg === null ? "UNKNOWN" : f(x.depositsUsdg)} · ` +
        `withdrawals ${x.withdrawalsUsdg === null ? "UNKNOWN" : f(x.withdrawalsUsdg)} · ` +
        `swept out at cost ${x.sweptAtCostUsdg === null ? "UNKNOWN" : f(x.sweptAtCostUsdg)}`,
    );
    L.push(
      `   ignored: ${x.internalMoves} internal custody move(s) · ${x.tradeLegs} trade leg(s)` +
        `${x.ambiguousMoves > 0 ? ` · ${x.ambiguousMoves} UNCLASSIFIABLE` : ""}`,
    );
    L.push(
      `   profit already in the peak ${x.ratchetedProfitUsdg === null ? "UNKNOWN" : f(x.ratchetedProfitUsdg)}   ` +
        `net contributions ${p.netContributionsUsdg === null ? "UNKNOWN" : f(p.netContributionsUsdg)}`,
    );
    if (p.ambiguous) {
      L.push(`   AMBIGUOUS — no change proposed`);
    } else if ((p.deltaUsdg ?? 0) === 0) {
      L.push(`   no change`);
    } else {
      L.push(
        `   PROPOSE hwm ${f(x.currentHwmUsdg!)} → ${f(p.proposedHwmUsdg!)}  (${f(p.deltaUsdg!)})   ` +
          `breaker ${p.currentDrawdownBps}bps → ${p.proposedDrawdownBps}bps`,
      );
    }
    L.push(`   why: ${p.reason}`);
    if (x.scanNote && x.scanComplete) L.push(`   note: ${x.scanNote}`);
    L.push("");
  }

  L.push(
    `TOTALS — would change ${affected.length} · ambiguous ${ambiguous.length} · ` +
      `unchanged ${plans.length - affected.length - ambiguous.length}`,
  );
  L.push("NOTHING WAS WRITTEN. This is the report; the apply pass is a separate, explicit run.");
  return L;
}
