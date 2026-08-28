import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PONS_V2_FACTORY, PONS_V2_LAUNCH_TOPIC, parseLaunchLogs } from "./pons";

/**
 * Reading the launchpad merrymen could not see.
 *
 * Every constant here was taken off mainnet 4663, not from documentation —
 * Pons publishes none — so these tests pin the shape that was actually
 * observed. If Pons changes its event, this is what should fail, loudly,
 * rather than discovery quietly reporting nothing forever.
 */

const TOPIC = PONS_V2_LAUNCH_TOPIC;
const pad = (a: string) => `0x${"0".repeat(24)}${a.replace(/^0x/, "")}`;
// A real launch, verbatim from block 48669568.
const JASON = {
  token: "0x6c6e57f34bb4f0a5da88acd062743f72eb9dad49",
  creator: "0xf3e1ae76402bb7940e9253bd3aa818b71cd35e20",
  curve: "0xab3e119ae920c06830564fc4c0e2227c23dbc6fb",
};
const log = (over: Partial<{ topics: string[]; blockNumber: bigint | null; transactionHash: string | null }> = {}) => ({
  topics: [TOPIC, pad(JASON.token), pad(JASON.creator), pad(JASON.curve)],
  blockNumber: 48669568n,
  transactionHash: "0xdeadbeef",
  ...over,
});

describe("pons launch parsing", () => {
  it("reads token, creator and curve out of the three indexed topics", () => {
    // The ordering is the part that was established empirically: topic1 answers
    // symbol()/name() as an ERC-20, topic3 answers token() pointing back at it.
    const [l] = parseLaunchLogs([log()]);
    assert.ok(l);
    assert.equal(l!.token, JASON.token);
    assert.equal(l!.creator, JASON.creator);
    assert.equal(l!.curve, JASON.curve);
    assert.equal(l!.blockNumber, 48669568n);
  });

  it("ignores the factory's other, much busier event", () => {
    // The trade event outnumbers launches ~15:1 on the same contract. Treating
    // one as a launch would announce a token per trade.
    const other = log({ topics: [`0x${"8d4aad49".padEnd(64, "0")}`, pad(JASON.token), pad(JASON.creator), pad(JASON.curve)] });
    assert.deepEqual(parseLaunchLogs([other]), []);
  });

  it("SKIPS a malformed launch rather than defaulting an address", () => {
    // A launch missing an address is not a vaguer version of the same launch —
    // defaulting to the zero address would put a token nobody launched in front
    // of the owner, with a curve nobody can trade.
    assert.deepEqual(parseLaunchLogs([log({ topics: [TOPIC, pad(JASON.token)] })]), []);
    assert.deepEqual(parseLaunchLogs([log({ blockNumber: null })]), []);
    assert.deepEqual(parseLaunchLogs([log({ transactionHash: null })]), []);
  });

  it("lowercases addresses so they compare against the seen-set", () => {
    const [l] = parseLaunchLogs([log({ topics: [TOPIC, pad(JASON.token.toUpperCase().replace("0X", "0x")), pad(JASON.creator), pad(JASON.curve)] })]);
    assert.equal(l!.token, l!.token.toLowerCase());
  });

  it("pins the factory and topic that were verified on-chain", () => {
    assert.equal(PONS_V2_FACTORY, "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e");
    assert.match(PONS_V2_LAUNCH_TOPIC, /^0x[0-9a-f]{64}$/);
  });
});
