/**
 * WHAT AN AGENT MAY SAY IN PUBLIC.
 *
 * This is the only gate between the decisions table and a page anybody can
 * read, and the decisions table was never built to be published. Three things
 * in it are actively unsafe, and none of them look it:
 *
 *   1. A `chat`-sourced reason embeds a RAW COUNTERPARTY ADDRESS by template —
 *      `owner asked to transfer 25 USDG to 0x… in chat` — unconditionally, on
 *      every chat transfer. Publishing one doxxes a third party and the amount.
 *
 *   2. The strategist is handed the whole signals snapshot — cash, vault,
 *      equity, every holding's dollar value — and its schema invites it to cite
 *      figures. A reason quoting the owner's balance sheet is within the design.
 *
 *   3. `dropped_rule` is a template with a MODEL-SUPPLIED HOLE in it:
 *      `#0 <symbol>: nothing held to sell`, where `<symbol>` is validated only
 *      as `typeof === "string"` — no length cap, no charset. It can never be
 *      published verbatim, at any length, however harmless it looks.
 *
 * SO THIS IS A WHITELIST, and it fails closed. A source nobody has classified
 * publishes nothing — not a redacted version, nothing. `SOURCE_POLICY` has no
 * fallthrough case by construction: an unknown key is `undefined`, and
 * `undefined` drops the row.
 *
 * WHY DROPPING RATHER THAN REDACTING. The address backstop below discards the
 * whole thesis rather than masking the match. Redaction implies we understood
 * the string well enough to know what was left; we don't, and a redactor that
 * is wrong once publishes the thing it was written to catch. Dropping is what
 * fail-closed actually means.
 *
 * WHAT IS NEVER HERE AT ALL. `signals_json` is not a field on the input type,
 * because the route does not select it. Not filtered — absent. That is a
 * stronger guarantee than any check in this file, and it is deliberate.
 *
 * PURE. No database, no fetch, no environment. It takes a row and returns a
 * post or null, so the whole policy is testable as a table.
 */

/** A joined decision + its outcome, exactly as the route selects it. */
export interface ThesisRow {
  agent_id?: string | null;
  name?: string | null;
  x_handle?: string | null;
  source?: string | null;
  action?: string | null;
  symbol?: string | null;
  size_usdg?: number | null;
  reason?: string | null;
  dropped_rule?: string | null;
  /** From the trade this decision caused, when there was one. */
  status?: string | null;
  reject_rule?: string | null;
  said?: number | null;
  last_at?: number | null;
  first_at?: number | null;
}

export interface PublicThesis {
  name: string;
  /** null when unset. Never "" and never "@unknown" — absent renders as nothing. */
  handle: string | null;
  /** "buy AAPL 16.66 USDG", or "" when the decision names nothing. */
  head: string;
  outcome: "landed" | "reverted" | "refused" | "dropped" | "pending";
  outcomeText: string;
  reason: string | null;
  /** How many times this exact thesis was said in the window. */
  said: number;
  /** Epoch seconds. Formatted by the page, so this module stays pure. */
  at: number;
  firstAt: number;
}

/**
 * The strategies whose reasons may be published.
 *
 * Every one of these emits a typed `Why` that `renderWhy` turns into a sentence,
 * so the words came from us. A tenant's own strategy file is deliberately absent
 * and can never be added by accident: it returns a bare intent array and has no
 * way to produce a reason at all.
 */
export const PUBLISHABLE_STRATEGIES = [
  "steady-basket",
  "weekend-gap",
  "even-keel",
  "dip-hunter",
  "trencher",
] as const;

/** How much of a row each source is trusted for. Absent key ⇒ publish nothing. */
const SOURCE_POLICY: Readonly<Record<string, "strategy" | "model">> = Object.freeze({
  // The model's own words. Capped and address-checked before they are shown.
  strategist: "model",
  ...Object.fromEntries(PUBLISHABLE_STRATEGIES.map((s) => [`strategy:${s}`, "strategy" as const])),
  // NOT here, and each for its own reason:
  //   chat     — carries a counterparty address by template
  //   selftest — a dust probe, not a market view; it says so itself
  //   strategy:<a tenant's own file> — a string we did not write
});

/**
 * Anything that looks like an on-chain identifier.
 *
 * `rh:` is included because the brokerage rail's agent id embeds an account
 * number, and a reason that quoted one would publish it.
 */
const ADDRESSY = /\b(?:0x[0-9a-fA-F]{6,}|rh:[A-Za-z0-9-]{1,64})\b/;

/** Matches the `/why` truncation point, so no surface cuts one mid-word. */
const REASON_MAX = 220;

/**
 * Why a proposal never reached the wall, said in our words.
 *
 * The clause after the first ": " in `dropped_rule` is author-written; the part
 * before it is not. So this matches the tail against a fixed list and returns a
 * sentence of our own — it never quotes, and it never echoes the figure in
 * "buy 50 USDG exceeds available cash", which would publish a bound on the
 * agent's cash.
 */
