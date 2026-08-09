/**
 * A tiny Robinhood Chain reader for the browser — no dependency, no backend.
 *
 * The whole claim merrymen makes is "you don't have to trust us", so a page that
 * proxied this through a server of ours would be asking for exactly the trust
 * the project says you shouldn't extend. Everything here reads the chain's OWN
 * public infrastructure — the Blockscout explorer for history and the public RPC
 * for liveness — both of which serve `access-control-allow-origin: *`. There is
 * no key to leak and no server of ours in the path. Open the network tab and
 * every request is to a host you can verify independently.
 *
 * HISTORY COMES FROM THE EXPLORER, NOT FROM RAW LOGS. The first version of this
 * scanned `eth_getLogs` and halved the range whenever the node refused. On a
 * chain producing a block every 0.1s with ~12 transfers in each, a one-hour
 * window for an active account needed six levels of splitting — up to 128
 * requests for a single page load, which the browser simply refused. Blockscout
 * answers the same question in one request, with symbol, decimals and timestamp
 * already resolved. Fewer moving parts and a far better answer.
 */

export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
export const CHAIN_ID = 4663;

export interface TokenMeta {
  symbol: string;
  decimals: number;
}

/** One token movement in or out of the watched account. */
export interface Leg {
  token: string;
  amount: bigint;
  meta: TokenMeta;
}

/** One transaction, read as a trade: what left the account and what arrived. */
export interface Trade {
  txHash: string;
  timestamp: number | null;
  out: Leg[];
  in: Leg[];
}

export function isAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(v.trim());
}

/**
 * A token's own name, made safe to render.
 *
 * Mirrors sanitizeSymbol in the worker and the gateway. A symbol is whatever an
 * anonymous deployer wrote into their contract, and the explorer passes it
 * through verbatim, so it reaches the DOM stripped to a known alphabet and
 * length-capped. React escapes HTML on its own — what stripping adds is removing
 * the right-to-left overrides and zero-width joiners that let a token render as
 * a convincing copy of a different one.
 */
export function sanitizeSymbol(raw: unknown): string {
  if (typeof raw !== "string") return "?";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 16);
  return cleaned.length > 0 ? cleaned : "?";
}

export function formatAmount(amount: bigint, decimals: number): string {
  const base = 10n ** BigInt(Math.max(0, Math.min(36, decimals)));
  const whole = amount / base;
  const frac = amount % base;
  if (frac === 0n) return whole.toLocaleString();
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 6).replace(/0+$/, "");
  // Below a millionth of a unit renders as "0" and reads like a bug.
  if (whole === 0n && fracStr === "") return "<0.000001";
  return `${whole.toLocaleString()}${fracStr ? `.${fracStr}` : ""}`;
}

export function ageOf(seconds: number): string {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/** Current block height — one cheap call, purely so the page can prove it's live. */
export async function headBlock(): Promise<number> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "rpc error");
  return Number(BigInt(json.result));
}

interface BsTransfer {
  transaction_hash?: string;
  tx_hash?: string;
  timestamp?: string;
  from?: { hash?: string };
  to?: { hash?: string };
  token?: { address?: string; address_hash?: string; symbol?: string; decimals?: string | number };
  total?: { value?: string; decimals?: string | number };
}

/**
 * ERC-20 transfers touching `account`, newest first, grouped into trades.
 *
 * A swap is not a transfer — it's a matched pair of them inside one
 * transaction. Grouping by transaction is what turns a raw ledger into
 * "sold 100 USDG, bought 4,200 PEPE", and it's also what makes a multi-hop
 * route read as the single trade it actually was rather than three.
 */
