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

function addWorktree(repo: string, branch: string): string {
  const wt = sandbox();
  git(repo, "worktree", "add", wt, branch);

  return wt;
}

function initRepo(): string {
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  commit(repo, "base.txt");

  return repo;
}

function initRepoWithOrigin(): { repo: string; bare: string } {
  const repo = initRepo();
  const bare = sandbox();
  git(bare, "init", "--bare");
  git(repo, "remote", "add", "origin", bare);
  git(repo, "push", "-u", "origin", "master");

  return { repo, bare };
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

  const r = amendStack(repo, [], "\n\n2\nreworded bottom\n"); // select all, confirm, edit message

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

test("dry-run: prints the plan and moves no refs", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const bottomBefore = git(repo, "rev-parse", "bottom");
  const topBefore = git(repo, "rev-parse", "top");

  const r = amendStack(repo, ["--dry-run"]);

  expect(r.code).toBe(0);
  expect(r.out).toContain("git rebase --autostash --onto");
  expect(git(repo, "rev-parse", "bottom")).toBe(bottomBefore);
  expect(git(repo, "rev-parse", "top")).toBe(topBefore);
});

test("selection: picking a child auto-includes its ancestor and reports the rest stale", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "mid");
  commit(repo, "mid.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "mid");
  git(repo, "checkout", "-b", "side");
  commit(repo, "side.txt");

  git(repo, "checkout", "bottom");
  const sideOld = git(repo, "rev-parse", "side");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  // menu (verified): 1) mid  2) side  3) top -> pick "3" (top); mid auto-included, side left stale.
  const r = amendStack(repo, [], "3\n\n1\n"); // select top, confirm, keep-message

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "side")).toBe(sideOld);
  expect(r.out.toLowerCase()).toContain("stale");
  expect(git(repo, "rev-parse", "mid~1")).toBe(git(repo, "rev-parse", "bottom"));
  expect(git(repo, "rev-parse", "top~1")).toBe(git(repo, "rev-parse", "mid"));
});

test("worktree locked-clean: rebases the dependent in its own worktree", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");
  const wt = addWorktree(repo, "top"); // "top" now checked out in a second, clean worktree

  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "top~1")).toBe(git(repo, "rev-parse", "bottom"));
  expect(git(wt, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "top"));
});

test("worktree locked-busy: dirty linked worktree in the set aborts before mutating", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");
  const wt = addWorktree(repo, "top");
  writeFileSync(join(wt, "dirty.txt"), "dirty"); // linked worktree is now dirty

  const bottomBefore = git(repo, "rev-parse", "bottom");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(1);
  expect(r.err + r.out).toMatch(/top.*(dirty|in another worktree|checked out|worktree)/i);
  expect(git(repo, "rev-parse", "bottom")).toBe(bottomBefore);
});

test("conflict: stops with guidance and leaves the conflict in place", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "shared.txt", "bottom version");
  git(repo, "checkout", "-b", "top");
  commit(repo, "shared.txt", "top version"); // edits same file -> replay conflict
  git(repo, "checkout", "bottom");

  writeFileSync(join(repo, "shared.txt"), "amended bottom version");
  git(repo, "add", "shared.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(1);
  expect(r.err + r.out).toContain("rebase --continue");
  const status = Bun.spawnSync(["git", "status"], { cwd: repo }).stdout.toString();
  expect(status.toLowerCase()).toMatch(/rebase|unmerged|both modified/);
});

test("push: -y auto-pushes rewritten live-remote branches with force-with-lease", () => {
  const { repo, bare } = initRepoWithOrigin();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "push", "-u", "origin", "bottom", "top");
  git(repo, "checkout", "bottom");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  expect(r.out).toContain("force-with-lease");
  expect(git(bare, "rev-parse", "bottom")).toBe(git(repo, "rev-parse", "bottom"));
  expect(git(bare, "rev-parse", "top")).toBe(git(repo, "rev-parse", "top"));
});

