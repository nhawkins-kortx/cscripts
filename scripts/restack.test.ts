import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

// Subprocess-heavy git integration tests brush past Bun's 5s default under load.
setDefaultTimeout(30_000);
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cscript.ts");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "restack-"));
  tmpDirs.push(d);

  return d;
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr.toString()}`);
  }

  return r.stdout.toString().trim();
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), file);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", `add ${file}`);
}

function restack(cwd: string, args: string[], stdin?: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, "restack", ...args], {
    cwd,
    env: { ...process.env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });

  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function buildStack(opts: { origin: boolean }): { repo: string; bare: string | null } {
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  commit(repo, "a.txt");

  let bare: string | null = null;
  if (opts.origin) {
    bare = sandbox();
    git(bare, "init", "--bare");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-u", "origin", "master");
  }

  git(repo, "checkout", "-b", "B1");
  commit(repo, "b1.txt");
  git(repo, "checkout", "-b", "B2");
  commit(repo, "b2.txt");
  git(repo, "checkout", "-b", "B3");
  commit(repo, "b3.txt");
  if (opts.origin) git(repo, "push", "-u", "origin", "B1", "B2", "B3");

  git(repo, "checkout", "master");
  commit(repo, "a2.txt");
  if (opts.origin) git(repo, "push", "origin", "master");

  git(repo, "checkout", "B3");

  return { repo, bare };
}

// A stack sitting on a base branch whose tip was rewritten (rebased/amended),
// so the old fork point is no longer an ancestor of the new base tip.
//
//   master ── a.txt
//     └─ base ── base1.txt (O)          then rewritten to base1' (O', diverges from O)
//          └─ B1 ── b1.txt              (B1 owns 1 commit)
//               └─ B2 ── b2.txt         (B2 owns 1 commit)
function buildMovedBaseStack(
  opts: { origin: boolean; b1Commits?: number; b2?: boolean },
): { repo: string; bare: string | null } {
  const b1Commits = opts.b1Commits ?? 1;
  const withB2 = opts.b2 ?? true;
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  commit(repo, "a.txt");

  let bare: string | null = null;
  if (opts.origin) {
    bare = sandbox();
    git(bare, "init", "--bare");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-u", "origin", "master");
  }

  git(repo, "checkout", "-b", "base");
  commit(repo, "base1.txt");
  if (opts.origin) git(repo, "push", "-u", "origin", "base");

  git(repo, "checkout", "-b", "B1");
  commit(repo, "b1.txt");
  for (let i = 1; i < b1Commits; i++) commit(repo, `b1-extra${i}.txt`);
  const pushBranches = ["B1"];
  if (withB2) {
    git(repo, "checkout", "-b", "B2");
    commit(repo, "b2.txt");
    pushBranches.push("B2");
  }
  if (opts.origin) git(repo, "push", "-u", "origin", ...pushBranches);

  git(repo, "checkout", "base");
  writeFileSync(join(repo, "base1.txt"), "base1-rewritten");
  git(repo, "add", "-A");
  git(repo, "commit", "--amend", "-m", "rewritten base1");
  if (opts.origin) git(repo, "push", "--force", "origin", "base");

  git(repo, "checkout", withB2 ? "B2" : "B1");

  return { repo, bare };
}

// A bottom branch whose own commit edits the same file the base rewrite touched,
// so replaying it onto the rewritten base conflicts.
function buildConflictingCountStack(): { repo: string } {
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  commit(repo, "a.txt");

  git(repo, "checkout", "-b", "base");
  writeFileSync(join(repo, "shared.txt"), "original");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "add shared.txt");

  git(repo, "checkout", "-b", "B1");
  writeFileSync(join(repo, "shared.txt"), "b1-change");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "B1 edits shared.txt");
  git(repo, "checkout", "-b", "B2");
  commit(repo, "b2.txt");

  git(repo, "checkout", "base");
  writeFileSync(join(repo, "shared.txt"), "base-rewritten");
  git(repo, "add", "-A");
  git(repo, "commit", "--amend", "-m", "rewritten shared.txt");

  git(repo, "checkout", "B2");

  return { repo };
}

test("with a count, replays each branch's own commit onto a rewritten base", () => {
  const { repo } = buildMovedBaseStack({ origin: false });

  const r = restack(repo, ["base", "1", "-y"]);

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "B1~1")).toBe(git(repo, "rev-parse", "base"));
  expect(git(repo, "rev-parse", "B2~1")).toBe(git(repo, "rev-parse", "B1"));
  expect(() => git(repo, "merge-base", "--is-ancestor", "base", "B2")).not.toThrow();
  expect(git(repo, "log", "--oneline", "B2")).toContain("b2.txt");
  expect(git(repo, "log", "--oneline", "B2")).toContain("b1.txt");
});

test("drops the stale base commit below the cut", () => {
  const { repo } = buildMovedBaseStack({ origin: false });
  const staleBase = git(repo, "rev-parse", "B1~1");

  const r = restack(repo, ["base", "1", "-y"]);

  expect(r.code).toBe(0);
  expect(() => git(repo, "merge-base", "--is-ancestor", staleBase, "B2")).toThrow();
});

test("~N count parses identically to N", () => {
  const { repo } = buildMovedBaseStack({ origin: false });

  const r = restack(repo, ["base", "~1", "-y"]);

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "B1~1")).toBe(git(repo, "rev-parse", "base"));
  expect(git(repo, "rev-parse", "B2~1")).toBe(git(repo, "rev-parse", "B1"));
});

test("previews the commits dropped below the cut", () => {
  const { repo } = buildMovedBaseStack({ origin: false });

  const r = restack(repo, ["base", "1"], "n\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("Dropping");
  expect(r.out).toContain("base1.txt");
});

test("rejects a non-integer count", () => {
  const { repo } = buildMovedBaseStack({ origin: false });
  const before = git(repo, "rev-parse", "B2");

  const r = restack(repo, ["base", "abc"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("Invalid count");
  expect(git(repo, "rev-parse", "B2")).toBe(before);
});

test("rejects a count larger than the bottom branch's history", () => {
  const { repo } = buildMovedBaseStack({ origin: false });
  const before = git(repo, "rev-parse", "B2");

  const r = restack(repo, ["base", "99", "-y"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("fewer than");
  expect(git(repo, "rev-parse", "B2")).toBe(before);
});

test("-y auto-pushes after a count restack onto a rewritten base", () => {
  const { repo, bare } = buildMovedBaseStack({ origin: true });

  const r = restack(repo, ["base", "1", "-y"]);

  expect(r.code).toBe(0);
  expect(r.out).toContain("Pushing with --force-with-lease...");
  expect(r.out).toContain("Done. To undo:");
  for (const b of ["B1", "B2"]) {
    expect(git(bare!, "rev-parse", b)).toBe(git(repo, "rev-parse", b));
    expect(r.out).toContain(`git branch -f ${b}`);
  }
});

test("threads a count > 1 through to the bottom cut", () => {
  const { repo } = buildMovedBaseStack({ origin: false, b1Commits: 2 });

  const r = restack(repo, ["base", "2", "-y"]);

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "B1~2")).toBe(git(repo, "rev-parse", "base"));
  expect(git(repo, "rev-parse", "B2~1")).toBe(git(repo, "rev-parse", "B1"));
  expect(git(repo, "log", "--oneline", "B1")).toContain("b1.txt");
  expect(git(repo, "log", "--oneline", "B1")).toContain("b1-extra1.txt");
});

test("handles a single-branch chain with a count (B1 is the top)", () => {
  const { repo } = buildMovedBaseStack({ origin: false, b2: false });
  const staleBase = git(repo, "rev-parse", "B1~1");

  const r = restack(repo, ["base", "1", "-y"]);

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "B1~1")).toBe(git(repo, "rev-parse", "base"));
  expect(() => git(repo, "merge-base", "--is-ancestor", staleBase, "B1")).toThrow();
});

test("a conflict during a count restack drops into manual guidance", () => {
  const { repo } = buildConflictingCountStack();

  // proceed (-y), then the conflict-recovery prompt gets a blank line -> resolve manually
  const r = restack(repo, ["base", "1", "-y"], "\n");

  expect(r.code).toBe(1);
  expect(r.err).toContain("git rebase --continue");
});

test("surfaces a stray branch on a stale base commit as the visible chain bottom", () => {
  const { repo } = buildMovedBaseStack({ origin: false });
  git(repo, "branch", "stray", "B1~1");

  const r = restack(repo, ["base", "1"], "n\n");

  // inferChain pulls the stray in as the bottom; the design's contract is that this
  // is surfaced (strict inference + a loud warning) rather than re-inferred away.
  expect(r.code).toBe(0);
  expect(r.out).toContain("stray → B1 → B2");
  expect(r.err).toContain("no-op cut");
  expect(r.err).toContain("stray");
});

test("does not warn when the count genuinely drops stale commits", () => {
  const { repo } = buildMovedBaseStack({ origin: false });

  const r = restack(repo, ["base", "1"], "n\n");

  expect(r.err).not.toContain("no-op cut");
});

test("restores a dirty working tree via autostash after a count restack", () => {
  const { repo } = buildMovedBaseStack({ origin: false });
  // a.txt exists on every branch, so autostash round-trips it across the chain.
  writeFileSync(join(repo, "a.txt"), "dirty-change");

  const r = restack(repo, ["base", "1", "-y"]);

  expect(r.code).toBe(0);
  expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("dirty-change");
});

test("count omitted preserves the plain (no --onto, no drop) bottom step", () => {
  const { repo } = buildStack({ origin: false });

  const r = restack(repo, ["master"], "n\n");

  expect(r.code).toBe(0);
  expect(r.out).not.toContain("Dropping");
  expect(r.out).not.toContain("--onto master");
});

test("rejects zero and fractional counts with a clear message", () => {
  for (const bad of ["0", "1.5"]) {
    const { repo } = buildMovedBaseStack({ origin: false });
    const before = git(repo, "rev-parse", "B2");

    const r = restack(repo, ["base", bad]);

    expect(r.code).toBe(1);
    expect(r.err).toContain("Invalid count");
    expect(git(repo, "rev-parse", "B2")).toBe(before);
  }
});

test("treats a leading-dash count as an unknown flag and does not mutate", () => {
  const { repo } = buildMovedBaseStack({ origin: false });
  const before = git(repo, "rev-parse", "B2");

  const r = restack(repo, ["base", "-1"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("Unknown flag: -1");
  expect(git(repo, "rev-parse", "B2")).toBe(before);
});

test("count is order-independent relative to -y", () => {
  for (const args of [["base", "-y", "1"], ["-y", "base", "1"]]) {
    const { repo } = buildMovedBaseStack({ origin: false });

    const r = restack(repo, args);

    expect(r.code).toBe(0);
    expect(git(repo, "rev-parse", "B1~1")).toBe(git(repo, "rev-parse", "base"));
    expect(git(repo, "rev-parse", "B2~1")).toBe(git(repo, "rev-parse", "B1"));
  }
});

test("rejects too many positionals", () => {
  const { repo } = buildMovedBaseStack({ origin: false });
  const before = git(repo, "rev-parse", "B2");

  const r = restack(repo, ["base", "1", "extra"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("Usage: cscript restack");
  expect(git(repo, "rev-parse", "B2")).toBe(before);
});

test("usage and help advertise the optional count", () => {
  const repo = sandbox();

  const usage = restack(repo, []);
  expect(usage.err).toContain("[count]");

  const help = Bun.spawnSync(["bun", CLI, "restack", "help"], { cwd: repo });
  const helpText = help.stdout.toString();
  expect(helpText).toContain("[count]");
  expect(helpText).toContain("rewritten");
});

test("~N threads a count > 1 through (parity with the N form)", () => {
  const { repo } = buildMovedBaseStack({ origin: false, b1Commits: 2 });

  const r = restack(repo, ["base", "~2", "-y"]);

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "B1~2")).toBe(git(repo, "rev-parse", "base"));
});

test("rebases the whole chain onto the advanced target", () => {
  const { repo } = buildStack({ origin: false });

  const r = restack(repo, ["master", "-y"]);

  expect(r.code).toBe(0);
  expect(() => git(repo, "merge-base", "--is-ancestor", "master", "B3")).not.toThrow();
  expect(git(repo, "rev-parse", "B1~1")).toBe(git(repo, "rev-parse", "master"));
});

test("with no live remotes, reports nothing to push", () => {
  const { repo } = buildStack({ origin: false });

  const r = restack(repo, ["master", "-y"]);

  expect(r.out).toContain("No branches with live remotes to push.");
  expect(r.out).toContain("Done. To undo:");
});

test("-y auto-pushes every live-remote branch with force-with-lease", () => {
  const { repo, bare } = buildStack({ origin: true });

  const r = restack(repo, ["origin/master", "-y"]);

  expect(r.code).toBe(0);
  expect(r.out).toContain("These branches are on a remote:\n  B1\n  B2\n  B3");
  expect(r.out).toContain("Pushing with --force-with-lease...");
  for (const b of ["B1", "B2", "B3"]) {
    expect(git(bare!, "rev-parse", b)).toBe(git(repo, "rev-parse", b));
  }
});

test("skips a branch whose remote was deleted ([gone])", () => {
  const { repo, bare } = buildStack({ origin: true });
  git(repo, "push", "origin", "--delete", "B2");

  const r = restack(repo, ["origin/master", "-y"]);

  expect(r.code).toBe(0);
  expect(r.out).toContain("These branches are on a remote:\n  B1\n  B3");
  expect(() => git(bare!, "rev-parse", "--verify", "B2")).toThrow();
  expect(git(bare!, "rev-parse", "B1")).toBe(git(repo, "rev-parse", "B1"));
  expect(git(bare!, "rev-parse", "B3")).toBe(git(repo, "rev-parse", "B3"));
});

test("declining the offer rebases locally but leaves remotes untouched", () => {
  const { repo, bare } = buildStack({ origin: true });
  const originB1Before = git(bare!, "rev-parse", "B1");

  const r = restack(repo, ["origin/master"], "y\nn\n");

  expect(r.code).toBe(0);
  expect(r.out).not.toContain("Pushing with --force-with-lease...");
  expect(git(bare!, "rev-parse", "B1")).toBe(originB1Before);
  expect(git(repo, "rev-parse", "B1~1")).toBe(git(repo, "rev-parse", "origin/master"));
});

test("an empty answer at the proceed prompt defaults to yes", () => {
  const { repo } = buildStack({ origin: false });

  const r = restack(repo, ["master"], "\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("[Y]/n");
  expect(git(repo, "rev-parse", "B1~1")).toBe(git(repo, "rev-parse", "master"));
});

test("an 'n' answer at the proceed prompt aborts", () => {
  const { repo } = buildStack({ origin: false });
  const before = git(repo, "rev-parse", "B1");

  const r = restack(repo, ["master"], "n\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("Aborted.");
  expect(git(repo, "rev-parse", "B1")).toBe(before);
});

test("an empty answer at the push prompt defaults to yes", () => {
  const { repo, bare } = buildStack({ origin: true });

  const r = restack(repo, ["origin/master"], "\n\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("Pushing with --force-with-lease...");
  expect(git(bare!, "rev-parse", "B1")).toBe(git(repo, "rev-parse", "B1"));
});

test("rejects an unknown flag", () => {
  const repo = sandbox();

  const r = restack(repo, ["origin/master", "--push"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("Usage: cscript restack");
});
