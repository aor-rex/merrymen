/**
 * WATCH FOR THE AUTONOMOUS SELL, ON CHAIN, AND CAPTURE EVERYTHING WHEN IT LANDS.
 *
 * Temporary. The log window is a ~500-line rolling snapshot and the exit may
 * fire hours from now, so the proof cannot depend on catching a line. The chain
 * keeps the receipt.
 */
import { createPublicClient, http, parseAbiItem, formatUnits, getAddress } from "viem";

const c = createPublicClient({ transport: http(process.env.RPC_URL!) });
const VAULT = getAddress("0x3fcdde6e011769ca05f0115f1543290862473216");
const ACCT = getAddress("0x05a198A677Fbcd8f5c168d397Fa7ef5eB6D65487");
const TOKEN = getAddress("0x34d73af0c4e41a727304b7049ff99ca3c953b4af");
const USDG = getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168");
const CURVE = getAddress("0x7d5369f126d98340d8aa88A80bEeB03FC3CcFF59");
const CLASS_SELL = "0xc149ab5326030a654df6bb9e89b0e138934c4520a688ea4d9e7ac8bbe2fcd7f2";
const OPENED_AT = 63155033n;

const bal = (token: `0x${string}`, who: `0x${string}`) =>
  c.readContract({
    address: token,
    abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
    functionName: "balanceOf",
    args: [who],
  }) as Promise<bigint>;

const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll from the buy block forward; the sell cannot predate it. */
let from = OPENED_AT + 1n;

for (let pass = 0; pass < 400; pass++) {
  try {
    const head = await c.getBlockNumber();
    const logs = await c.getLogs({ address: VAULT, fromBlock: from, toBlock: head });
    const sells = logs.filter((l) => l.topics[0] === CLASS_SELL);
    if (sells.length > 0) {
      const s = sells[0]!;
      const tokensIn = BigInt("0x" + s.data.slice(2, 66));
      const quoteOut = BigInt("0x" + s.data.slice(66, 130));
      const blk = await c.getBlock({ blockNumber: s.blockNumber! });
      const [vt, vu, at, au] = await Promise.all([
        bal(TOKEN, VAULT),
        bal(USDG, VAULT),
        bal(TOKEN, ACCT),
        bal(USDG, ACCT),
      ]);
      console.log("=== AUTONOMOUS ClassSell LANDED ===");
      console.log(`exit block      ${s.blockNumber}  ${new Date(Number(blk.timestamp) * 1000).toISOString()}`);
      console.log(`exit tx         ${s.transactionHash}`);
      console.log(`curve           ${"0x" + (s.topics[1] ?? "").slice(-40)}`);
      console.log(`token           ${"0x" + (s.topics[2] ?? "").slice(-40)}`);
      console.log(`qty sold        ${formatUnits(tokensIn, 18)}  (raw ${tokensIn})`);
      console.log(`proceeds USDG   ${formatUnits(quoteOut, 6)}  (raw ${quoteOut})`);
      console.log(`held            ${Number(blk.timestamp) - 1789424215} s`);
      console.log(`vault token after ${formatUnits(vt, 18)}`);
      console.log(`vault USDG after  ${formatUnits(vu, 6)}`);
      console.log(`account token     ${formatUnits(at, 18)}`);
      console.log(`account USDG      ${formatUnits(au, 6)}`);
      console.log(`cost 5.000000 USDG -> realised ${formatUnits(quoteOut - 5_000_000n, 6)} USDG (chain arithmetic)`);
      process.exit(0);
    }
    from = head + 1n > from ? head : from;
    if (pass % 10 === 0) {
      const vt = await bal(TOKEN, VAULT);
      const grad = (await c.readContract({
        address: CURVE,
        abi: [parseAbiItem("function quoteReserve() view returns (uint256)")],
        functionName: "quoteReserve",
      })) as bigint;
      console.log(
        `[watch ${pass}] block ${head} · vault token ${formatUnits(vt, 18)} · ` +
          `graduation ${((Number(grad) / 8_090_000_000) * 100).toFixed(1)}% of 85% trigger`,
      );
    }
  } catch (e) {
    console.log(`[watch] skipped a pass: ${e instanceof Error ? e.message.slice(0, 80) : String(e)}`);
  }
  await nap(120_000);
}
console.log("=== watcher gave up after 400 passes ===");