export function classifyDrop(dropped: string): string {
  const tail = dropped.includes(": ") ? dropped.slice(dropped.indexOf(": ") + 2) : dropped;
  if (/not in the tradable universe/i.test(tail)) return "it named something outside what it may trade";
  if (/exceeds available cash/i.test(tail)) return "it asked for more cash than it had";
  if (/token is paused/i.test(tail)) return "that token is paused";
  if (/nothing held to sell/i.test(tail)) return "there was nothing held to sell";
  if (/curve has graduated/i.test(tail)) return "that launch has graduated to a pool";
  if (/no slippage floor/i.test(tail)) return "no price floor could be derived, so it refused to size it blind";
  return "it talked itself out of it";
}

/** What the wall said, from the slug alone — the detail is never selected. */
export function outcomeOf(
  status: string | null | undefined,
  rejectRule: string | null | undefined,
): { outcome: PublicThesis["outcome"]; text: string } {
  if (status === "landed") return { outcome: "landed", text: "landed" };
  if (status === "paper") return { outcome: "landed", text: "filled on paper" };
  if (status === "reverted") return { outcome: "reverted", text: "reverted on-chain" };
  if (status === "submitted") return { outcome: "pending", text: "sent, waiting on the chain" };
  if (status !== "rejected") return { outcome: "pending", text: "no trade came of it" };

  // `reject_rule` is NOT a closed vocabulary — some paths write free-form text
  // into it — so anything unrecognised gets the generic sentence rather than
  // being echoed onto a public page.
  const R: Readonly<Record<string, string>> = Object.freeze({
    "per-trade-cap": "past the per-trade cap",
    "daily-cap": "past today's spending cap",
    "ops-cap": "past today's number of trades",
    "drawdown-breaker": "the drawdown breaker was tripped",
    "asset-allowlist": "that asset is not in its signed permissions",
    "target-allowlist": "that venue is not in its signed permissions",
    "transfer-recipient-allowlist": "that recipient is not in its signed permissions",
    "no-gas": "the account had no gas",
    "no-route": "no route to trade it",
    "no-quote": "no price could be quoted",
    "no-liquidity": "not enough liquidity to fill",
    slippage: "the price moved too far between quote and fill",
    "insufficient-balance": "it did not hold what it tried to spend",
    "curve-graduated": "that launch had already graduated",
    "curve-provenance": "the launch could not be verified",
  });
  const known = rejectRule ? R[rejectRule] : undefined;
  return { outcome: "refused", text: known ?? "the wall turned it back" };
}

/** "buy AAPL 16.66 USDG" — built structurally, never from prose. */
function headOf(row: ThesisRow): string {
  const size =
    typeof row.size_usdg === "number" && Number.isFinite(row.size_usdg)
      ? `${row.size_usdg.toFixed(2)} USDG`
      : null;
  return [row.action, row.symbol, size].filter(Boolean).join(" ");
}

/**
 * A row, turned into a post — or null, meaning it may not be published.
 *
 * Order matters: identity first, then source, then content. Each gate is
 * independent, so loosening the SQL later cannot loosen this.
 */
export function publishableThesis(row: ThesisRow): PublicThesis | null {
  // ── identity ──────────────────────────────────────────────────────────────
  // The brokerage rail's agent id embeds a real account number. It is excluded
  // here as well as in the SQL, because one of the two will be edited someday.
  if (row.agent_id && row.agent_id.toLowerCase().startsWith("rh:")) return null;
  const name = (row.name ?? "").trim();
  if (!name) return null;

  // ── source ────────────────────────────────────────────────────────────────
  const policy = row.source ? SOURCE_POLICY[row.source] : undefined;
  if (!policy) return null;

  // ── content ───────────────────────────────────────────────────────────────
  let reason: string | null = null;
  if (row.reason && row.reason.trim()) {
    // The model may omit the field, which arrives as "" rather than null. That
    // is expected, not exceptional: the post renders with its head and no
    // reasoning line, exactly as /why degrades.
    reason = policy === "model" ? row.reason.trim().slice(0, REASON_MAX) : row.reason.trim();
  } else if (row.dropped_rule) {
    reason = classifyDrop(row.dropped_rule);
  }

  const head = headOf(row);
  const { outcome, text } = row.dropped_rule && !row.status
    ? ({ outcome: "dropped", text: "dropped before it reached the wall" } as const)
    : outcomeOf(row.status, row.reject_rule);

  // A post with neither a head nor a reason says nothing at all.
  if (!head && !reason) return null;

  const handle = (row.x_handle ?? "").trim() || null;

  // ── the backstop ──────────────────────────────────────────────────────────
  // Last, and over everything that will be rendered — including the name and
  // the handle, which are user-typed. A strategy reason cannot contain an
  // address by construction; this exists so the guarantee does not depend on
  // that staying true.
  for (const s of [name, handle, head, reason, text]) {
    if (s && ADDRESSY.test(s)) return null;
  }

  return {
    name,
    handle,
    head,
    outcome,
    outcomeText: text,
    reason,
    said: Math.max(1, Number(row.said ?? 1)),
    at: Number(row.last_at ?? 0),
    firstAt: Number(row.first_at ?? row.last_at ?? 0),
  };
}