export async function fetchTrades(account: string, signal?: AbortSignal): Promise<Trade[]> {
  const url = `${EXPLORER}/api/v2/addresses/${account}/token-transfers?type=ERC-20`;
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`explorer ${res.status}`);
  const json = (await res.json()) as { items?: BsTransfer[] };
  const items = Array.isArray(json.items) ? json.items : [];
  const me = account.toLowerCase();

  const byTx = new Map<string, { ts: number | null; out: Map<string, Leg>; in: Map<string, Leg> }>();

  for (const it of items) {
    const txHash = it.transaction_hash || it.tx_hash;
    if (!txHash) continue;
    const token = (it.token?.address || it.token?.address_hash || "").toLowerCase();
    if (!token) continue;

    const rawValue = it.total?.value;
    if (typeof rawValue !== "string" || !/^\d+$/.test(rawValue)) continue;
    const amount = BigInt(rawValue);
    if (amount === 0n) continue;

    const decimals = Number(it.total?.decimals ?? it.token?.decimals ?? 18);
    const meta: TokenMeta = {
      symbol: sanitizeSymbol(it.token?.symbol),
      decimals: Number.isFinite(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18,
    };

    const ts = it.timestamp ? Math.floor(new Date(it.timestamp).getTime() / 1000) : null;
    const entry = byTx.get(txHash) ?? {
      ts: Number.isFinite(ts as number) ? ts : null,
      out: new Map<string, Leg>(),
      in: new Map<string, Leg>(),
    };

    const from = it.from?.hash?.toLowerCase();
    const to = it.to?.hash?.toLowerCase();
    // A transaction can move the same token more than once — a multi-hop route
    // through the same pool, say — so legs accumulate rather than overwrite.
    const add = (side: Map<string, Leg>) => {
      const prev = side.get(token);
      side.set(token, { token, amount: (prev?.amount ?? 0n) + amount, meta });
    };
    if (from === me) add(entry.out);
    if (to === me) add(entry.in);
    byTx.set(txHash, entry);
  }

  const trades: Trade[] = [...byTx]
    .map(([txHash, e]) => ({ txHash, timestamp: e.ts, out: [...e.out.values()], in: [...e.in.values()] }))
    // Drop transactions where the account neither sent nor received anything,
    // which can happen when the explorer includes a transfer between two other
    // parties inside a transaction this account merely appears in.
    .filter((t) => t.out.length > 0 || t.in.length > 0);

  trades.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return disambiguate(trades);
}

/**
 * Where two DIFFERENT contracts claim the same symbol, show which is which.
 *
 * This is not hypothetical tidying. On this chain right now, "GME" is two
 * unrelated contracts and so is "PIPEDOG" — anyone can deploy a token and name
 * it whatever they like, and impersonating a real ticker is the oldest trick
 * there is. Rendering both as a bare "GME" on a page people use to check what
 * their agent actually bought would be actively misleading, so a colliding
 * symbol carries a slice of its address and stops being a claim you have to
 * take on faith.
 */
function disambiguate(trades: Trade[]): Trade[] {
  const addrsBySymbol = new Map<string, Set<string>>();
  for (const t of trades) {
    for (const l of [...t.out, ...t.in]) {
      const set = addrsBySymbol.get(l.meta.symbol) ?? new Set<string>();
      set.add(l.token);
      addrsBySymbol.set(l.meta.symbol, set);
    }
  }
  const colliding = new Set([...addrsBySymbol].filter(([, s]) => s.size > 1).map(([sym]) => sym));
  if (colliding.size === 0) return trades;

  const mark = (l: Leg): Leg =>
    colliding.has(l.meta.symbol)
      ? { ...l, meta: { ...l.meta, symbol: `${l.meta.symbol}·${l.token.slice(2, 6)}` } }
      : l;
  return trades.map((t) => ({ ...t, out: t.out.map(mark), in: t.in.map(mark) }));
}

/* ── holdings ──────────────────────────────────────────────────────────────
 *
 * What the account HOLDS, as opposed to what has moved through it. A tape
 * answers "what did it do"; this answers "what is it sitting on right now",
 * which is the question anyone actually opens a dashboard to ask.
 *
 * Blockscout resolves symbol, decimals AND an exchange rate in one request and
 * serves it `access-control-allow-origin: *`, so the browser can price a
 * portfolio with no key, no price feed and no server of ours in the path —
 * which is the same rule the rest of this file follows.
 */

export interface Holding {
  token: string;
  symbol: string;
  decimals: number;
  amount: bigint;
  /**
   * USD value, or null when the explorer has no rate for this token.
   *
   * NULL IS NOT ZERO, and the difference is the whole point. Most tokens on a
   * young chain have no listed rate, and quietly folding them in at 0 would
   * report a portfolio smaller than it is — the exact direction of error that
   * makes someone think their agent lost money. Unpriced holdings are shown,
   * counted separately, and excluded from the total that claims to be a total.
   */
  usd: number | null;
}

export interface Portfolio {
  holdings: Holding[];
  /** Sum of the holdings that HAVE a rate. Never a guess about the others. */
  pricedUsd: number;
  /** How many holdings carry no rate, so the page can say so out loud. */
  unpricedCount: number;
}

interface BsBalance {
  value?: string;
  token?: {
    address_hash?: string;
    address?: string;
    symbol?: string;
    decimals?: string | number;
    exchange_rate?: string | null;
    type?: string;
  };
}

