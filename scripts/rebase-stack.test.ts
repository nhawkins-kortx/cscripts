import { afterEach, expect, test } from "bun:test";
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
  const d = mkdtempSync(join(tmpdir(), "rebase-stack-"));
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

function rebaseStack(cwd: string, args: string[], stdin?: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, "rebase-stack", ...args], {
    cwd,
    env: { ...process.env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });

  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function buildFeature(opts: { origin: boolean }): { repo: string; bare: string | null } {
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

  git(repo, "checkout", "-b", "feature");
  commit(repo, "drop.txt");
  commit(repo, "c1.txt");
  commit(repo, "c2.txt");
  if (opts.origin) git(repo, "push", "-u", "origin", "feature");

  git(repo, "checkout", "master");
  commit(repo, "a2.txt");
  if (opts.origin) git(repo, "push", "origin", "master");

  git(repo, "checkout", "feature");

  return { repo, bare };
}

test("replays the top N commits onto the target and drops the rest", () => {
  const { repo } = buildFeature({ origin: false });

  const r = rebaseStack(repo, ["master", "2", "-y"]);

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "feature~2")).toBe(git(repo, "rev-parse", "master"));
  expect(git(repo, "rev-list", "--count", "master..feature")).toBe("2");
  expect(() => git(repo, "cat-file", "-e", "feature:drop.txt")).toThrow();
  expect(r.out).toContain("feature has no live remote to push.");
});

test("-y auto-pushes the feature branch with force-with-lease", () => {
  const { repo, bare } = buildFeature({ origin: true });

  const r = rebaseStack(repo, ["origin/master", "2", "-y"]);

  expect(r.code).toBe(0);
  expect(r.out).toContain("feature is on a remote.");
  expect(r.out).toContain("Pushing with --force-with-lease...");
  expect(git(bare!, "rev-parse", "feature")).toBe(git(repo, "rev-parse", "feature"));
});

test("skips the push when the feature's remote was deleted ([gone])", () => {
  const { repo, bare } = buildFeature({ origin: true });
  git(repo, "push", "origin", "--delete", "feature");

  const r = rebaseStack(repo, ["origin/master", "2", "-y"]);

  expect(r.code).toBe(0);
  expect(r.out).toContain("feature has no live remote to push.");
  expect(() => git(bare!, "rev-parse", "--verify", "feature")).toThrow();
});

test("declining the offer rebases locally but leaves the remote untouched", () => {
  const { repo, bare } = buildFeature({ origin: true });
  const originBefore = git(bare!, "rev-parse", "feature");

  const r = rebaseStack(repo, ["origin/master", "2"], "y\nn\n");

  expect(r.code).toBe(0);
  expect(r.out).not.toContain("Pushing with --force-with-lease...");
  expect(git(bare!, "rev-parse", "feature")).toBe(originBefore);
  expect(git(repo, "rev-parse", "feature~2")).toBe(git(repo, "rev-parse", "origin/master"));
});

test("an empty answer at the proceed prompt defaults to yes", () => {
  const { repo } = buildFeature({ origin: false });

  const r = rebaseStack(repo, ["master", "2"], "\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("[Y]/n");
  expect(git(repo, "rev-parse", "feature~2")).toBe(git(repo, "rev-parse", "master"));
});

test("an 'n' answer at the proceed prompt aborts", () => {
  const { repo } = buildFeature({ origin: false });
  const before = git(repo, "rev-parse", "feature");

  const r = rebaseStack(repo, ["master", "2"], "n\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("Aborted.");
  expect(git(repo, "rev-parse", "feature")).toBe(before);
});

test("an empty answer at the push prompt defaults to yes", () => {
  const { repo, bare } = buildFeature({ origin: true });

  const r = rebaseStack(repo, ["origin/master", "2"], "\n\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("Pushing with --force-with-lease...");
  expect(git(bare!, "rev-parse", "feature")).toBe(git(repo, "rev-parse", "feature"));
});

test("rejects an unknown flag", () => {
  const r = rebaseStack(sandbox(), ["origin/master", "feature", "2", "--push"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("Usage: cscript rebase-stack");
});
