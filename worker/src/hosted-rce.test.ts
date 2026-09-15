/**
 * RCE hard-off on hosted merrymen — both boundaries.
 *
 * A non-builtin strategy name makes the loader dynamic-import() and EXECUTE a
 * file from the tenant's home, in the process that holds every session key.
 * And telegram PC-control / agent / auto-shell mean "run a shell". Self-hosted
 * both are the owner's own machine; hosted they are our server. So hosted:
 *   - buildStrategy refuses a non-builtin name and runs the safe builtin;
 *   - mergeSettings forces every remote-execution flag off, even if a value is
 *     already on disk or in env.
 *
 * MERRYMEN_HOSTED is toggled per-case and restored.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildStrategy, type StrategyBuildOpts } from "./strategies/registry";
import { mergeSettings } from "./settings";
import { UNISWAP, type MerrymenSettings } from "../../packages/core/src/index";

afterEach(() => {
  delete process.env.MERRYMEN_HOSTED;
});

const opts = (onNote?: StrategyBuildOpts["onNote"]): StrategyBuildOpts => ({
  swapRouter: UNISWAP.swapRouter02 as `0x${string}`,
  usdg6: (v: number) => BigInt(Math.round(v * 1e6)),
  basketSymbols: ["AAPL"],
  buyPerTickUsdg: 5,
  idleFloorUsdg: 200,
  gapEnterBudgetUsdg: 10,
  llm: { creds: null, intervalMin: 30, maxActionUsdg: 5 },
  onNote,
});

describe("hosted strategy loader fails closed", () => {
  it("a non-builtin name runs steady-basket, never a tenant file", () => {
    process.env.MERRYMEN_HOSTED = "1";
    const notes: string[] = [];
    const s = buildStrategy("totally-custom-evil", opts((_l, m) => notes.push(m)));
    assert.equal(s.name, "steady-basket", "hosted falls back to the safe builtin");
    assert.ok(
      notes.some((m) => /disabled on hosted/.test(m)),
      "and says so, loudly",
    );
  });

  it("a builtin name still resolves normally hosted", () => {
    process.env.MERRYMEN_HOSTED = "1";
    assert.equal(buildStrategy("weekend-gap", opts()).name, "weekend-gap");
  });
});

describe("hosted forces the remote-execution flags off", () => {
  const rceFile: MerrymenSettings = {
    telegramPcControlEnabled: true,
    telegramAgentEnabled: true,
    telegramAgentAutoShell: true,
    telegramShellAllowlist: ["rm", "curl"],
    telegramAppAllowlist: ["cmd.exe"],
    telegramFilesRoot: "C:/",
    telegramCapabilities: ["shell", "keyboard"],
  };
  const rceEnv = {
    MERRYMEN_TELEGRAM_PC_CONTROL: "true",
    MERRYMEN_TELEGRAM_AGENT: "true",
    MERRYMEN_TELEGRAM_AGENT_AUTOSHELL: "true",
  };

  it("self-hosted honours them (unchanged)", () => {
    delete process.env.MERRYMEN_HOSTED;
    const c = mergeSettings(rceFile, {});
    assert.equal(c.telegramPcControlEnabled, true);
    assert.equal(c.telegramAgentAutoShell, true);
    assert.deepEqual(c.telegramShellAllowlist, ["rm", "curl"]);
  });

  it("hosted forces them off no matter what the file OR env say", () => {
    process.env.MERRYMEN_HOSTED = "1";
    const c = mergeSettings(rceFile, rceEnv);
    assert.equal(c.telegramPcControlEnabled, false);
    assert.equal(c.telegramAgentEnabled, false);
    assert.equal(c.telegramAgentAutoShell, false);
    assert.deepEqual(c.telegramShellAllowlist, []);
    assert.deepEqual(c.telegramAppAllowlist, []);
    assert.deepEqual(c.telegramCapabilities, []);
    assert.equal(c.telegramFilesRoot, undefined);
  });
});
