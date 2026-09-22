/**
 * THE AGENT ACCOUNT'S CHAIN BALANCES, AS READ — AND NULL WHERE THEY WERE NOT.
 *
 * /api/grants used to finish every failed read with `0n`: `getBalance` caught
 * to zero, and a multicall that threw, or one entry in it that failed, fell back
 * to zero too. So a slow node reported a funded account as empty, and the shell
 * did exactly what it should with an empty account — `autonomyOf` answered
 * `realCashUsd === 0` with "Add funds". An owner holding real money was told to
 * deposit because our read did not come back.
 *
 * NULL IS THE ANSWER WE HAVE when a read fails, and it is carried field by
 * field: one entry failing inside a multicall that otherwise answered is still
 * one unknown and one fact. A measured zero stays "0" — that is the one case
 * where "Add funds" is true.
 *
 * STILL DECIMAL STRINGS, and still the same three keys, so nothing that parsed
 * the old shape breaks. Every reader of these on the web side already
 * coalesces a missing value (`?? 0`, `if (!v)`); the Android client does not
 * read `balances` at all, and no other client calls GET /api/grants.
 */
export interface GrantBalances {
  ethWei: string | null;
  cashUsdg: string | null;
  vaultUsdg: string | null;
}

/** One multicall entry, in the shape viem returns with `allowFailure` on. */
type Settled = { status: "success" | "failure"; result?: unknown };

/** A bigint the chain actually returned, as a decimal string — or null. */
const amount = (v: unknown): string | null => (typeof v === "bigint" ? v.toString() : null);

/**
 * `eth` reads the native balance; `tokens` is the [cash, vault] balanceOf
 * batch. Passed as thunks so the route keeps its own viem calls and transport
 * (chain-read.test.ts pins those), and this keeps only the question of what a
 * failure means.
 */
export async function readGrantBalances(read: {
  eth: () => Promise<bigint>;
  tokens: () => Promise<readonly Settled[]>;
}): Promise<GrantBalances> {
  const [eth, tokens] = await Promise.all([
    read.eth().then(amount, () => null),
    read.tokens().catch(() => null),
  ]);
  const entry = (i: number): string | null =>
    tokens?.[i]?.status === "success" ? amount(tokens[i]!.result) : null;
  return { ethWei: eth, cashUsdg: entry(0), vaultUsdg: entry(1) };
}
