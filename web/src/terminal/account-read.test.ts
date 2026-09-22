/**
 * WHAT THE SHELL MAY SAY ABOUT AN ACCOUNT IT HAS NOT READ.
 *
 * App.tsx turned an unread signature into `String(caps ?? "")`, and every
 * surface then printed `money(Number(perTrade))` — so a key nobody had loaded
 * yet read "$0.00 per trade", which is a limit, not an absence. These render
 * the real components from the values the shell derives, because a helper that
 * returns null proves nothing if a screen still coerces it back to zero.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { autonomyOf } from "@merrymen/core";
import { capsOf, portfolioReadOf, profileShown, usdgOrNull } from "./account-read";
import type { AccountState } from "./HostedControls";
import type { LiveMine } from "./live";

// See wire-ring.test.ts: tsx compiles `.tsx` against a global React.
(globalThis as unknown as { React: typeof React }).React = React;

const noop = () => {};
const account = (caps?: { perTradeUsdg: number; dailyUsdg: number }): AccountState => ({
  session: { hosted: true, address: "0x" + "a".repeat(40) },
  status: caps
    ? { exists: true, grant: { smartAccount: "0x" + "b".repeat(40), chainId: 4663, caps } }
    : { exists: true },
});
/** An agent whose book has not been read either: every figure unknown. */
const mine: LiveMine = {
  name: "Shogun",
  slug: "0123456789abcdef",
  handle: null,
  owner: null,
  equity: null,
  chg24: null,
  mode: null,
  thesis: null,
  moves: [],
  glance: { id: "custom", label: "", cashUsd: undefined },
  autonomy: autonomyOf({ mode: null, liveBlocker: null }),
};
/** Every dollar amount in the markup, however React split the element. */
const dollars = (html: string) => html.replace(/<[^>]+>/g, "").match(/\$[\d,.]+/g) ?? [];

describe("trading limits nobody has read", () => {
  it("are null, not an empty string that Number() turns into zero", () => {
    assert.deepEqual(capsOf(null), { perTrade: null, perDay: null });
    assert.deepEqual(capsOf(account()), { perTrade: null, perDay: null });
  });

  it("pass a signed cap through as the number it is", () => {
    assert.deepEqual(capsOf(account({ perTradeUsdg: 10, dailyUsdg: 50 })), { perTrade: 10, perDay: 50 });
  });

  it("render as a dash on the desktop portfolio, never $0.00", async () => {
    const { DesktopPortfolio } = await import("./Desktop");
    const { perTrade, perDay } = capsOf(null);
    const html = renderToStaticMarkup(
      createElement(DesktopPortfolio, {
        mine,
        tokens: [],
        stopped: true,
        perTrade,
        perDay,
        onScreen: noop,
        onTab: noop,
      } as never),
    );
    assert.deepEqual(dollars(html), [], `an unread account printed ${dollars(html).join(", ")}`);
    assert.match(html, /Per trade<\/span><strong>—<\/strong>/);
    assert.match(html, /Per day<\/span><strong>—<\/strong>/);
  });

  it("and on the profile's limits row", async () => {
    const { You } = await import("./screens/You");
    const { perTrade, perDay } = capsOf(account());
    const html = renderToStaticMarkup(
      createElement(You, {
        mine,
        history: [],
        stopped: true,
        perTrade,
        perDay,
        onLimits: noop,
        onStop: noop,
        onDesk: noop,
        onDeposit: noop,
        onWithdraw: noop,
      } as never),
    );
    assert.ok(!/\$0\.00 per trade/.test(html.replace(/<[^>]+>/g, "")), "an unread cap must not read as $0.00");
    assert.match(html.replace(/<[^>]+>/g, ""), /— per trade · — per\s+day/);
  });

  it("while a real cap still renders as money", async () => {
    const { DesktopPortfolio } = await import("./Desktop");
    const { perTrade, perDay } = capsOf(account({ perTradeUsdg: 10, dailyUsdg: 50 }));
    const html = renderToStaticMarkup(
      createElement(DesktopPortfolio, { mine, tokens: [], stopped: true, perTrade, perDay, onScreen: noop, onTab: noop } as never),
    );
    assert.deepEqual(dollars(html), ["$10.00", "$50.00"]);
  });
});

describe("the chain's cash figure", () => {
  it("stays unknown when the route could not read it", () => {
    assert.equal(usdgOrNull(null), null);
    assert.equal(usdgOrNull(undefined), null);
    assert.equal(usdgOrNull("not a number"), null);
  });

  it("converts a read balance from 6dp, zero included", () => {
    assert.equal(usdgOrNull("0"), 0);
    assert.equal(usdgOrNull("12500000"), 12.5);
  });
});

describe("the owner's book, as the account entry is told it", () => {
  it("is in flight until the market load has finished", () => {
    assert.equal(portfolioReadOf("unread", false), "unread");
  });

  it("is a failure once the load finished without ever reading it", () => {
    // loadLive threw, so `reads` is still the seed's "unread" — but nobody is
    // still asking. Drawing a skeleton here would say "loading" for ever.
    assert.equal(portfolioReadOf("unread", true), "unreadable");
  });

  it("is whatever the read said once it said something", () => {
    assert.equal(portfolioReadOf("ok", true), "ok");
    assert.equal(portfolioReadOf("unreadable", true), "unreadable");
  });
});

describe("the profile screen while its read is in flight", () => {
  const listed = { slug: "a", curveKind: "equity" };
  const full = { slug: "a", curveKind: "growth" };

  it("shows nothing from the leaderboard row until the profile has answered", () => {
    // The board row carries a raw-equity curve, so rendering it as the profile
    // printed "Performance history isn't available yet" for the whole of the
    // fetch — a verdict about a request that had not come back.
    assert.equal(profileShown(null, "", listed), undefined);
  });

  it("falls back to the leaderboard row only once the profile read has failed", () => {
    assert.equal(profileShown(null, "Couldn't load this agent.", listed), listed);
  });

  it("prefers the profile whenever it has one, even after a later refresh failed", () => {
    assert.equal(profileShown(full, "", listed), full);
    assert.equal(profileShown(full, "Couldn't load this agent.", listed), full);
  });
});
