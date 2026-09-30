/**
 * Replace a file whole: a concurrent reader sees the old contents or the new
 * ones, never an empty or half-written file.
 *
 * WHY NOT writeFileSync. It opens with O_TRUNC and then writes, so between the
 * two — and all through a large write — a reader in another process gets an
 * empty or truncated file. For settings.json that is not a cosmetic glitch:
 * `resolveConfig` reads a file that does not parse as "no overrides" and runs
 * that tick on the defaults (paper, the default strategy, an empty allowlist),
 * and the hosted orchestrator rewrote every child's copy every fifteen seconds
 * while the child read it on every tick.
 *
 * Temp file in the SAME directory, then rename: rename is atomic within a
 * filesystem (POSIX and Windows alike), and a temp file anywhere else could
 * sit on another filesystem, where rename is a copy.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, lstatSync, openSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Resolve the destination even when a symlink names a file not created yet. */
function writeTarget(file: string): string {
  let target = file;
  const seen = new Set<string>();
  for (;;) {
    // Relative link destinations are relative to the link's real directory,
    // including when the path to that directory itself traverses a symlink.
    target = path.join(realpathSync(path.dirname(target)), path.basename(target));
    if (seen.has(target) || seen.size >= 40) {
      throw Object.assign(new Error(`Too many symbolic links: ${file}`), { code: "ELOOP" });
    }
    seen.add(target);
    let stat;
    try {
      stat = lstatSync(target);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return target;
      throw e;
    }
    if (!stat.isSymbolicLink()) return target;
    target = path.resolve(path.dirname(target), readlinkSync(target));
  }
}

/**
 * Write `data` to `file` atomically, with exactly `mode` (default 0600 — every
 * file a home holds is owner-only, and settings.json carries plaintext keys).
 * Throws on failure, having removed its temp file; `file` is then untouched.
 */
export function writeFileAtomicSync(file: string, data: string, mode = 0o600): void {
  // THROUGH A SYMLINK, NOT OVER IT. writeFileSync followed a link to the file
  // it names; rename would replace the link itself with a regular file, and a
  // self-hosted owner who keeps settings.json elsewhere would lose the link.
  const target = writeTarget(file);
  // pid AND random: two processes write the same settings.json (orchestrator
  // and child), and pids repeat across containers and restarts. Never matched
  // by anything that lists a home — every lister filters on its own names.
  const tmp = path.join(path.dirname(target), `${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | null = null;
  let created = false;
  try {
    // "wx": a file this call created or an error. open() applies `mode` only
    // when it creates, so a leftover of the same name must not be reused.
    fd = openSync(tmp, "wx", mode);
    created = true;
    try {
      // Exactly `mode`, not `mode & ~umask`, before the file is visible.
      fchmodSync(fd, mode);
    } catch {
      /* non-POSIX — the mode on open is the best there is */
    }
    writeFileSync(fd, data, "utf8");
    try {
      // Durability, not atomicity: rename alone keeps a reader off half a
      // file. This keeps a crash straight after from leaving an empty one.
      fsyncSync(fd);
    } catch {
      /* a filesystem that cannot fsync still gets the atomic replace */
    }
    closeSync(fd);
    fd = null;
    renameSync(tmp, target);
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already failing — the original error is the one to report */
      }
    }
    // Only a temp file this call created: on EEXIST the name is someone else's.
    if (created) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the original error is the one to report */
      }
    }
    throw e;
  }
}
