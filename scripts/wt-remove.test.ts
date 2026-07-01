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
  const d = mkdtempSync(join(tmpdir(), "wt-remove-"));
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

function wtRemove(cwd: string, stdin: string): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", CLI, "wt-remove"], {
    cwd,
    env: { ...process.env },
    stdin: new TextEncoder().encode(stdin),
  });

  return { code: r.exitCode, out: r.stdout.toString() };
}

function repoWithWorktree(opts: { dirty: boolean }): { repo: string; wt: string } {
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");

  const wt = join(sandbox(), "wt1");
  git(repo, "worktree", "add", wt, "-b", "feat");
  if (opts.dirty) writeFileSync(join(wt, "dirty.txt"), "dirty");

  return { repo, wt };
}

function worktreePaths(repo: string): string {
  return git(repo, "worktree", "list");
}

test("an empty answer at the remove prompt defaults to yes", () => {
  const { repo, wt } = repoWithWorktree({ dirty: false });

  const r = wtRemove(repo, "1\n\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("[Y]/n");
  expect(worktreePaths(repo)).not.toContain(wt);
});

test("an 'n' answer at the remove prompt aborts", () => {
  const { repo, wt } = repoWithWorktree({ dirty: false });

  const r = wtRemove(repo, "1\nn\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("Aborted.");
  expect(worktreePaths(repo)).toContain(wt);
});

test("an empty answer at the force-remove prompt defaults to yes", () => {
  const { repo, wt } = repoWithWorktree({ dirty: true });

  const r = wtRemove(repo, "1\n\n\n\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("Force-removed");
  expect(worktreePaths(repo)).not.toContain(wt);
});
