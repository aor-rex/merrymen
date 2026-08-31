/**
 * COMMANDS REACH A WORKER AS FILES IN ITS OWN HOME.
 *
 * The first version of this put the command in a table and had the worker poll
 * it, on the reasoning that "everything the dashboard has ever told the worker
 * goes through a store the other side polls". That reasoning was wrong, and an
 * adversarial review caught it before it shipped.
 *
 * What actually exists: the orchestrator MATERIALISES state into each child's
 * private home — `writeGrantForChild`, `writeSettingsForChild` — and the ledger
 * mirror runs strictly child → shared, one direction. There is no shared → child
 * path in this repo at all. Children have DATABASE_URL stripped
 * (CHILD_SECRET_STRIP) precisely so they cannot reach the shared database, which
 * is a custody decision, not an oversight. So a hosted command written to
 * Postgres and polled from a child's private sqlite is two different databases,
 * and nothing would ever have been claimed.
 *
 * This is the existing pattern instead:
 *
 *   web ──(shared table, hosted only)──▶ orchestrator ──(file)──▶ child
 *   child ──(result file)──▶ orchestrator ──(shared table)──▶ web
 *
 * Self-hosted there is no orchestrator and no shared table: the web process and
 * the worker share one MERRYMEN_HOME, so the web writes the file directly and
 * the middle two hops vanish. One drain path, two ways in.
 *
 * THE CLAIM IS AN UNLINK. `rm` on a file is atomic on every filesystem this
 * runs on, so the worker that successfully deletes the command owns it and any
 * other reader gets ENOENT. That is a stronger guarantee than the SELECT-then-
 * UPDATE it replaces, and it needs no transaction — which matters, because the
 * thing being guarded spends gas and at-most-once is the only acceptable
 * semantics.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** One instruction, as it sits on disk. */
export interface FileCommand {
  id: string;
  kind: string;
  /** Milliseconds. Seconds would make two commands in one second unordered. */
  at: number;
}

/** What the worker decided, on its way back. */
export interface FileCommandResult {
  id: string;
  ok: boolean;
  line: string;
  at: number;
}

const DIR = "commands";

/** Where a home keeps its pending instructions. */
export function commandDir(home: string): string {
  return path.join(home, DIR);
}

/** Drop a command into a home. Called by the orchestrator, or by a self-hosted web. */
export function writeCommand(home: string, cmd: FileCommand): void {
  const dir = commandDir(home);
  mkdirSync(dir, { recursive: true });
  // Written to a temp name and renamed, so a reader can never observe a
  // half-written command — rename is atomic within a filesystem, write is not.
  const tmp = path.join(dir, `.${cmd.id}.tmp`);
  writeFileSync(tmp, JSON.stringify(cmd), "utf8");
  renameSync(tmp, path.join(dir, `${cmd.id}.json`));
}

/**
 * Take the oldest pending command, or null.
 *
 * THE UNLINK IS THE CLAIM. Reading then deleting means a crash between the two
 * replays the command; deleting then acting means a crash loses it. Losing a
 * probe is a button the owner presses again; replaying one spends gas nobody
 * asked to spend twice. So: delete first, and only then act.
 */
export function claimCommandFile(home: string): FileCommand | null {
  const dir = commandDir(home);
  if (!existsSync(dir)) return null;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json") && !n.endsWith(".done.json"));
  } catch {
    return null;
  }
  if (names.length === 0) return null;

  // Oldest first, by the timestamp inside rather than by mtime: a file copied
  // between homes keeps its meaning, and mtime does not survive that.
  const parsed = names
    .map((n) => {
      try {
        return JSON.parse(readFileSync(path.join(dir, n), "utf8")) as FileCommand;
      } catch {
        // Unreadable command: remove it rather than blocking the queue behind
        // something no worker will ever be able to run.
        try {
          unlinkSync(path.join(dir, n));
        } catch {
          /* already gone */
        }
        return null;
      }
    })
    .filter((c): c is FileCommand => !!c && typeof c.id === "string" && typeof c.kind === "string");
  if (parsed.length === 0) return null;
  parsed.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  for (const cmd of parsed) {
    try {
      unlinkSync(path.join(dir, `${cmd.id}.json`));
      return cmd; // we deleted it, so it is ours
    } catch {
      // Somebody else got there first — try the next one rather than giving up,
      // because "the queue is empty" and "one entry was taken" are different.
    }
  }
  return null;
}

/** Leave the outcome where the orchestrator will find it. */
export function writeCommandResult(home: string, r: FileCommandResult): void {
  const dir = commandDir(home);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${r.id}.done.tmp`);
  writeFileSync(tmp, JSON.stringify(r), "utf8");
  renameSync(tmp, path.join(dir, `${r.id}.done.json`));
}

/** Collect and remove finished results. Called by the orchestrator. */
export function drainCommandResults(home: string): FileCommandResult[] {
  const dir = commandDir(home);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".done.json"));
  } catch {
    return [];
  }
  const out: FileCommandResult[] = [];
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      const r = JSON.parse(readFileSync(f, "utf8")) as FileCommandResult;
      if (typeof r.id === "string") out.push(r);
    } catch {
      /* unreadable result — dropped with the file below */
    }
    try {
      unlinkSync(f);
    } catch {
      /* already gone */
    }
  }
  return out;
}
