import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatSettingValue, parseSettingValue, specFor, stockSymbols, validStoredSetting, SETTING_SPECS } from "./setting-spec";

const spec = (k: string) => specFor(k)!;

describe("parseSettingValue — owner words in, stored value out", () => {
  it("reads dollars however they are written", () => {
    for (const raw of ["20", "$20", "20 usdg", "20.00", "twenty is $20"]) {
      assert.deepEqual(parseSettingValue(spec("buyPerTickUsdg"), raw), { ok: true, value: 20 }, raw);
    }
    assert.deepEqual(parseSettingValue(spec("idleFloorUsdg"), "1,500"), { ok: true, value: 1500 });
  });

  it("REFUSES out of range rather than clamping — the resolver would silently use the default", () => {
    const r = parseSettingValue(spec("buyPerTickUsdg"), "0");
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /can't go below \$1\.00/);
    assert.equal(parseSettingValue(spec("slippageBps"), "50%").ok, false, "slippage tops out at 10%");
  });

  it("stores percentages as basis points", () => {
    assert.deepEqual(parseSettingValue(spec("takeProfitBps"), "25%"), { ok: true, value: 2500 });
    assert.deepEqual(parseSettingValue(spec("strategistStopLossBps"), "7.5"), { ok: true, value: 750 });
    assert.equal(formatSettingValue(spec("takeProfitBps"), 2500), "25%");
    assert.equal(formatSettingValue(spec("strategistStopLossBps"), 0), "off (0%)");
  });

  it("reads on/off, and refuses anything else", () => {
    assert.deepEqual(parseSettingValue(spec("discoveryEnabled"), "on"), { ok: true, value: true });
    assert.deepEqual(parseSettingValue(spec("discoveryEnabled"), "Off"), { ok: true, value: false });
    assert.equal(parseSettingValue(spec("discoveryEnabled"), "maybe").ok, false);
  });

  it("stores hold time in seconds from hours, minutes or days", () => {
    assert.deepEqual(parseSettingValue(spec("classMaxHoldSec"), "6h"), { ok: true, value: 21_600 });
    assert.deepEqual(parseSettingValue(spec("classMaxHoldSec"), "30m"), { ok: true, value: 1_800 });
    assert.deepEqual(parseSettingValue(spec("classMaxHoldSec"), "2 days"), { ok: true, value: 172_800 });
    assert.equal(formatSettingValue(spec("classMaxHoldSec"), 21_600), "6h");
  });

  it("a whole-number setting refuses a fraction", () => {
    assert.equal(parseSettingValue(spec("llmIntervalMin"), "2.5").ok, false);
  });

  it("builds a basket only from tickers it can trade, and says which it could not", () => {
    const allowed = ["QQQ", "NVDA", "TSLA"];
    assert.deepEqual(parseSettingValue(spec("basketSymbols"), "qqq, nvda and $TSLA", allowed), {
      ok: true,
      value: ["QQQ", "NVDA", "TSLA"],
    });
    const r = parseSettingValue(spec("basketSymbols"), "QQQ, DOGE", allowed);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /DOGE/);
  });

  it("the basket's known tickers come from the stock-token table", () => {
    assert.ok(stockSymbols().length > 0);
  });
});

describe("validStoredSetting — the promotion-time check", () => {
  it("accepts exactly what parseSettingValue produces for every setting", () => {
    const samples: Record<string, string> = {
      strategy: "trencher",
      assetMode: "stocks",
      basketSymbols: "QQQ",
      officialCoinsEnabled: "on",
      discoveryEnabled: "off",
      telegramNotifyEnabled: "on",
      takeProfitBps: "10%",
      strategistStopLossBps: "5%",
      slippageBps: "1%",
      classMaxHoldSec: "6h",
    };
    for (const s of SETTING_SPECS) {
      const raw = samples[s.key] ?? String(s.min ?? 1);
      const parsed = parseSettingValue(s, raw);
      assert.ok(parsed.ok, `${s.key} failed to parse "${raw}"`);
      assert.ok(validStoredSetting(s.key, (parsed as { value: unknown }).value), `${s.key} parsed to a value its own check refuses`);
    }
  });

  it("refuses keys it does not know", () => {
    assert.equal(validStoredSetting("liveTradingEnabled", true), false);
  });
});
