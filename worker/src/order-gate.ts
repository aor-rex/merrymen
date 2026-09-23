/**
 * AN OWNER'S OWN BUY OR SELL, AS THE PROCESS THAT HOLDS THE KEY JUDGES IT.
 *
 * WHY THE VALIDATION IS HERE AND NOT ONLY IN THE ROUTE. Between the route and
 * this code the order crossed a shared Postgres table, an orchestrator that can
 * see every tenant's home, and a JSON file. The route's check is the one that
 * gives the owner a good error; this one stands between a string and a signed
 * UserOperation, and it must hold even if every layer above it is wrong.
 *
 * LIFTED OUT OF main() SO IT RUNS UNDER A TEST. It lived inline in
 * runOrderCommand, where no test can reach, and was pinned by reading the
 * source — so deleting the refusal a between-tick order depends on (a book this
 * tick could not value) typechecked, passed every test, and would have filled
 * the order against the equity the PREVIOUS tick left behind. The gate owns
 * the submit call too, so "refused" provably means "nothing was sent".
 *
 * THE READS COME FIRST, and each refusal says it is a fact about the reads and
 * not about the order. The drawdown breaker judges an order against this
 * tick's equity, and checkPolicy SKIPS the breaker when equity is unknown — so
 * an order placed on a tick that could not read the market or the book, or
 * could not total it, is a trade with that guard silently off. A prompt no is
 * worth more than a late yes, and the owner can ask again in a minute.
 */

/**
 * What the tick that drains an order could read — handed to the drain whole.
 *
 * NONE OF IT IS DEFAULTED. The drain took these as positional booleans that
 * defaulted to false, so a drain site that dropped them still typechecked and
 * the order was judged against whatever the PREVIOUS tick left behind; and
 * `equityKnown` was read off a global beside them. Every drain site now builds
 * one of these with `tickReads` and passes it through, so stating nothing does
 * not compile and a hand-written literal is not the natural edit.
 */
export interface TickReads {
  /** The market could not be read this tick. */
  marketUnreadable: boolean;
  /** A balance could not be read, or a holding could not be priced, this tick. */
  bookUnreadable: boolean;
  /**
   * Whether the book could be totalled. False while something held has neither
   * a price nor a cost on record — the tick then skips equity, and checkPolicy
   * skips the drawdown breaker for every intent it judges.
   */
  equityKnown: boolean;
}

/** The three places a tick drains from, and what each of them has read. */
export const tickReads = {
  /** The market could not be read, so nothing downstream of it was either. */
  marketUnread: (): TickReads => ({ marketUnreadable: true, bookUnreadable: true, equityKnown: false }),
  /** The market was read and the book was not: a balance or a price failed. */
  bookUnread: (): TickReads => ({ marketUnreadable: false, bookUnreadable: true, equityKnown: false }),
  /** Both were read and equity composed; `equityKnown` is whether it could be totalled. */
  composed: (equityKnown: boolean): TickReads => ({ marketUnreadable: false, bookUnreadable: false, equityKnown }),
} as const;

/** What an order is judged against: the tick's reads, and the owner's own settings as they stand. */
export interface OrderReads extends TickReads {
  /** The owner has the agent paused. */
  paused: boolean;
  /** The owner's own ceiling on a typed order, in USDG. Zero means none is set. */
  ceilingUsdg: number;
}

export function orderReadsOf(tick: TickReads, owner: { paused: boolean; ceilingUsdg: number }): OrderReads {
  return {
    marketUnreadable: tick.marketUnreadable,
    bookUnreadable: tick.bookUnreadable,
    equityKnown: tick.equityKnown,
    paused: owner.paused,
    ceilingUsdg: owner.ceilingUsdg,
  };
}

type Side = "buy" | "sell";

/**
 * A BOOK THAT CANNOT BE TOTALLED CANNOT JUDGE A BUY. Equity is unknown, so
 * policy.ts runs the breaker only `if (state.equityKnown !== false)` — a buy
 * would go out with the loss limit switched off. A sell is an exit, which the
 * breaker exempts anyway, and refusing it would lock the owner into the very
 * holding that makes the book untotallable. Null when the order may go on.
 */
function untotalledBuy(side: Side, equityKnown: boolean): string | null {
  if (side !== "buy" || equityKnown) return null;
  return (
    "I did not place it: something you hold has no price and no cost on record, so I cannot total your " +
    "book, and without that the drawdown limit can't judge a buy. Selling still works."
  );
}

