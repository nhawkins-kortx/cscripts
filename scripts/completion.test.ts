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
  const d = mkdtempSync(join(tmpdir(), "completion-"));
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

function complete(cwd: string, name: string, words: string[]): { code: number; lines: string[] } {
  const r = Bun.spawnSync(["bun", CLI, "__complete", name, ...words], { cwd, env: { ...process.env } });

  return {
    code: r.exitCode,
    lines: r.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean),
  };
}

function repoWithRefs(): string {
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  writeFileSync(join(repo, "a.txt"), "a");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");

  const bare = sandbox();
  git(bare, "init", "--bare");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-u", "origin", "master");

  git(repo, "checkout", "-b", "feature");

  return repo;
}

test("restack completes refs (local + remote) at the target slot", () => {
  const repo = repoWithRefs();

  const { code, lines } = complete(repo, "restack", [""]);

  expect(code).toBe(0);
  expect(lines).toContain("master");
  expect(lines).toContain("feature");
  expect(lines).toContain("origin/master");
});

test("restack offers no completion past the target slot", () => {
  const repo = repoWithRefs();

  const { code, lines } = complete(repo, "restack", ["master", ""]);

  expect(code).toBe(0);
  expect(lines).toEqual([]);
});

test("rebase-stack completes refs at the feature slot", () => {
  const repo = repoWithRefs();

  const { code, lines } = complete(repo, "rebase-stack", ["origin/master", ""]);

  expect(code).toBe(0);
  expect(lines).toContain("master");
  expect(lines).toContain("feature");
});

test("rebase-stack offers no completion at the count slot", () => {
  const repo = repoWithRefs();

  const { code, lines } = complete(repo, "rebase-stack", ["origin/master", "feature", ""]);

  expect(code).toBe(0);
  expect(lines).toEqual([]);
});

test("a flag does not shift the positional slot", () => {
  const repo = repoWithRefs();

  const { code, lines } = complete(repo, "restack", ["-y", ""]);

  expect(code).toBe(0);
  expect(lines).toContain("master");
});

test("a script without a complete callback yields nothing", () => {
  const repo = repoWithRefs();

  const { code, lines } = complete(repo, "wt-remove", [""]);

  expect(code).toBe(0);
  expect(lines).toEqual([]);
});

test("an unknown script yields nothing and exits 0", () => {
  const repo = repoWithRefs();

  const { code, lines } = complete(repo, "does-not-exist", [""]);

  expect(code).toBe(0);
  expect(lines).toEqual([]);
});

test("outside a git repo yields nothing and exits 0", () => {
  const { code, lines } = complete(sandbox(), "restack", [""]);

  expect(code).toBe(0);
  expect(lines).toEqual([]);
});

function list(cwd: string): { code: number; out: string } {
  const r = Bun.spawnSync(["bun", CLI, "list"], { cwd, env: { ...process.env } });

  return { code: r.exitCode, out: r.stdout.toString() };
}

test("test files are not treated as scripts", () => {
  const repo = repoWithRefs();

  const r = list(repo);

  expect(r.code).toBe(0);
  expect(r.out).not.toContain(".test");
  expect(r.out).toContain("restack");

  expect(complete(repo, "restack.test", [""]).lines).toEqual([]);
});
