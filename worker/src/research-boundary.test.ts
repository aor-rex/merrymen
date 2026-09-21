/**
 * BRAIN DOES NOT KNOW WHO SELLS US THE NEWS, AND NEITHER DOES A CHILD.
 *
 * Two boundaries, pinned here because both are invisible at the call site and
 * both are the kind that stay intact right up until somebody adds one
 * reasonable-looking import.
 *
 * THE VENDOR BOUNDARY. Everything above the adapter speaks `NewsItem` and
 * `NewsSentiment`. The reason is not tidiness: the first vendor is never the
 * last, and a name that has leaked into the desk, the prompt, the schema or a
 * persisted decision is a name that cannot be replaced without a migration.
 * The adapter is also where sanitisation happens, so a second vendor added
 * later cannot forget to do it — the normaliser is the only route in.
 *
 * THE CREDENTIAL BOUNDARY. The orchestrator fetches; children do not. That is
 * what makes "the Brain service never sees the news token" a property of the
 * process boundary rather than a claim about anybody's carefulness — a child
 * that never holds the value cannot put it in a prompt, a log line, a decision
 * row or a published thesis.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER_SRC = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(WORKER_SRC, "..", "..");

function walk(dir: string, keep: (f: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".git" || entry === "__pycache__") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, keep));
    else if (keep(entry)) out.push(full);
  }
  return out;
}

/** The vendor's name, in the two spellings that could appear. */
const VENDOR = /marketaux/i;

