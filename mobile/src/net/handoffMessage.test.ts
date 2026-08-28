import { describe, expect, it } from "vitest";
import { handoffMessage, type HandoffOutcome } from "./handoffMessage";

/**
 * The funding handoff's honesty contract.
 *
 * This screen is the one that asks someone to send real money to an address, and
 * the message under the button is what they act on. The failure this pins is
 * specific: claiming the address was copied when the clipboard write failed
 * sends the user into Phantom to paste nothing, and they find out at the
 * recipient field of a transfer. So "copied" may appear only when it is true.
 */

const OUTCOMES: HandoffOutcome[] = ["app", "web", "failed"];

describe("handoffMessage", () => {
  it("never claims a copy that did not happen", () => {
    for (const opened of OUTCOMES) {
      const msg = handoffMessage({ copied: false, opened });
      expect(msg.toLowerCase()).not.toContain("copied —");
      expect(msg.toLowerCase()).not.toContain("address copied");
      expect(msg.toLowerCase()).not.toContain("on your clipboard");
    }
  });

  it("says so when the copy DID happen", () => {
    for (const opened of OUTCOMES) {
      const msg = handoffMessage({ copied: true, opened });
      expect(msg.toLowerCase()).toMatch(/copied|clipboard/);
    }
  });

  it("always leaves the reader something to do", () => {
    for (const opened of OUTCOMES) {
      for (const copied of [true, false]) {
        const msg = handoffMessage({ copied, opened });
        expect(msg.length).toBeGreaterThan(20);
        // Every branch ends in an instruction: paste it, copy it by hand, or
        // tap Send. A message that only reports a failure strands the reader.
        expect(msg.toLowerCase()).toMatch(/paste|copy|tap send/);
      }
    }
  });

  it("names Robinhood Chain on the success path, where the user picks a network", () => {
    // Phantom ships Robinhood Chain switched off, so a send screen without it is
    // the likeliest place to get stuck — the happy path has to name the network.
    expect(handoffMessage({ copied: true, opened: "app" })).toContain("Robinhood Chain");
    expect(handoffMessage({ copied: false, opened: "app" })).toContain("Robinhood Chain");
  });

  it("does not assert Phantom is missing when it merely failed to open", () => {
    // "failed" means the launch threw; that is not proof of an uninstall, and
    // saying so would send someone to reinstall a wallet they already have.
    for (const copied of [true, false]) {
      expect(handoffMessage({ copied, opened: "failed" })).not.toMatch(/installed/i);
    }
  });

  it("gives all six states a distinct message", () => {
    const seen = new Set<string>();
    for (const opened of OUTCOMES) {
      for (const copied of [true, false]) seen.add(handoffMessage({ copied, opened }));
    }
    expect(seen.size).toBe(6);
  });
});
