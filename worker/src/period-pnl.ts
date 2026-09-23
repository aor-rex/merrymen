/**
 * WHAT MOVED AN ACCOUNT'S VALUE OVER A PERIOD: MONEY IN OR OUT, TRADING AND
 * PRICE MOVES — OR SOMETHING THE RECORDS CANNOT EXPLAIN.
 *
 * The chat used to answer "how did I do today" as (latest value − opening
 * value − every flow since), which is right only while the records are
 * complete. They are not across a hosted redeploy: a deposit made while the
 * agent was down is booked by nobody, and an old incarnation could book the
 * opening balance again as a flow at its restart. Either way the difference
 * landed in "trading", as a gain or a loss the agent never made.
 *
 * So the change is attributed STEP BY STEP, between consecutive account-value
 * marks of one book (practice and real money are different money), from what
 * each step's cash did:
 *
 *   - a trade in the step explains any cash move: its flows are money in or
 *     out, the rest is trading;
 *   - cash that moved by exactly the recorded flows: they are money in or out;
 *   - cash that moved by exactly the EVIDENCED flows (a chain log, an epoch
 *     carry): those count, and a flow nobody saw the balance make — a
 *     re-booked opening balance — does not;
 *   - otherwise nothing explains it, and the step's whole change is
 *     UNATTRIBUTED: reported as such, never as trading.
 *
 * Windows follow the tick's order — balances read, flows booked, mark written,
 * then trades — so a step's flows are those in (prev, cur] and its trades
 * those in [prev, cur).
 *
 * Pure: no ledger, no clock. The orchestrator runs it over the shared ledger,
 * telegram/chat-tools.ts over the child's own and across the seam between.
 */

/** A cash move smaller than this is rounding, not money (the child's MATERIAL_DRIFT_USDG). */
export const RECONCILE_TOLERANCE_USDG = 0.01;

export interface BookMark {
  at: number;
  equity: number;
  cash: number;
}

export interface BookFlow {
  at: number;
  /** Positive in, negative out. */
  signed: number;
  /** Chain-log or epoch-carry (packages/core isEvidencedFlow). */
  evidenced: boolean;
}

export interface Attribution {
  /** Money put in (+) or taken out (−). */
  flows: number;
  /** Change no record explains — never counted as trading. */
  unattributed: number;
}

/** One step's attribution. */
export function stepAttribution(prev: BookMark, cur: BookMark, flows: readonly BookFlow[], traded: boolean): Attribution {
  let fe = 0;
  let fu = 0;
  for (const f of flows) {
    if (f.evidenced) fe += f.signed;
    else fu += f.signed;
  }
  if (traded) return { flows: fe + fu, unattributed: 0 };
  const dC = cur.cash - prev.cash;
  if (Math.abs(dC - fe - fu) < RECONCILE_TOLERANCE_USDG) return { flows: fe + fu, unattributed: 0 };
  if (Math.abs(dC - fe) < RECONCILE_TOLERANCE_USDG) return { flows: fe, unattributed: 0 };
  return { flows: fe, unattributed: cur.equity - prev.equity - fe };
}

/**
 * Running attribution over one book's marks (ascending by time): entry i is
 * `start` plus every step up to mark i, so any period is a difference of two
 * entries. Flows at or before the first mark, and trades before it, belong to
 * whatever came before and are skipped.
 */
export function attributeBook(
  marks: readonly BookMark[],
  flows: readonly BookFlow[],
  tradeTimes: readonly number[],
  start: Attribution = { flows: 0, unattributed: 0 },
): Attribution[] {
  if (!marks.length) return [];
  const fl = [...flows].sort((a, b) => a.at - b.at);
  const tt = [...tradeTimes].sort((a, b) => a - b);
  const out: Attribution[] = [{ ...start }];
  let fi = 0;
  let ti = 0;
  while (fi < fl.length && fl[fi]!.at <= marks[0]!.at) fi++;
  while (ti < tt.length && tt[ti]! < marks[0]!.at) ti++;
  for (let i = 1; i < marks.length; i++) {
    const cur = marks[i]!;
    const inStep: BookFlow[] = [];
    while (fi < fl.length && fl[fi]!.at <= cur.at) inStep.push(fl[fi++]!);
    let traded = false;
    while (ti < tt.length && tt[ti]! < cur.at) {
      traded = true;
      ti++;
    }
    const s = stepAttribution(marks[i - 1]!, cur, inStep, traded);
    const p = out[i - 1]!;
    out.push({ flows: p.flows + s.flows, unattributed: p.unattributed + s.unattributed });
  }
  return out;
}

