/**
 * THE NAME A DECISION ABOUT A COIN IS WRITTEN WITH — AND WHERE IT COMES FROM
 * WHEN THE TAPE HAS FORGOTTEN THE COIN AND A REDEPLOY HAS WIPED THE LEDGER.
 *
 * An autonomous Trencher symbol is address-derived (`T` plus eleven hex), and a
 * feed that prints only that says "sell TA151B4A9E1B 5.01 USDG" at a reader.
 * The name rides alongside it, display only, and this decides it:
 *
 *   1. THE TAPE'S, when the watch set still labels the coin (coinDisplayName).
 *      A held coin drops off the tape's qualified list, and discovery then
 *      labels it with its own id.
 *   2. THIS AGENT'S OWN LEDGER, the name its buy was written with
 *      (store.displayNameFor) — the child's sqlite, which every redeploy wipes.
 *   3. THE COIN'S OWN CONTRACT, which no redeploy touches (ChainCoinNames).
 *
 * Without the third, a coin bought before the latest deploy — the default
 * Trencher holds for up to three days — had every exit and review written
 * unnamed, and the reader's fallback, which looks only inside its own window,
 * could not recover a name that old.
 */
import type { StockToken } from "../../packages/core/src/index";
import { coinDisplayName } from "./coin-name";

/**
 * WHAT A COIN'S OWN CONTRACT CALLS IT, read once per coin per process.
 *
 * `symbol()` is text the deployer chose and can change, which is exactly why
 * it is never the coin's IDENTITY here (see coin-name.ts). As a display name
 * it is the same word the tape showed: a GeckoTerminal pool label is built
 * from it ("CASHCAT / WETH 1%"). And unlike the tape and the child's ledger,
 * the chain is still there after a redeploy.
 *
 * NEVER ON THE CRITICAL PATH FOR LONG. The read is raced against `timeoutMs`,
 * so a decision waits at most that long, once per coin; an answer that arrives
 * late is still kept for the next decision. A failed read is remembered for
 * `retryMs` so a dead RPC is asked once per window, not once per decision.
 * Sanitised by the same rule as the tape's label: an address-shaped or
 * unreadable answer is no name, never a placeholder.
 */
export class ChainCoinNames {
  private readonly known = new Map<string, string | null>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly failedAt = new Map<string, number>();
  private readonly timeoutMs: number;
  private readonly retryMs: number;
  private readonly now: () => number;

  constructor(
    private readonly readSymbol: (address: `0x${string}`) => Promise<unknown>,
    opts: { timeoutMs?: number; retryMs?: number; now?: () => number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 1_500;
    this.retryMs = opts.retryMs ?? 5 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  async nameOf(token: StockToken): Promise<string | null> {
    // A stock is already named by its ticker; only an address-derived id needs
    // a word, and coinDisplayName answers null for anything else anyway.
    if (token.kind !== "memecoin") return null;
    const key = token.address.toLowerCase();
    if (this.known.has(key)) return this.known.get(key) ?? null;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && this.now() - failed < this.retryMs) return null;
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.readSymbol(token.address).then(
        (raw) => {
          const name = coinDisplayName({ symbol: token.symbol, name: typeof raw === "string" ? raw : "", kind: "memecoin" });
          this.known.set(key, name);
          this.failedAt.delete(key);
          return name;
        },
        () => {
          this.failedAt.set(key, this.now());
          return null;
        },
      );
      const settled = pending.finally(() => this.inflight.delete(key));
      this.inflight.set(key, settled);
      pending = settled;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
    });
    return Promise.race([pending, late]).finally(() => clearTimeout(timer));
  }
}

/** The ledger step: store.displayNameFor's signature, so the real one plugs in. */
export type LedgerName = (
  agentId: string,
  symbol: string,
  fromTape: string | null,
  fromChain?: () => Promise<string | null>,
) => Promise<string | null>;

/**
 * One resolver for every decision-writing call site in the tick, so the exit,
 * the Trencher review and the Brain review cannot each ask a different
 * question. Never throws: a name is display only, and no lookup here may cost
 * a trade.
 *
 * The chain is asked only through the ledger step, which asks it only for an
 * address-derived id and only after its own miss — one rule, in store.ts.
 */
export function makeDecisionNamer(deps: {
  /** The watch set as it stands now — re-read on every call. */
  watchTokens: () => readonly StockToken[];
  ledger: LedgerName;
  chain: ChainCoinNames;
}): (agentId: string, symbol: string) => Promise<string | null> {
  return async (agentId, symbol) => {
    try {
      const token = deps.watchTokens().find((t) => t.symbol === symbol);
      return await deps.ledger(agentId, symbol, coinDisplayName(token), token ? () => deps.chain.nameOf(token) : undefined);
    } catch {
      return null;
    }
  };
}
