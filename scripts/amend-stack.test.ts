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

  const r = amendStack(repo, [], "\n"); // confirm plan with empty (=yes)

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "bottom")).not.toBe(bottomOld);
  expect(git(repo, "cat-file", "-t", `bottom:extra.txt`)).toBe("blob");
  expect(git(repo, "rev-parse", "top~1")).toBe(git(repo, "rev-parse", "bottom"));
  expect(git(repo, "cat-file", "-t", `top:top.txt`)).toBe("blob");
  expect(() => git(repo, "merge-base", "--is-ancestor", bottomOld, "top")).toThrow();
  expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("bottom");
  expect(r.out).toContain("Done. To undo:");
});
