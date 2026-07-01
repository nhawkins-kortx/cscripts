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
  const d = mkdtempSync(join(tmpdir(), "amend-stack-"));
  tmpDirs.push(d);

  return d;
}

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${r.stderr.toString()}`);

  return r.stdout.toString().trim();
}

function amendStack(cwd: string, args: string[], stdin?: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, "amend-stack", ...args], {
    cwd,
    env: { ...process.env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });

  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function commit(cwd: string, file: string, content = file): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", `add ${file}`);
}

function initRepo(): string {
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  commit(repo, "base.txt");

  return repo;
}

test("rejects an unknown flag", () => {
  const repo = sandbox();
  git(repo, "init", "-b", "master");

  const r = amendStack(repo, ["--bogus"]);

  expect(r.code).toBe(1);
  expect(r.err).toContain("Usage: cscript amend-stack");
});

test("linear: amends bottom with staged change and replays the dependent", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");

  const bottomOld = git(repo, "rev-parse", "bottom");
  writeFileSync(join(repo, "extra.txt"), "extra");
  git(repo, "add", "extra.txt");

  const r = amendStack(repo, [], "\n1\n"); // confirm plan (=yes), keep message

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "bottom")).not.toBe(bottomOld);
  expect(git(repo, "cat-file", "-t", `bottom:extra.txt`)).toBe("blob");
  expect(git(repo, "rev-parse", "top~1")).toBe(git(repo, "rev-parse", "bottom"));
  expect(git(repo, "cat-file", "-t", `top:top.txt`)).toBe("blob");
  expect(() => git(repo, "merge-base", "--is-ancestor", bottomOld, "top")).toThrow();
  expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("bottom");
  expect(r.out).toContain("Done. To undo:");
});

test("staged-only: unstaged changes are not folded into the amend", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");

  writeFileSync(join(repo, "staged.txt"), "staged");
  git(repo, "add", "staged.txt");
  writeFileSync(join(repo, "unstaged.txt"), "unstaged"); // NOT added

  const r = amendStack(repo, ["-y"], "1\n"); // keep message

  expect(r.code).toBe(0);
  expect(git(repo, "cat-file", "-t", "bottom:staged.txt")).toBe("blob");
  expect(() => git(repo, "cat-file", "-t", "bottom:unstaged.txt")).toThrow();
});

test("message-only amend: empty index, message rewritten, tree unchanged", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  const treeBefore = git(repo, "rev-parse", "bottom^{tree}");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");

  const r = amendStack(repo, [], "\n2\nreworded bottom\n"); // confirm, edit message

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "bottom^{tree}")).toBe(treeBefore);
  expect(git(repo, "log", "-1", "--format=%s", "bottom")).toContain("reworded bottom");
});

test("prints the staged-changes preview before running", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  writeFileSync(join(repo, "staged.txt"), "x");
  git(repo, "add", "staged.txt");

  const r = amendStack(repo, [], "n\n"); // decline

  expect(r.out).toContain("staged.txt");
});

test("fan-out: base amend propagates to two stacks sharing a middle branch", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "base");
  commit(repo, "base-feature.txt");
  git(repo, "checkout", "-b", "mid");
  commit(repo, "mid.txt");
  git(repo, "checkout", "-b", "leafA");
  commit(repo, "leafA.txt");
  git(repo, "checkout", "mid");
  git(repo, "checkout", "-b", "leafB");
  commit(repo, "leafB.txt");

  git(repo, "checkout", "base");
  const baseOld = git(repo, "rev-parse", "base");
  const midOld = git(repo, "rev-parse", "mid");
  writeFileSync(join(repo, "fix.txt"), "fix");
  git(repo, "add", "fix.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "base")).not.toBe(baseOld);
  expect(git(repo, "rev-parse", "mid~1")).toBe(git(repo, "rev-parse", "base"));
  expect(git(repo, "rev-parse", "leafA~1")).toBe(git(repo, "rev-parse", "mid"));
  expect(git(repo, "rev-parse", "leafB~1")).toBe(git(repo, "rev-parse", "mid"));
  expect(() => git(repo, "merge-base", "--is-ancestor", midOld, "leafA")).toThrow();
  expect(() => git(repo, "merge-base", "--is-ancestor", midOld, "leafB")).toThrow();
});