test("push: declining leaves remotes untouched", () => {
  const { repo, bare } = initRepoWithOrigin();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "push", "-u", "origin", "bottom", "top");
  git(repo, "checkout", "bottom");
  const topRemoteBefore = git(bare, "rev-parse", "top");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  // select all(blank), confirm(blank=yes), keep message(1), push? n
  const r = amendStack(repo, [], "\n\n1\nn\n");

  expect(r.code).toBe(0);
  expect(r.out).not.toContain("Pushing with --force-with-lease");
  expect(git(bare, "rev-parse", "top")).toBe(topRemoteBefore);
});

test("push: skips a branch whose remote was deleted ([gone])", () => {
  const { repo, bare } = initRepoWithOrigin();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "push", "-u", "origin", "bottom", "top");
  git(repo, "push", "origin", "--delete", "top");
  git(repo, "checkout", "bottom");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  expect(git(bare, "rev-parse", "bottom")).toBe(git(repo, "rev-parse", "bottom"));
  expect(() => git(bare, "rev-parse", "--verify", "top")).toThrow();
});

test("edge: refuses when there are unstaged changes to tracked files", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "shared.txt", "L1\nL2\nL3\n");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");

  const bottomBefore = git(repo, "rev-parse", "bottom");
  writeFileSync(join(repo, "shared.txt"), "L1-STAGED\nL2\nL3\n");
  git(repo, "add", "shared.txt");
  writeFileSync(join(repo, "shared.txt"), "L1-STAGED\nL2\nL3-UNSTAGED\n"); // now MM

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(1);
  expect(r.err + r.out).toMatch(/unstaged/i);
  expect(git(repo, "rev-parse", "bottom")).toBe(bottomBefore); // nothing mutated
  expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("bottom");
});

test("edge: untracked files are neither swept into the amend nor blocking", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");

  writeFileSync(join(repo, "staged.txt"), "s");
  git(repo, "add", "staged.txt");
  writeFileSync(join(repo, "untracked.txt"), "u"); // untracked, never added

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  expect(git(repo, "cat-file", "-t", "bottom:staged.txt")).toBe("blob");
  expect(() => git(repo, "cat-file", "-t", "bottom:untracked.txt")).toThrow();
});

test("edge: no dependents - just amends the current commit", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "solo");
  commit(repo, "solo.txt");
  const before = git(repo, "rev-parse", "solo");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "solo")).not.toBe(before);
  expect(git(repo, "cat-file", "-t", "solo:x.txt")).toBe("blob");
  expect(git(repo, "symbolic-ref", "--short", "HEAD")).toBe("solo");
});

test("edge: detached HEAD is rejected", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "--detach");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(1);
  expect(r.err + r.out).toMatch(/detached/i);
});

test("edge: deep linear chain (3 dependents) all replay in order", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "b0");
  commit(repo, "b0.txt");
  git(repo, "checkout", "-b", "b1");
  commit(repo, "b1.txt");
  git(repo, "checkout", "-b", "b2");
  commit(repo, "b2.txt");
  git(repo, "checkout", "-b", "b3");
  commit(repo, "b3.txt");
  git(repo, "checkout", "b0");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  expect(git(repo, "rev-parse", "b1~1")).toBe(git(repo, "rev-parse", "b0"));
  expect(git(repo, "rev-parse", "b2~1")).toBe(git(repo, "rev-parse", "b1"));
  expect(git(repo, "rev-parse", "b3~1")).toBe(git(repo, "rev-parse", "b2"));
  expect(git(repo, "cat-file", "-t", "b0:x.txt")).toBe("blob");
});

