import { afterEach, expect, setDefaultTimeout, test } from "bun:test";

// Subprocess-heavy git integration tests brush past Bun's 5s default under load.
setDefaultTimeout(30_000);
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "cscript.ts");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
  tmpDirs.length = 0;
});

function sandbox(): string {
  const d = mkdtempSync(join(tmpdir(), "branch-cleanup-"));
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

function branchCleanup(cwd: string, args: string[], stdin?: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, "branch-cleanup", ...args], {
    cwd,
    env: { ...process.env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });

  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function localBranches(cwd: string): string[] {
  return git(cwd, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);
}

// Builds a repo with one branch in each category, checked out on master:
//   merged-branch      reachable from master
//   gone-branch        had an upstream that was deleted + pruned ([gone])
//   remote-branch      upstream still on origin, not merged
//   local-only-branch  never pushed
function buildRepo(): { repo: string; bare: string } {
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  commit(repo, "a.txt");

  const bare = sandbox();
  git(bare, "init", "--bare");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-u", "origin", "master");

  git(repo, "checkout", "-b", "merged-branch");
  commit(repo, "m.txt");
  git(repo, "checkout", "master");
  git(repo, "merge", "--no-ff", "-m", "merge merged-branch", "merged-branch");
  git(repo, "push", "origin", "master");

  git(repo, "checkout", "-b", "remote-branch");
  commit(repo, "r.txt");
  git(repo, "push", "-u", "origin", "remote-branch");

  git(repo, "checkout", "master");
  git(repo, "checkout", "-b", "gone-branch");
  commit(repo, "g.txt");
  git(repo, "push", "-u", "origin", "gone-branch");
  git(repo, "push", "origin", "--delete", "gone-branch");
  git(repo, "remote", "prune", "origin");

  git(repo, "checkout", "master");
  git(repo, "checkout", "-b", "local-only-branch");
  commit(repo, "l.txt");

  git(repo, "checkout", "master");

  return { repo, bare };
}

test("a numeric selection deletes that branch and leaves the rest", () => {
  const { repo } = buildRepo();

  // 1) merged-branch  2) gone-branch  3) remote-branch  4) local-only-branch
  const r = branchCleanup(repo, ["--no-fetch"], "2\n\n");

  expect(r.code).toBe(0);
  const remaining = localBranches(repo);
  expect(remaining).not.toContain("gone-branch");
  expect(remaining).toContain("merged-branch");
  expect(remaining).toContain("remote-branch");
  expect(remaining).toContain("local-only-branch");
  expect(remaining).toContain("master");
});

test("branches are grouped by category with a summary line", () => {
  const { repo } = buildRepo();

  const r = branchCleanup(repo, ["--no-fetch"], "\n");

  expect(r.out).toContain("Merged into master:");
  expect(r.out).toContain("Gone (remote deleted - merged via PR):");
  expect(r.out).toContain("Remote (still on origin, not merged):");
  expect(r.out).toContain("Local-only  ⚠ no backup:");
  expect(r.out).toContain("4 branch(es): 1 merged, 1 gone, 1 remote, 1 local-only");
  expect(r.out).toContain("Nothing selected.");
  expect(localBranches(repo)).toContain("gone-branch");
});

test("a category keyword selects every branch in that group", () => {
  const { repo } = buildRepo();

  const r = branchCleanup(repo, ["--no-fetch"], "merged\n\n");

  expect(r.code).toBe(0);
  const remaining = localBranches(repo);
  expect(remaining).not.toContain("merged-branch");
  expect(remaining).toContain("gone-branch");
  expect(remaining).toContain("remote-branch");
  expect(remaining).toContain("local-only-branch");
});

test("a mix of keyword and number selects both", () => {
  const { repo } = buildRepo();

  // merged-branch via keyword, remote-branch via its number (3)
  const r = branchCleanup(repo, ["--no-fetch"], "merged,3\n\n");

  expect(r.code).toBe(0);
  const remaining = localBranches(repo);
  expect(remaining).not.toContain("merged-branch");
  expect(remaining).not.toContain("remote-branch");
  expect(remaining).toContain("gone-branch");
  expect(remaining).toContain("local-only-branch");
});

test("'all' plus the local-only second confirm deletes every candidate", () => {
  const { repo } = buildRepo();

  // select all, confirm, then confirm the local-only force pass
  const r = branchCleanup(repo, ["--no-fetch"], "all\n\n\n");

  expect(r.code).toBe(0);
  expect(localBranches(repo)).toEqual(["master"]);
});

test("selecting a local-only branch requires a second confirm", () => {
  const { repo } = buildRepo();

  // 4) local-only-branch: confirm yes, then decline the local-only pass
  const r = branchCleanup(repo, ["--no-fetch"], "4\n\nn\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("no remote backup");
  expect(r.out).toContain("Aborted.");
  expect(localBranches(repo)).toContain("local-only-branch");
});

test("accepting the local-only second confirm deletes it", () => {
  const { repo } = buildRepo();

  const r = branchCleanup(repo, ["--no-fetch"], "4\n\n\n");

  expect(r.code).toBe(0);
  expect(localBranches(repo)).not.toContain("local-only-branch");
});

test("the current branch is never listed as a candidate", () => {
  const { repo } = buildRepo();
  git(repo, "checkout", "remote-branch");

  const r = branchCleanup(repo, ["--no-fetch"], "\n");

  expect(r.out).not.toContain("remote-branch");
  expect(localBranches(repo)).toContain("remote-branch");
});

test("an out-of-range number aborts without deleting", () => {
  const { repo } = buildRepo();
  const before = localBranches(repo);

  const r = branchCleanup(repo, ["--no-fetch"], "9\n");

  expect(r.out).toContain("Invalid selection.");
  expect(localBranches(repo)).toEqual(before);
});

test("an unknown keyword aborts without deleting", () => {
  const { repo } = buildRepo();
  const before = localBranches(repo);

  const r = branchCleanup(repo, ["--no-fetch"], "bogus\n");

  expect(r.out).toContain("Invalid selection.");
  expect(localBranches(repo)).toEqual(before);
});

test("rejects an unknown flag", () => {
  const repo = sandbox();

  const r = branchCleanup(repo, ["--bogus"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("Usage: cscript branch-cleanup");
});