describe("the Brain service does not know the vendor exists", () => {
  it("no file under services/brain names it", () => {
    const files = walk(path.join(REPO, "services", "brain"), (f) =>
      /\.(py|md|toml|txt|json|yaml|yml)$/.test(f),
    );
    assert.ok(files.length > 10, "the walk found the service at all");
    const guilty = files.filter((f) => VENDOR.test(readFileSync(f, "utf8")));
    assert.deepEqual(guilty.map((f) => path.relative(REPO, f)), []);
  });

  it("nor does the vendor-neutral schema the rest of the worker speaks", () => {
    const src = readFileSync(path.join(WORKER_SRC, "research", "news.ts"), "utf8");
    assert.ok(!VENDOR.test(src), "news.ts must stay the shape, not the source");
  });

  it("only the adapter, its scheduler and their tests name it at all", () => {
    const allowed = new Set([
      "worker/src/research/marketaux.ts",
      "worker/src/research/marketaux.test.ts",
      "worker/src/research-pass.ts",
      "worker/src/research-pass.test.ts",
      "worker/src/research-boundary.test.ts",
      // The orchestrator reads the env var, which carries the name. It is the
      // one process that is allowed to know, because it is the one that pays.
      "worker/src/orchestrator.ts",
      "worker/src/orchestrator.test.ts",
    ]);
    const files = walk(path.join(REPO, "worker", "src"), (f) => f.endsWith(".ts"));
    const guilty = files
      .filter((f) => VENDOR.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((f) => !allowed.has(f));
    assert.deepEqual(guilty, [], "the vendor's name leaked out of the adapter");
  });

  it("and the child never imports the adapter", () => {
    // A child holds no token, so a child calling the adapter would produce a
    // `no-key` refusal per tick and a fetch attempt per agent. Both are wrong;
    // the import is what would make either possible.
    const src = readFileSync(path.join(WORKER_SRC, "index.ts"), "utf8");
    assert.ok(!/from "\.\/research\/marketaux"/.test(src));
    assert.ok(!/from "\.\/research-pass"/.test(src));
  });
});

describe("the news token cannot reach a child", () => {
  it("CHILD_SECRET_STRIP removes it", () => {
    const src = readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8");
    const i = src.indexOf("const CHILD_SECRET_STRIP = [");
    assert.ok(i > 0, "the strip list must exist for this to mean anything");
    const block = src.slice(i, src.indexOf("] as const;", i));
    for (const key of [
      "MERRYMEN_STORE_DEK",
      "MERRYMEN_SESSION_SECRET",
      "DATABASE_URL",
      "MERRYMEN_MARKETAUX_API_KEY",
    ]) {
      assert.ok(block.includes(key), key + " is not stripped from a child's environment");
    }
  });

  it("and only the orchestrator ever reads it", () => {
    const files = walk(path.join(REPO, "worker", "src"), (f) => f.endsWith(".ts"));
    const readers = files
      .filter((f) => readFileSync(f, "utf8").includes("MERRYMEN_MARKETAUX_API_KEY"))
      .map((f) => path.basename(f))
      .sort();
    assert.deepEqual(readers, ["orchestrator.ts", "research-boundary.test.ts"]);
  });

  it("the adapter takes the key as an argument and never from the environment", () => {
    // The difference matters: a module that reaches into process.env works
    // wherever it is imported, including inside a child that was never meant to
    // have it. A parameter cannot be supplied by a process that does not hold it.
    const src = readFileSync(path.join(WORKER_SRC, "research", "marketaux.ts"), "utf8");
    assert.ok(!/process\.env/.test(src), "the adapter must not read the environment");
  });
});

/**
 * THE SAME TWO BOUNDARIES, HELD AGAINST THE SECOND VENDOR.
 *
 * The builder directory arrived after the news vendor and is a different kind
 * of supplier — free at the anonymous tier, keyed on a contract, no daily
 * allowance to ration. None of that changes either boundary, and the point of
 * restating them here rather than generalising the block above is that a
 * generalised test is one somebody can satisfy by adding a name to a list. A
 * second vendor with its own section has to be argued for twice.
 */
const DIRECTORY = /hey ?research|heyresearch/i;

describe("the Brain service does not know the builder directory exists", () => {
  it("no file under services/brain names it", () => {
    const files = walk(path.join(REPO, "services", "brain"), (f) =>
      /\.(py|md|toml|txt|json|yaml|yml)$/.test(f),
    );
    assert.ok(files.length > 10, "the walk found the service at all");
    const guilty = files.filter((f) => DIRECTORY.test(readFileSync(f, "utf8")));
    assert.deepEqual(guilty.map((f) => path.relative(REPO, f)), []);
  });

  it("nor does the vendor-neutral schema the rest of the worker speaks", () => {
    const src = readFileSync(path.join(WORKER_SRC, "research", "builder.ts"), "utf8");
    assert.ok(!DIRECTORY.test(src), "builder.ts must stay the shape, not the source");
  });

  it("nor does the renderer that turns a record into a lens", () => {
    // The renderer is where the name would be most tempting and most damaging:
    // a block that says the directory's brand is a block that pins the prompt,
    // the persisted decision and every published thesis to one supplier.
    const src = readFileSync(path.join(WORKER_SRC, "research", "coin-builder.ts"), "utf8");
    assert.ok(!DIRECTORY.test(src), "the analyst is told a directory said it, never which one");
  });

  it("only the adapter and its own test name it at all", () => {
    const allowed = new Set([
      "worker/src/research/hey.ts",
      "worker/src/research/hey.test.ts",
      "worker/src/research-boundary.test.ts",
    ]);
    const files = walk(path.join(REPO, "worker", "src"), (f) => f.endsWith(".ts"));
    const guilty = files
      .filter((f) => DIRECTORY.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((f) => !allowed.has(f));
    assert.deepEqual(guilty, [], "the directory's name leaked out of the adapter");
  });
});

describe("the builder directory token cannot reach a child", () => {
  it("CHILD_SECRET_STRIP removes it", () => {
    const src = readFileSync(path.join(WORKER_SRC, "orchestrator.ts"), "utf8");
    const i = src.indexOf("const CHILD_SECRET_STRIP = [");
    assert.ok(i > 0, "the strip list must exist for this to mean anything");
    const block = src.slice(i, src.indexOf("] as const;", i));
    assert.ok(block.includes("MERRYMEN_HEY_API_KEY"), "the directory token is not stripped");
  });

  it("and nothing but the orchestrator may ever read it", () => {
    // Asserted BEFORE there is a reader, which is the useful moment: the first
    // caller to be written is the one that decides whether this boundary was a
    // design or a hope, and it will fail this test if it is a child.
    const files = walk(path.join(REPO, "worker", "src"), (f) => f.endsWith(".ts"));
    const readers = files
      .filter((f) => readFileSync(f, "utf8").includes("MERRYMEN_HEY_API_KEY"))
      .map((f) => path.basename(f))
      .sort();
    assert.deepEqual(readers, ["orchestrator.ts", "research-boundary.test.ts"]);
  });

  it("the adapter takes the key as an argument and never from the environment", () => {
    const src = readFileSync(path.join(WORKER_SRC, "research", "hey.ts"), "utf8");
    assert.ok(!/process\.env/.test(src), "the adapter must not read the environment");
  });
});