test("edge: mid-rebase in a linked worktree aborts before mutating", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "conflict.txt", "base\n");
  git(repo, "checkout", "-b", "top");
  commit(repo, "conflict.txt", "top\n");
  git(repo, "checkout", "bottom");
  const wt = addWorktree(repo, "top");

  // start a rebase in the linked worktree that leaves it mid-conflict
  git(repo, "checkout", "-b", "diverge");
  commit(repo, "conflict.txt", "diverge\n");
  git(repo, "checkout", "bottom");
  Bun.spawnSync(["git", "rebase", "diverge"], { cwd: wt }); // conflicts, leaves rebase-merge

  const bottomBefore = git(repo, "rev-parse", "bottom");
  writeFileSync(join(repo, "y.txt"), "y");
  git(repo, "add", "y.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(1);
  expect(r.err + r.out).toMatch(/(mid-operation|worktree|busy)/i);
  expect(git(repo, "rev-parse", "bottom")).toBe(bottomBefore);
});

test("edge: co-located branches on the tip both propagate (no silent no-op)", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "branch", "top-alias"); // second name on the same tip commit
  git(repo, "checkout", "bottom");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  // both co-located branches must now sit on the amended bottom, not the old one
  expect(git(repo, "rev-parse", "top~1")).toBe(git(repo, "rev-parse", "bottom"));
  expect(git(repo, "rev-parse", "top-alias~1")).toBe(git(repo, "rev-parse", "bottom"));
});

test("edge: pushes to the actual upstream branch, not a same-named ref", () => {
  const { repo, bare } = initRepoWithOrigin();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  // bottom tracks a DIFFERENTLY-named upstream
  git(repo, "push", "origin", "bottom:renamed-bottom");
  git(repo, "branch", "--set-upstream-to=origin/renamed-bottom", "bottom");
  git(repo, "push", "-u", "origin", "top");
  git(repo, "checkout", "bottom");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(0);
  // the real upstream is updated...
  expect(git(bare, "rev-parse", "renamed-bottom")).toBe(git(repo, "rev-parse", "bottom"));
  // ...and no spurious same-named ref was created
  expect(() => git(bare, "rev-parse", "--verify", "bottom")).toThrow();
});

test("edge: refuses when a dependent range contains a merge commit", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "featA");
  commit(repo, "a.txt");
  git(repo, "checkout", "bottom");
  git(repo, "checkout", "-b", "featB");
  commit(repo, "b.txt");
  git(repo, "merge", "--no-edit", "featA"); // featB now has a merge commit above bottom

  git(repo, "checkout", "bottom");
  const featBBefore = git(repo, "rev-parse", "featB");
  writeFileSync(join(repo, "x.txt"), "x");
  git(repo, "add", "x.txt");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(1);
  expect(r.err + r.out).toMatch(/merge/i);
  expect(git(repo, "rev-parse", "featB")).toBe(featBBefore); // nothing mutated
});

test("edge: --dry-run shows the plan even when a linked worktree is busy", () => {
  const repo = initRepo();
  git(repo, "checkout", "-b", "bottom");
  commit(repo, "bottom.txt");
  git(repo, "checkout", "-b", "top");
  commit(repo, "top.txt");
  git(repo, "checkout", "bottom");
  const wt = addWorktree(repo, "top");
  writeFileSync(join(wt, "dirty.txt"), "dirty"); // linked worktree dirty

  const r = amendStack(repo, ["--dry-run"]);

  expect(r.code).toBe(0);
  expect(r.out).toContain("git");
  expect(r.out).toContain("rebase --autostash --onto");
});

test("edge: unborn HEAD (empty repo) is rejected clearly", () => {
  const repo = sandbox();
  git(repo, "init", "-b", "master");
  git(repo, "config", "user.email", "t@t.t");
  git(repo, "config", "user.name", "t");

  const r = amendStack(repo, ["-y"], "1\n");

  expect(r.code).toBe(1);
  expect(r.err + r.out).toMatch(/no commits|nothing to amend|unborn/i);
});

test("help lists the flags", () => {
  const repo = sandbox();
  git(repo, "init", "-b", "master");

  const r = amendStack(repo, ["help"]);

  expect(r.out).toContain("amend-stack");
  expect(r.out).toContain("--dry-run");
  expect(r.out).toContain("--yes");
});
