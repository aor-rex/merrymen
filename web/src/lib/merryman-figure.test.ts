import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { figureLabel, shellFor, trimFor, trimHex } from "./merryman-figure";

describe("the figure trims from the worker's mode, never from a wardrobe", () => {
  it("live is green, paper is lime", () => {
    assert.equal(trimHex(trimFor("live")), "#22c55e");
    assert.equal(trimHex(trimFor("paper")), "#b8f53d");
  });

  it("null and unknown modes render idle dim, never as practice or live", () => {
    for (const mode of [null, undefined, "", "demo", "LIVE"]) {
      assert.equal(trimFor(mode), "idle");
    }
    assert.equal(trimHex(trimFor(null)), "#52525b");
  });

  it("the caption says the state", () => {
    assert.equal(figureLabel("live"), "trading for real");
    assert.equal(figureLabel("paper"), "practice money");
    assert.equal(figureLabel("idle"), "not running");
  });
});

describe("the shell follows the running strategy", () => {
  it("trencher strategy grows fins", () => {
    assert.equal(shellFor("trencher"), "trencher");
    assert.equal(shellFor("TrencherCAD"), "trencher");
  });

  it("anything else, including nothing, is the default shell", () => {
    assert.equal(shellFor("spot"), "default");
    assert.equal(shellFor(null), "default");
    assert.equal(shellFor(undefined), "default");
  });
});
