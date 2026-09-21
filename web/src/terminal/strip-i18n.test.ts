/**
 * THE STRIP SPEAKS EVERY LANGUAGE THE PRODUCT DOES, OR NONE.
 *
 * `strip.*` is complete in all ten shipped locales, which is the only reason
 * the card renders translated at all: a namespace missing ONE key falls back
 * whole, so a single forgotten line would quietly turn the entire strip back
 * into English in that language. Nothing on screen would say so — the reader
 * would simply get English, and the person who added the key would never find
 * out.
 *
 * That is the failure this file exists to make loud. It is the mirror of the
 * Settings guard in i18n.test.ts, which pins a namespace deliberately held
 * BACK; this one pins a namespace deliberately shipped FORWARD, and they are
 * the two halves of the same rule.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { translate, translatedNamespaces } from "@/lib/i18n";
import { EN, type MessageKey } from "@/lib/messages/en";
import { CATALOGUES } from "@/lib/messages";
import { DEFAULT_LOCALE, SUPPORTED } from "@/lib/locale";

const STRIP_KEYS = (Object.keys(EN) as MessageKey[]).filter((k) => k.startsWith("strip."));

describe("every shipped locale carries the whole strip", () => {
  it("has strip keys in English to begin with", () => {
    assert.ok(STRIP_KEYS.length >= 20, `only ${STRIP_KEYS.length} strip keys`);
  });

  it("TRANSLATES EVERY ONE, IN EVERY LANGUAGE", () => {
    for (const [tag, table] of Object.entries(CATALOGUES)) {
      const missing = STRIP_KEYS.filter((k) => {
        const v = table?.[k];
        return typeof v !== "string" || v.trim() === "";
      });
      assert.deepEqual(
        missing,
        [],
        `${tag} is missing ${missing.length} strip key(s) — the WHOLE strip falls back to English there: ${missing.join(", ")}`,
      );
    }
  });

  it("and so the namespace actually ships", () => {
    // The end the checks above exist for. A key could be present and the
    // namespace still withheld — `REQUIRES` withdraws one whose vocabulary is
    // not ready — so the conclusion is asserted directly rather than inferred.
    for (const { tag } of SUPPORTED) {
      assert.ok(
        translatedNamespaces(tag).includes("strip"),
        `${tag} would render the connection strip in English`,
      );
    }
  });
});

describe("what the words may not be", () => {
  it("does not leave a translation as the English it came from", () => {
    // Per-namespace, which the catalogue-wide 50% check in i18n.test.ts cannot
    // see: twenty English strings hiding inside a thousand translated ones
    // stays comfortably under its threshold.
    for (const [tag, table] of Object.entries(CATALOGUES)) {
      const copied = STRIP_KEYS.filter((k) => table?.[k] === EN[k]);
      assert.deepEqual(copied, [], `${tag} left ${copied.length} strip string(s) in English`);
    }
  });

  it("keeps the {bot} placeholder in every language", () => {
    // A translator who drops the placeholder produces a sentence that renders
    // with the bot's name missing rather than one that fails — the worst shape
    // of bug, because it reads as a product that forgot who you connected.
    for (const { tag } of SUPPORTED) {
      assert.match(
        translate(tag, "strip.tg.connectedAs", { bot: "merrybot" }),
        /merrybot/,
        `${tag} drops the bot name from the connected message`,
      );
    }
  });

  it("never renders a raw key or an empty string", () => {
    for (const { tag } of SUPPORTED) {
      for (const key of STRIP_KEYS) {
        const out = translate(tag, key, { bot: "x" });
        assert.notEqual(out.trim(), "", `${tag}/${key} is empty`);
        assert.notEqual(out, key, `${tag}/${key} rendered its own key`);
      }
    }
  });

  it("leaves the product names out of the catalogue entirely", () => {
    // `Telegram` and `Trencher` are identifiers a reader matches against a
    // chat app and a settings heading. A key for either would invite a
    // translation, and a translated product name is a product nobody can find.
    for (const key of STRIP_KEYS) {
      // WIDENED TO `string` ON PURPOSE. `EN[key]` is a union of literal types,
      // so comparing it against a name no key currently holds is a comparison
      // TypeScript can prove is always true — and it rejects it (TS2367) rather
      // than let a tautology sit in a test. The check is about what a FUTURE
      // key might contain, which is a runtime question, not a type-level one.
      const english: string = EN[key];
      assert.ok(
        english !== "Telegram" && english !== "Trencher",
        `${key} keys a product name`,
      );
    }
  });

  it("keeps the link command out of the copy", () => {
    // The `/link CODE` command is retyped verbatim into a chat. It renders as
    // its own element precisely so no message carries it — a message that did
    // would put an identifier where a translator can edit it.
    for (const { tag } of SUPPORTED) {
      for (const key of STRIP_KEYS) {
        assert.ok(
          !translate(tag, key).includes("/link"),
          `${tag}/${key} embeds the link command in translatable copy`,
        );
      }
    }
  });
});

describe("English stays the source", () => {
  it("renders English for the default locale without consulting a catalogue", () => {
    for (const key of STRIP_KEYS) {
      assert.equal(translate(DEFAULT_LOCALE, key), EN[key]);
    }
  });
});
