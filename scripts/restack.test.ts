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

test("rejects an unknown flag", () => {
  const repo = sandbox();

  const r = restack(repo, ["origin/master", "--push"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("Usage: cscript restack");
});
