/**
 * The owner key must survive the kill switch.
 *
 * `grant.json` is a single slot. For a grant that has never been replaced it is
 * the ONLY on-disk copy of the owner key — the key `merrymen recover` needs to
 * sweep funds out of the smart account. The CLI and the web API have archived
 * before deleting for months; the worker's own kill switch, reachable from a
 * Telegram message, did not, because the worker package had no archive path.
 *
 * These run against a real temp home rather than a mock: the thing being tested
 * is that a file exists on disk afterwards.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-archive-"));
process.env.MERRYMEN_HOME = HOME;
// loadGrantFile/archiveCurrentGrant prefer this when set; keep them on HOME.
delete process.env.MERRYMEN_GRANT_FILE;

const { archiveCurrentGrant, loadGrantFile } = await import("./grant");
const { homePaths } = await import("./home");

const ACCOUNT = "0xbC78E8b5d209Bf1D4706faEd06e155B5774275D7";
const OWNER_KEY = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function writeGrant(extra: Record<string, unknown> = {}): void {
  writeFileSync(
    homePaths.grant(),
    JSON.stringify({
      smartAccount: ACCOUNT,
      serialized: "0xserialized",
      demoOwnerPrivateKey: OWNER_KEY,
      chainId: 4663,
      ...extra,
    }),
    "utf8",
  );
}

after(() => {
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("archiveCurrentGrant", () => {
  it("keeps the owner key before anything deletes the grant", () => {
    writeGrant();
    const archived = archiveCurrentGrant();
    assert.equal(archived, ACCOUNT);

    const kept = path.join(homePaths.grantsArchive(), `${ACCOUNT.toLowerCase()}.json`);
    assert.ok(existsSync(kept), "archive file should exist");
    // The point of the whole exercise: the key is still recoverable.
    assert.match(readFileSync(kept, "utf8"), new RegExp(OWNER_KEY));
  });

  it("survives the grant being deleted afterwards — the kill-switch sequence", () => {
    writeGrant();
    archiveCurrentGrant();
    rmSync(homePaths.grant(), { force: true });

    assert.equal(loadGrantFile(), null); // the agent is gone…
    const kept = path.join(homePaths.grantsArchive(), `${ACCOUNT.toLowerCase()}.json`);
    assert.ok(existsSync(kept)); // …and the funds are not stranded
  });

  it("writes owner-only, because the file holds a plaintext private key", () => {
    writeGrant();
    archiveCurrentGrant();
    const kept = path.join(homePaths.grantsArchive(), `${ACCOUNT.toLowerCase()}.json`);
    const mode = statSync(kept).mode & 0o777;
    // Windows does not honour POSIX bits; assert only where it means something.
    if (process.platform !== "win32") assert.equal(mode, 0o600, `mode was ${mode.toString(8)}`);
  });

  it("returns null rather than throwing when there is nothing to keep", () => {
    rmSync(homePaths.grant(), { force: true });
    assert.equal(archiveCurrentGrant(), null);
  });

  it("returns null on a malformed grant instead of writing junk", () => {
    writeFileSync(homePaths.grant(), "{not json", "utf8");
    assert.equal(archiveCurrentGrant(), null);
  });

  it("a grant with no smartAccount is not archived under a bogus name", () => {
    writeFileSync(homePaths.grant(), JSON.stringify({ serialized: "0x", demoOwnerPrivateKey: OWNER_KEY }), "utf8");
    assert.equal(archiveCurrentGrant(), null);
  });
});