/** Human amount as a float, for multiplying by a rate. Display still uses formatAmount. */
function toFloat(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/**
 * This endpoint returns EVERY balance in one unpaginated response, and on an
 * address with a huge airdrop tail it can simply never answer — measured: the
 * burn address returned 142,968 holdings once and then timed out at 120s having
 * sent 0 bytes. A dashboard whose spinner runs forever is worse than one that
 * says it could not read, so the wait is bounded here rather than left to the
 * caller to remember.
 */
const HOLDINGS_TIMEOUT_MS = 20_000;

export async function fetchHoldings(account: string, signal?: AbortSignal): Promise<Portfolio> {
  const url = `${EXPLORER}/api/v2/addresses/${account}/token-balances`;
  const timeout = AbortSignal.timeout(HOLDINGS_TIMEOUT_MS);
  // Either the caller giving up or the ceiling above ends the request.
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const res = await fetch(url, { signal: combined, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`explorer ${res.status}`);
  const rows = (await res.json()) as BsBalance[];
  if (!Array.isArray(rows)) return { holdings: [], pricedUsd: 0, unpricedCount: 0 };

  const holdings: Holding[] = [];
  for (const r of rows) {
    // ERC-20 only. An NFT in a trading account is somebody's airdrop, and it has
    // no amount that means anything next to a token balance.
    if (r.token?.type && r.token.type !== "ERC-20") continue;
    const token = (r.token?.address_hash || r.token?.address || "").toLowerCase();
    if (!token) continue;
    if (typeof r.value !== "string" || !/^\d+$/.test(r.value)) continue;
    const amount = BigInt(r.value);
    if (amount === 0n) continue;

    const d = Number(r.token?.decimals ?? 18);
    const decimals = Number.isFinite(d) && d >= 0 && d <= 36 ? d : 18;
    const rate = r.token?.exchange_rate ? Number(r.token.exchange_rate) : NaN;
    const usd = Number.isFinite(rate) && rate > 0 ? toFloat(amount, decimals) * rate : null;

    holdings.push({ token, symbol: sanitizeSymbol(r.token?.symbol), decimals, amount, usd });
  }

  // Same impersonation problem as the tape: anyone can deploy a token called
  // USDG. A holdings list is arguably the worse place to get it wrong, since
  // that is where someone checks whether their money is where they think.
  const addrsBySymbol = new Map<string, Set<string>>();
  for (const h of holdings) {
    const set = addrsBySymbol.get(h.symbol) ?? new Set<string>();
    set.add(h.token);
    addrsBySymbol.set(h.symbol, set);
  }
  const colliding = new Set([...addrsBySymbol].filter(([, s]) => s.size > 1).map(([sym]) => sym));
  const marked = holdings.map((h) =>
    colliding.has(h.symbol) ? { ...h, symbol: `${h.symbol}·${h.token.slice(2, 6)}` } : h,
  );

  // Priced first and largest first — the things worth money lead, and the long
  // tail of unpriced airdrops sorts to the bottom instead of burying them.
  marked.sort((a, b) => {
    if ((a.usd === null) !== (b.usd === null)) return a.usd === null ? 1 : -1;
    return (b.usd ?? 0) - (a.usd ?? 0);
  });

  return {
    holdings: marked,
    pricedUsd: marked.reduce((sum, h) => sum + (h.usd ?? 0), 0),
    unpricedCount: marked.filter((h) => h.usd === null).length,
  };
}

/** Native ETH, which pays for gas and is NOT part of the traded portfolio. */
export async function fetchGas(account: string, signal?: AbortSignal): Promise<bigint> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [account, "latest"] }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "rpc error");
  return BigInt(json.result);
}

/**
 * Has the smart account been deployed yet?
 *
 * A counterfactual ERC-4337 account reads as code "0x" until its first
 * operation, which is indistinguishable from a plain EOA by getCode alone. This
 * is worth surfacing because "funded but never traded" and "wrong address
 * entirely" look identical otherwise, and the second one is how people lose
 * money — see the smart-account-vs-owner-EOA confusion in the docs.
 */
export async function isDeployed(account: string, signal?: AbortSignal): Promise<boolean> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [account, "latest"] }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || "rpc error");
  return typeof json.result === "string" && json.result !== "0x" && json.result.length > 2;
}

/** USD, with cents — the figures here are portfolio-sized, not wei-sized. */
export function formatUsd(v: number): string {
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
