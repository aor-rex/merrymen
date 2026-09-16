/**
 * WHICH LEG IS THE ASSET AND WHICH IS THE CASH — decided once, for every venue.
 *
 * This logic lived inline in the v4 arm only. The Rialto arm — a full, live
 * swap path that sends real calldata against a real router — set neither
 * `fillPair` nor `liveFill`, so a landed Rialto swap booked NO cost basis and
 * NO fill columns at all. A buy through it left nothing for a later sell to be
 * measured against, and a sell through it recorded no realised P&L, silently,
 * on a venue that otherwise worked.
 *
 * Extracted rather than copied. A second implementation of "which side is the
 * money" is how the two venues drift, and the failure mode is not a crash: it
 * is a 10^12 error from feeding an 18-decimal token amount into a 6-decimal
 * cash field, which reads as a plausible number.
 *
 * EXACTLY ONE LEG MUST BE CASH. A stock→stock swap has none, and booking one
 * anyway would be booking nonsense — so this returns null and the caller books
 * nothing, which is the honest outcome.
 */
export interface SwapFillLegs {
  /** The non-cash side, for the receipt decoder to attribute against. */
  fillPair: { stockToken: `0x${string}`; symbol: string; quotedOut: bigint; floorOut: bigint };
  /** The fill as the basis ledger takes it. */
  liveFill: { side: "buy" | "sell"; symbol: string; qtyRaw: bigint; cashUsdg: bigint; priceUsd: number };
}

export function swapFillLegs(args: {
  sellToken: `0x${string}`;
  buyToken: `0x${string}`;
  /** What the account is sending, raw, in the sell token's own decimals. */
  sellAmountRaw: bigint;
  /**
   * What it expects to receive, raw.
   *
   * THE CONSERVATIVE FIGURE where the venue offers one: a fill can come in
   * worse than quoted and never better, so a floor understates nothing. This is
   * a FALLBACK in any case — the receipt replaces it wherever one parses, and
   * booking the quote as though it were the fill is what once made every full
   * exit sell more than its basis knew about and write NULL realised P&L.
   */
  receivedRaw: bigint;
  /** What the venue quoted, for the receipt decoder's own comparison. */
  quotedOutRaw: bigint;
  /** The chain's cash token. */
  usdg: string;
  /** Address → symbol, or undefined when the token is not one we track. */
  symbolOf: (token: `0x${string}`) => string | undefined;
}): SwapFillLegs | null {
  const cash = args.usdg.toLowerCase();
  const sellIsUsdg = args.sellToken.toLowerCase() === cash;
  const buyIsUsdg = args.buyToken.toLowerCase() === cash;
  // Neither, or both: there is no cash leg to book against.
  if (sellIsUsdg === buyIsUsdg) return null;

  const stockToken = sellIsUsdg ? args.buyToken : args.sellToken;
  const symbol = args.symbolOf(stockToken);
  if (!symbol) return null;

  // Quantity is always the ASSET side; cash always the USDG side. Crossing them
  // is the 10^12 error above.
  const qtyRaw = sellIsUsdg ? args.receivedRaw : args.sellAmountRaw;
  const cashUsdg = sellIsUsdg ? args.sellAmountRaw : args.receivedRaw;
  if (qtyRaw <= 0n) return null;

  return {
    fillPair: { stockToken, symbol, quotedOut: args.quotedOutRaw, floorOut: args.receivedRaw },
    liveFill: {
      side: sellIsUsdg ? "buy" : "sell",
      symbol,
      qtyRaw,
      cashUsdg,
      priceUsd: Number(cashUsdg) / 1e6 / (Number(qtyRaw) / 1e18),
    },
  };
}
