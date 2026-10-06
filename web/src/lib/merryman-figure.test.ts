import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { colorwayFromStored, colorwayHex, colorwayKey, figureLabel, kindFromStored, kindKey, shellFor, trimFor, trimHex } from "./merryman-figure";

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

describe("dress changes the body colour only, never the state", () => {
  it("three shells, spectre is the house black", () => {
    assert.equal(colorwayHex("spectre"), "#2b3542");
    assert.equal(colorwayHex("aurum"), "#4a3d22");
    assert.equal(colorwayHex("glacier"), "#31445a");
  });

  it("unknown stored values fall back to spectre, never blank", () => {
    assert.equal(colorwayFromStored(null), "spectre");
    assert.equal(colorwayFromStored(undefined), "spectre");
    assert.equal(colorwayFromStored("live"), "spectre");
    assert.equal(colorwayFromStored("aurum"), "aurum");
  });

  it("the key is per agent, and unclaimed agents share one", () => {
    assert.equal(colorwayKey("abc"), "merryman-shell:abc");
    assert.equal(colorwayKey(null), "merryman-shell:unclaimed");
  });
});

describe("kind is dress: the head is the character, never the state", () => {
  it("unknown stored kinds fall back to robot, never blank", () => {
    assert.equal(kindFromStored(null), "robot");
    assert.equal(kindFromStored(undefined), "robot");
    assert.equal(kindFromStored("live"), "robot");
    assert.equal(kindFromStored("fox"), "fox");
  });

  it("the kind key is per agent", () => {
    assert.equal(kindKey("abc"), "merryman-kind:abc");
    assert.equal(kindKey(null), "merryman-kind:unclaimed");
  });
});