/** A book: marks in one mode. NULL (a mark from before modes were recorded) is its own. */
export type BookKey = "paper" | "live" | "unknown";

export function bookOf(mode: string | null | undefined): BookKey {
  return mode === "paper" ? "paper" : mode === "live" ? "live" : "unknown";
}

/** A mark with its book and running attribution. */
export interface AccountPoint extends BookMark, Attribution {
  book: BookKey;
  /** From before the last restart (the shared ledger), not this ledger. */
  carried: boolean;
}

/** Flows after a book's last carried mark, up to when the carried record was taken. */
export interface CarriedTail {
  book: BookKey;
  evidenced: number;
  unevidenced: number;
}

export interface SeriesInput {
  /** Points from before the restart, with running attribution already applied by the orchestrator. */
  carried: readonly Omit<AccountPoint, "carried">[];
  carriedTail: readonly CarriedTail[];
  /** This ledger's marks, flows and trade times (restart copies excluded). */
  local: readonly (BookMark & { book: BookKey })[];
  localFlows: readonly BookFlow[];
  /** Trade times by book: practice fills for the practice book, landed or submitted for the others. */
  tradeTimes: { paper: readonly number[]; live: readonly number[] };
}

/**
 * Every point of every book, ascending, with one running attribution per book
 * that crosses the restart: carried points as the shared ledger computed them,
 * then the SEAM — the step from the last carried mark to this ledger's first,
 * across the downtime — then this ledger's own steps.
 *
 * Practice books take no flows: practice cash is simulated, and flows are
 * real money.
 */
export function accountSeries(s: SeriesInput): AccountPoint[] {
  const out: AccountPoint[] = [];
  for (const book of ["paper", "live", "unknown"] as const) {
    const P = s.carried.filter((p) => p.book === book).sort((a, b) => a.at - b.at);
    const L = s.local.filter((m) => m.book === book).sort((a, b) => a.at - b.at);
    const flows = book === "paper" ? [] : s.localFlows;
    const trades = book === "paper" ? s.tradeTimes.paper : s.tradeTimes.live;
    for (const p of P) out.push({ ...p, carried: true });
    if (!L.length) continue;
    let start: Attribution = { flows: 0, unattributed: 0 };
    const last = P[P.length - 1];
    if (last) {
      const first = L[0]!;
      const tail = book === "paper" ? undefined : s.carriedTail.find((t) => t.book === book);
      const seamFlows: BookFlow[] = [
        ...(tail && tail.evidenced ? [{ at: first.at, signed: tail.evidenced, evidenced: true }] : []),
        ...(tail && tail.unevidenced ? [{ at: first.at, signed: tail.unevidenced, evidenced: false }] : []),
        ...flows.filter((f) => f.at > last.at && f.at <= first.at),
      ];
      const traded = trades.some((t) => t >= last.at && t < first.at);
      const seam = stepAttribution(last, first, seamFlows, traded);
      start = { flows: last.flows + seam.flows, unattributed: last.unattributed + seam.unattributed };
    }
    const cum = attributeBook(L, flows, trades, start);
    L.forEach((m, i) => out.push({ at: m.at, equity: m.equity, cash: m.cash, book, ...cum[i]!, carried: false }));
  }
  // Carried points are all older than this ledger's (it was born after they
  // were read), so time alone orders them; the sort is stable within a second.
  return out.sort((a, b) => a.at - b.at);
}

export type PeriodChange =
  | { kind: "none" }
  | { kind: "switched"; open: AccountPoint; close: AccountPoint }
  | { kind: "change"; open: AccountPoint; close: AccountPoint; change: number; flows: number; unattributed: number; trading: number };

/**
 * The change over a period starting at `since`: from the last point at or
 * before it (else the first after it) to the newest. Different books cannot be
 * compared, so a switch between practice and real money says so.
 */
export function periodChange(series: readonly AccountPoint[], since: number): PeriodChange {
  if (!series.length) return { kind: "none" };
  let open: AccountPoint | undefined;
  for (const p of series) if (p.at <= since) open = p;
  open ??= series.find((p) => p.at >= since);
  const close = series[series.length - 1]!;
  if (!open) return { kind: "none" };
  if (open.book !== close.book) return { kind: "switched", open, close };
  const change = close.equity - open.equity;
  const flows = close.flows - open.flows;
  const unattributed = close.unattributed - open.unattributed;
  return { kind: "change", open, close, change, flows, unattributed, trading: change - flows - unattributed };
}
