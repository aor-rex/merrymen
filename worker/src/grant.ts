import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { StoredGrant } from "../../packages/core/src/index";
import { homePaths } from "./home";

/** Reads the grant handoff written by web's /api/grants (~/.merrymen/grant.json). */
export function loadGrantFile(): StoredGrant | null {
  const file = process.env.MERRYMEN_GRANT_FILE ?? homePaths.grant();
  try {
    const grant = JSON.parse(readFileSync(file, "utf8")) as StoredGrant;
    if (!grant.serialized || !grant.smartAccount) return null;
    return grant;
  } catch {
    return null;
  }
}

/**
 * Copy the live grant into the archive before anything destroys it.
 *
 * `grant.json` is a SINGLE SLOT, and for a grant that has never been replaced
 * it is the only on-disk copy of the owner key — the key `merrymen recover`
 * needs to sweep funds out of the smart account. Deleting it without a copy
 * strands the funds permanently.
 *
 * The CLI (`archiveCurrentGrant` in cli/bin.mjs) and the web `DELETE
 * /api/grants` have both done this for months. The worker's own kill switch —
 * reachable from Telegram — did not, because the worker package had no archive
 * path at all. This is that function, on this side of the fence.
 *
 * Returns the archived smart-account address, or null when there was nothing
 * to keep. Never throws: a kill switch must fire even if the disk is full.
 */
export function archiveCurrentGrant(): string | null {
  const file = process.env.MERRYMEN_GRANT_FILE ?? homePaths.grant();
  try {
    const raw = readFileSync(file, "utf8");
    const grant = JSON.parse(raw.replace(/^﻿/, "")) as StoredGrant;
    if (!grant?.smartAccount) return null;
    const dir = homePaths.grantsArchive();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The archived file carries a plaintext owner key — owner-only (0600),
    // never the default world-readable 0644.
    writeFileSync(path.join(dir, `${grant.smartAccount.toLowerCase()}.json`), raw, {
      encoding: "utf8",
      mode: 0o600,
    });
    return grant.smartAccount;
  } catch {
    return null; // nothing to keep
  }
}
