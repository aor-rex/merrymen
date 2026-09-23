/**
 * A FIGURE MOVES ON SCREEN WHEN IT MOVED IN THE WORLD, AND ONLY THEN.
 *
 * `Flip` was built and never mounted. It replays its animation whenever its
 * text changes — which includes the first time anything is drawn, so wrapping
 * every price in it as it stood would have flipped the whole market list on
 * every page load and every remount, as if every price had just moved. These
 * pin that it animates a CHANGE, in the direction of the change, and nothing
 * else.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";

import { testDom } from "./test-dom";
import { trendOf } from "./motion";

describe("which way a figure moved", () => {
  it("up, down, or not a move at all", () => {
    assert.equal(trendOf(1, 2), "up");
    assert.equal(trendOf(2, 1), "down");
    assert.equal(trendOf(2, 2), null);
  });

  it("a figure appearing for the first time did not move — nor did one that became unknown", () => {
    assert.equal(trendOf(undefined, 5), null);
    assert.equal(trendOf(null, 5), null, "unread, then read, is a first reading");
    assert.equal(trendOf(5, null), null);
    assert.equal(trendOf(Number.NaN, 5), null);
  });
});

describe("a moving figure on screen", () => {
  it("draws still on first render, then flips the way the value went", async () => {
    const t = testDom();
    const { MovingFigure } = await import("./ui");
    const at = (value: number | null) => createElement(MovingFigure, { value, text: value === null ? "—" : `$${value}` });
    const cls = () => t.container.querySelector(".flip-slot > span")!.className;
    const trend = () => t.container.querySelector(".flip-slot")!.getAttribute("data-trend");
    try {
      await t.render(at(10));
      assert.equal(cls(), "flip-still", "nothing moved: this is the first time it was drawn");
      assert.equal(trend(), null);
      await t.render(at(11));
      assert.equal(cls(), "flip");
      assert.equal(trend(), "up");
      await t.render(at(9));
      assert.equal(cls(), "flip rev");
      assert.equal(trend(), "down");
      await t.render(at(null));
      assert.equal(cls(), "flip-still", "a price that became unknown did not fall");
      assert.equal(t.container.textContent, "—");
    } finally {
      await t.close();
    }
  });

  it("the balance flips only when the balance changes", async () => {
    const t = testDom();
    const { BalanceFigure } = await import("./studio");
    const cls = () => t.container.querySelector(".flip-slot > span")?.className;
    try {
      await t.render(createElement(BalanceFigure, { value: 100 }));
      assert.equal(cls(), "flip-still");
      await t.render(createElement(BalanceFigure, { value: 100 }));
      assert.equal(cls(), "flip-still");
      await t.render(createElement(BalanceFigure, { value: 120.5 }));
      assert.equal(cls(), "flip");
      assert.match(t.container.textContent ?? "", /120\.50/);
      assert.ok(t.container.querySelector(".figure-decimals"), "the decimals keep their own face");
    } finally {
      await t.close();
    }
  });
});