/**
 * THE GATE EVERY ORDER MEETS AT submitChatTrade — typed in Telegram, placed
 * from the app, or handed over by the Brain. Null when it may go on to the
 * wall; otherwise the sentence the owner reads, and nothing is built or sent.
 *
 * The untotalled-buy refusal lived only in placeOrder, which only an app order
 * reaches, so a buy typed in Telegram went out with equity unknown and the
 * breaker skipped. It is one rule, so it is one function, and both paths say
 * the same sentence.
 *
 * `equityUsdg` is the last tick's; 0n is its initialiser, before any tick has
 * read the book, when the drawdown check would judge garbage.
 */
export function chatOrderGate(side: Side, book: { equityUsdg: bigint; equityKnown: boolean }): string | null {
  if (book.equityUsdg === 0n) return "🐎 the band is still saddling up (first tick pending) — try again in a minute.";
  return untotalledBuy(side, book.equityKnown);
}

/**
 * Judge an order, and hand it to `submit` only if every gate passes.
 *
 * Returns `submit`'s reply untouched, or a refusal: `ok: false` with the
 * sentence the owner reads. A refusal never calls `submit`.
 */
export async function placeOrder<R>(
  args: Record<string, unknown> | undefined,
  reads: OrderReads,
  submit: (side: Side, symbol: string, size: number) => Promise<R>,
): Promise<R | { ok: false; line: string }> {
  const no = (line: string) => ({ ok: false as const, line });
  // ANSWERED, NOT STARVED. The tick's unreadable-market return sits a thousand
  // lines above the regular drain, so an order on such a tick used to be
  // skipped until it expired. It drains there now, with this flag set, and is
  // refused by name at once.
  if (reads.marketUnreadable) {
    return no(
      "I could not read the market this tick, so I did not place it — that is a fact about my reads, " +
        "not about your order. Ask again in a minute.",
    );
  }
  // THE BOOK, FOR THE SAME REASON. A tick that could not read a balance or price
  // a holding returns before equity is composed ("trading + equity paused"), so
  // the figure the breaker would judge this order against is exactly the one
  // missing.
  if (reads.bookUnreadable) {
    return no(
      "I could not value your book this tick, so I did not place it — that is a fact about my reads, " +
        "not about your order. Ask again in a minute.",
    );
  }
  // PAUSE IS HONOURED HERE, not at the drain. The drain runs above the tick's
  // own pause return, deliberately — a paused agent can still be probed. An
  // order is the opposite: pause is the owner's stop button, and a trade that
  // executes through it is the worst surprise this app could produce.
  if (reads.paused) return no("you have me paused, so I did not place it. Un-pause and ask again.");
  const a = args ?? {};
  const side: Side | null = a.side === "buy" || a.side === "sell" ? a.side : null;
  if (!side) return no(`'${String(a.side)}' is not a buy or a sell`);
  // A BOOK THAT CANNOT BE TOTALLED CANNOT JUDGE A BUY — the same rule, and the
  // same sentence, submitChatTrade's gate gives a Telegram order.
  const untotalled = untotalledBuy(side, reads.equityKnown);
  if (untotalled) return no(untotalled);
  // A SYMBOL IS A SHORT PLAIN TICKER OR IT IS NOTHING. It is resolved against
  // the watch set by the submitter, so this only has to stop the shapes that
  // have no business reaching a lookup at all.
  const symbol = typeof a.symbol === "string" ? a.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return no(`'${String(a.symbol)}' is not a symbol I can look up`);
  const size = typeof a.usdgAmount === "number" ? a.usdgAmount : Number(a.usdgAmount);
  // FINITE AND POSITIVE, SAID OUT LOUD. The wall refuses a non-positive swap by
  // name too — two gates, neither relying on the other — but NaN and Infinity
  // have to die before `usdg()` turns them into a BigInt throw.
  if (!Number.isFinite(size) || size <= 0) return no(`${String(a.usdgAmount)} is not an amount I can trade`);
  // THE OWNER'S OWN CEILING ON A TYPED ORDER. The sealed per-trade cap is a
  // wall; this is the owner's own smaller fence inside it.
  const ceiling = reads.ceilingUsdg;
  if (ceiling > 0 && size > ceiling) {
    return no(`${size} USDG is over your ${ceiling} USDG limit for a chat order. Raise it in Settings if you mean it.`);
  }
  return submit(side, symbol, size);
}
