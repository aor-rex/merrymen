import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claimCommandFile,
  commandDir,
  drainCommandResults,
  writeCommand,
  writeCommandResult,
} from "./command-files";

/**
 * THE SEAM THE FIRST VERSION NEVER CROSSED.
 *
 * v1 put commands in a table and had the worker poll it. Hosted, the dashboard
 * writes shared Postgres and a child reads its own sqlite — CHILD_SECRET_STRIP
 * removes DATABASE_URL on purpose — so the row and the query were in different
 * databases and nothing would ever have been claimed.
 *
 * Its test suite passed. It called enqueue and claim against ONE store handle
 * with ONE constant, which can never catch a caller using a different key or a
 * different database. These tests use real directories and a real unlink, which
 * is the actual mechanism.
 */

function tmpHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "merrymen-cmdfile-"));
}

test("a command written to a home is claimed from that home", () => {
  const home = tmpHome();
  try {
    writeCommand(home, { id: "a", kind: "selftest", at: 1 });
    const got = claimCommandFile(home);
    assert.equal(got?.id, "a");
    assert.equal(got?.kind, "selftest");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("THE UNLINK IS THE CLAIM — a second reader gets nothing", () => {
  // This is the whole concurrency story, and it is stronger than the
  // SELECT-then-UPDATE it replaces: rm is atomic, so exactly one caller can
  // succeed, with no transaction and no shared connection.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "a", kind: "selftest", at: 1 });
    assert.equal(claimCommandFile(home)?.id, "a");
    assert.equal(claimCommandFile(home), null, "a claimed command must never be handed out twice");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("commands for one home are invisible to another", () => {
  // The tenant-isolation property, done by the filesystem rather than by a
  // WHERE clause somebody has to remember to write.
  const a = tmpHome();
  const b = tmpHome();
  try {
    writeCommand(a, { id: "mine", kind: "selftest", at: 1 });
    assert.equal(claimCommandFile(b), null);
    assert.equal(claimCommandFile(a)?.id, "mine");
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test("oldest first, by the timestamp INSIDE the file", () => {
  // Not by mtime: a command is copied from the shared database into a home by
  // the orchestrator, and mtime describes that copy rather than the request.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "second", kind: "selftest", at: 2_000 });
    writeCommand(home, { id: "first", kind: "selftest", at: 1_000 });
    assert.equal(claimCommandFile(home)?.id, "first");
    assert.equal(claimCommandFile(home)?.id, "second");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an unreadable command is removed rather than blocking the queue", () => {
  // A corrupt file that stayed would wedge every later command behind it
  // forever, which is a worse failure than losing the one nobody can run.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "good", kind: "selftest", at: 2 });
    writeFileSync(path.join(commandDir(home), "junk.json"), "{not json", "utf8");
    assert.equal(claimCommandFile(home)?.id, "good");
    assert.equal(
      readdirSync(commandDir(home)).some((n) => n === "junk.json"),
      false,
      "the unreadable file is gone, not skipped forever",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("results travel back and are drained exactly once", () => {
  const home = tmpHome();
  try {
    writeCommandResult(home, { id: "a", ok: true, line: "PASSED — it landed", at: 5 });
    const got = drainCommandResults(home);
    assert.equal(got.length, 1);
    assert.equal(got[0]!.id, "a");
    assert.equal(got[0]!.ok, true);
    assert.match(got[0]!.line, /PASSED/);
    assert.deepEqual(drainCommandResults(home), [], "draining removes them");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a result is never mistaken for a command", () => {
  // Both live in the same directory, and `.done.json` also ends in `.json`.
  // Confusing the two would have the worker try to execute its own answer.
  const home = tmpHome();
  try {
    writeCommandResult(home, { id: "a", ok: true, line: "done", at: 5 });
    assert.equal(claimCommandFile(home), null, "a result is not a pending command");
    assert.equal(drainCommandResults(home).length, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a half-written file is never observed — write then rename", () => {
  // The temp name is dotted and does not end in .json, so a reader scanning
  // mid-write sees nothing rather than a truncated command.
  const home = tmpHome();
  try {
    writeCommand(home, { id: "a", kind: "selftest", at: 1 });
    const names = readdirSync(commandDir(home));
    assert.deepEqual(names, ["a.json"], "no temp file left behind");
    assert.equal(names.some((n) => n.startsWith(".")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("an empty or missing home is empty, not an error", () => {
  const home = tmpHome();
  try {
    assert.equal(claimCommandFile(home), null);
    assert.deepEqual(drainCommandResults(home), []);
    assert.equal(claimCommandFile(path.join(home, "nope")), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
