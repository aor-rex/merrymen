/**
 * A FOLLOWED AGENT'S PUBLISHED THINKING, MATERIALISED INTO A CHILD'S HOME.
 *
 * The transport half of the wire. The orchestrator resolves an owner's follows
 * to slugs, the slugs to accounts, the accounts to theses, and writes the result
 * here; the child's desk reads it as one more piece of evidence.
 *
 * NOT CHILD-SIDE HTTP, for four reasons, and the first is the one that matters:
 *
 *   1. It would put a general-purpose HTTP client on the trading path whose
 *      target is configuration. `desk.ts` exists in the shape it does
 *      specifically so the model cannot steer egress — `read_link` is index-
 *      addressed for this reason — and a fetch whose URL comes from settings
 *      undoes that in one line.
 *   2. A hanging fetch inside a tool call burns the window's step budget. An
 *      absent file is synchronously an empty list.
 *   3. It is the pattern this repo already has twice: `writeGrantForChild` and
 *      `writeSettingsForChild`. `command-files.ts` records that there is no
 *      shared → child path in this codebase at all, and children have
 *      DATABASE_URL stripped precisely so they cannot reach shared Postgres.
 *   4. It makes the sanitisation boundary a COMPILE-TIME fact. The orchestrator
 *      can only write what it read through `publishableThesis`, so the peer file
 *      cannot contain anything the public feed would not already publish.
 *
 * THE ISOLATION ARGUMENT, stated because a reviewer will ask. This never widens
 * a ledger read: child reads still filter on `agentId`, the child still cannot
 * reach shared Postgres, and what crosses is a file containing only the output
 * of `publishableThesis` — the same bytes an anonymous browser already gets from
 * /api/theses. The invariant is "an agent may read another agent's PUBLISHED
 * thesis and nothing else", and it is pinned in peer-files.test.ts.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PublicThesis } from "./thesis-policy";

const FILE = "peers.json";

export interface PeerFile {
  /** Unix seconds the orchestrator wrote this. Staleness is the reader's call. */
  at: number;
  /** Published theses from the agents this owner wired in, newest first. */
  theses: PublicThesis[];
}

export function peerFilePath(home: string): string {
  return path.join(home, FILE);
}

/**
 * Write a child's peer file. Called by the orchestrator only.
 *
 * Temp-then-rename, so a desk reading mid-write can never observe half a file —
 * rename is atomic within a filesystem and write is not. Mode 0600 like every
 * other file the orchestrator materialises, even though nothing here is secret:
 * the child home is the tenant's, and a uniform mode is one less thing to get
 * wrong later when something in it is.
 */
export function writePeersForChild(home: string, file: PeerFile): void {
  mkdirSync(home, { recursive: true });
  const tmp = path.join(home, `.${FILE}.tmp`);
  writeFileSync(tmp, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, peerFilePath(home));
}

/**
 * Read a child's peer file. NEVER THROWS.
 *
 * Absent, unreadable, malformed and empty all mean the same thing to the desk:
 * there is nothing from peers this window. A throw here would take down a tick
 * over a feature that is meant to be additional evidence, which is the wrong
 * trade in every direction.
 */
export function readPeers(home: string): PeerFile {
  const empty: PeerFile = { at: 0, theses: [] };
  try {
    const raw = JSON.parse(readFileSync(peerFilePath(home), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return empty;
    const f = raw as Partial<PeerFile>;
    if (!Array.isArray(f.theses)) return empty;
    return { at: Number(f.at) || 0, theses: f.theses };
  } catch {
    return empty;
  }
}
