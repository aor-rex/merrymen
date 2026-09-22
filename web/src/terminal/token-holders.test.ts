/**
 * THE TOKEN PAGE'S HOLDERS, BEFORE AND AFTER THEY ARE READ.
 *
 * The holders come from a fetch in an effect, and until it answered the page
 * said "Agents holding 0" and "No public agent holdings reported yet" — two
 * claims about a request that had not come back. Token.tsx itself cannot be
 * rendered here (its chart imports an ESM-only package the runner cannot
 * load), so the decision it renders from lives in token-holders.ts and is
 * executed here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { holdersFigure, holdersList } from "./token-holders";

describe("the agents-holding figure", () => {
  it("is a dash while the read is in flight, and when it failed", () => {
    assert.equal(holdersFigure("loading", 0), "—");
    assert.equal(holdersFigure("failed", 0), "—");
  });

  it("is the count once read, zero included", () => {
    assert.equal(holdersFigure("ok", 0), "0");
    assert.equal(holdersFigure("ok", 3), "3");
  });
});

describe("the holders list", () => {
  it("draws as loading until the read answers — never as empty", () => {
    assert.equal(holdersList("loading", 0), "loading");
  });

  it("is empty only when a read that succeeded found nobody", () => {
    assert.equal(holdersList("ok", 0), "empty");
    assert.equal(holdersList("failed", 0), "failed", "a failed read is not an empty one");
  });

  it("is the table once there is someone to list", () => {
    assert.equal(holdersList("ok", 2), "table");
  });
});
