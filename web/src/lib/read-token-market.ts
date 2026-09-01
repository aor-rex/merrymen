/**
 * WHAT THE MARKET SAYS ABOUT ONE TOKEN.
 *
 * Deliberately separate from read-token, which answers who HOLDS it. That file
 * reads the ledger; this one reads two indexes, and keeping them apart is what
 * lets the page render each half when only one of them answered.
 *
 * WHICH INDEX OWNS A TOKEN IS DECIDED OFFLINE. STOCK_TOKENS is a static list
 * compiled into the app, so "is this a Robinhood stock token" costs no request
 * and cannot fail. Everything else on this chain is a coin, and coins live in
 * the GeckoTerminal read.
 *
 * NEITHER READ IS MADE FOR THIS PAGE. The stock side is the same fetchMarket
 * the tape and /tokens already share; the coin side goes through the
 * single-flight memo in read-discoveries. A token page therefore adds no
 * upstream request at all, which is the only affordable shape on a chain
 * returning 429s to this fleet.
 *
 * THREE STATES, NOT TWO. "The index says nothing trades here" and "the index
 * could not be asked" are different facts, and rendering the second as the
 * first states something false while looking completely normal. `read` carries
 * the difference and the page is expected to branch on it.
 */
import { STOCK_TOKENS } from "@merrymen/core";
import { fetchMarket, type MarketToken } from "@/lib/market";
import { readPoolRow, sharedRead, type DiscoveryRow } from "@/lib/read-discoveries";

export interface TokenMarket {
  /** Decided from the static stock list, so this is never a guess. */
  kind: "stock" | "etf" | "memecoin";
  /**
   * found  — the index answered, and it described this token.
   * absent — the index answered, and this token was not in what it returned.
   * unread — the index could not be asked at all.
   *
   * "absent" IS DELIBERATELY NARROW. The pools we hold come from page one of
   * three feeds — roughly the top of the chain, not the index's whole
   * knowledge — so a token missing from them is not a token the index has
   * never heard of. Whatever the page says about this case must be a sentence
   * about those feeds, never about the index.
   */
  read: "found" | "absent" | "unread";
  /** Set only for a stock or ETF. Individual fields may still be null. */
  stock: MarketToken | null;
  /** Set only for a coin the index returned. */
  coin: DiscoveryRow | null;
  /**
   * This token's ticker also belongs to a LISTED stock token at another address.
   *
   * Both tickers are attacker-chosen: the index's label is a string the pool
   * carries, and the ledger's symbol comes from the contract's own symbol(),
   * which anyone deploying a token picks. Theses are matched to a page BY
   * SYMBOL, so without this flag an agent's real reasoning about NVDA would
   * print on an impostor's page, attributed to a holder of the impostor. That
   * is a per-agent attribution resting entirely on a string match, and it is
   * the one new false claim this page could otherwise manufacture.
   */
  symbolClash: boolean;
}

export async function readTokenMarket(
  token: string,
  /** The ledger's symbol for this token, when it has one. Used for the clash check. */
  symbol: string | null = null,
): Promise<TokenMarket> {
  const addr = token.toLowerCase();
  const listed = STOCK_TOKENS.find((t) => t.address.toLowerCase() === addr);

  // A listed token cannot impersonate itself, so the clash is only ever about
  // some OTHER address wearing a listed ticker.
  const symbolClash =
    !!symbol &&
    STOCK_TOKENS.some((s) => s.symbol === symbol && s.address.toLowerCase() !== addr);

  if (listed) {
    // fetchMarket returns a row for every listed token whether or not the
    // chain answered, with nulls where it did not — so the token is always
    // "found" here and the per-field nulls carry any failure. A stock with no
    // chainlinkFeed at all has no price by construction, not by outage.
    try {
      const market = await fetchMarket();
      const row = market.tokens.find((t) => t.address.toLowerCase() === addr) ?? null;
      return { kind: listed.kind, read: row ? "found" : "unread", stock: row, coin: null, symbolClash };
    } catch {
      return { kind: listed.kind, read: "unread", stock: null, coin: null, symbolClash };
    }
  }

  try {
    // readPoolRow, NOT payload.rows. The payload's rows are screened for a
    // discovery panel and drop everything under a display floor of $25k depth
    // and 100 buyers — which is most of what an agent actually holds. Asked
    // against those, this would report "no market data" for a coin the index
    // had just described in full.
    const row = await readPoolRow(addr);
    if (row) return { kind: "memecoin", read: "found", stock: null, coin: row, symbolClash };

    // Genuinely not among the pools the index returned. That is only an absence
    // if the index answered at all, which is the distinction this file exists
    // for.
    const payload = await sharedRead();
    return {
      kind: "memecoin",
      read: payload.indexUnreachable ? "unread" : "absent",
      stock: null,
      coin: null,
      symbolClash,
    };
  } catch {
    return { kind: "memecoin", read: "unread", stock: null, coin: null, symbolClash };
  }
}
