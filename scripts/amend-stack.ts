import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CScriptScript } from "../types";

type Git = { code: number; stdout: string; stderr: string };

function git(args: string[], cwd?: string): Git {
  const r = spawnSync("git", args, { encoding: "utf8", cwd });

  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function gitInherit(args: string[], cwd?: string): number {
  return spawnSync("git", args, { stdio: "inherit", cwd }).status ?? 1;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function confirm(message: string): boolean {
  return !(prompt(message) ?? "").trim().toLowerCase().startsWith("n");
}

function currentBranch(): string {
  const r = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.code !== 0) fail("Detached HEAD - amend-stack needs a branch checked out.");

  return r.stdout;
}

type Parsed = { yes: boolean; dryRun: boolean };

function parseArgs(args: string[]): Parsed {
  let yes = false;
  let dryRun = false;
  for (const a of args) {
    if (a === "-y" || a === "--yes") yes = true;
    else if (a === "--dry-run") dryRun = true;
    else fail("Usage: cscript amend-stack [-y|--yes] [--dry-run]");
  }

  return { yes, dryRun };
}

function isAncestor(ancestor: string, descendant: string): boolean {
  return git(["merge-base", "--is-ancestor", ancestor, descendant]).code === 0;
}

function dependents(oldHead: string, amendBranch: string): string[] {
  return git(["branch", "--contains", oldHead, "--format=%(refname:short)"])
    .stdout.split("\n").map((s) => s.trim()).filter(Boolean)
    .filter((b) => b !== amendBranch);
}

function parentOf(branch: string, deps: string[]): string | null {
  const cands = deps.filter((c) => c !== branch && isAncestor(c, branch));
  for (const p of cands) {
    if (cands.every((c) => c === p || isAncestor(c, p))) return p;
  }

  return null;
}

function topoOrder(oldHead: string, deps: string[]): string[] {
  const rank = (b: string): number =>
    Number(git(["rev-list", "--count", `${oldHead}..${b}`]).stdout);

  return [...deps].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function parseSelection(input: string, max: number): number[] | null {
  const nums = input.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > max)) return null;

  return [...new Set(nums)];
}

function closeUnderAncestry(selected: string[], deps: string[]): Set<string> {
  const set = new Set(selected);
  for (const b of selected) {
    for (const c of deps) if (c !== b && isAncestor(c, b)) set.add(c);
  }

  return set;
}

type Worktree = { path: string; branch: string | null };

function worktrees(): Worktree[] {
  return git(["worktree", "list", "--porcelain"]).stdout
    .split("\n\n").map((b) => b.split("\n")).map((lines) => {
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? "";
      const bl = lines.find((l) => l.startsWith("branch "));
      const branch = bl ? bl.slice("branch ".length).replace("refs/heads/", "") : null;

      return { path, branch };
    }).filter((w) => w.path !== "");
}

function worktreeForBranch(branch: string, wts: Worktree[]): string | null {
  return wts.find((w) => w.branch === branch)?.path ?? null;
}

function isClean(path: string): boolean {
  return git(["status", "--porcelain"], path).stdout === "";
}

function midOperation(path: string): boolean {
  const gitDir = git(["rev-parse", "--absolute-git-dir"], path).stdout;

  return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
    .some((m) => existsSync(join(gitDir, m)));
}

type Step = { branch: string; onto: string; cut: string; cwd?: string; display: string };

function planSteps(amendBranch: string, oldHead: string, ordered: string[], deps: string[], oldTip: Record<string, string>, wts: Worktree[], selfPath: string): Step[] {
  return ordered.map((branch) => {
    const parent = parentOf(branch, deps);
    const onto = parent ?? amendBranch;
    const cut = parent ? oldTip[parent] : oldHead;
    const wtPath = worktreeForBranch(branch, wts);
    const cwd = wtPath && wtPath !== selfPath ? wtPath : undefined;
    const where = cwd ? ` (in ${cwd})` : "";

    return {
      branch,
      onto,
      cut,
      cwd,
      display: `git ${cwd ? `-C ${cwd} ` : ""}rebase --autostash --onto ${onto} ${cut.slice(0, 9)} ${branch}${where}`,
    };
  });
}

function stagedPreview(): string {
  return git(["diff", "--cached", "--stat"]).stdout;
}

function amendCommit(yes: boolean): void {
  const choice = yes ? "1" : (prompt("\nMessage: [1] keep  [2] edit :") ?? "1").trim();
  if (choice === "2") {
    const msg = (prompt("New commit message:") ?? "").trim();
    if (msg === "") fail("Empty message - aborting.");
    if (gitInherit(["commit", "--amend", "-m", msg]) !== 0) fail("Amend failed.");

    return;
  }
  if (gitInherit(["commit", "--amend", "--no-edit"]) !== 0) fail("Amend failed.");
}

function verify(ref: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", ref]).code === 0;
}

function upstreamOf(branch: string): string | null {
  const r = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);

  return r.code === 0 ? r.stdout : null;
}

function pushableBranches(branches: string[]): string[] {
  return branches.filter((b) => {
    const up = upstreamOf(b);

    return up !== null && verify(up);
  });
}

function pushBranch(branch: string): boolean {
  const up = upstreamOf(branch);
  if (up === null) return true;
  const remote = up.split("/")[0];

  return gitInherit(["push", "--force-with-lease", remote, branch]) === 0;
}

function pushPass(rewritten: string[], yes: boolean): void {
  const pushable = pushableBranches(rewritten);
  if (pushable.length === 0) {
    console.log("\nNo branches with live remotes to push.");

    return;
  }
  console.log("\nThese rewritten branches are on a remote:");
  pushable.forEach((b, i) => console.log(`  ${i + 1}) ${b}`));
  if (!(yes || confirm(`\nForce-with-lease push? [Y]/n:`))) return;

  let chosen = pushable;
  if (!yes) {
    const input = (prompt("Which? (numbers, comma-separated; blank = all):") ?? "").trim();
    if (input !== "") {
      const picked = parseSelection(input, pushable.length);
      if (!picked || picked.length === 0) {
        console.log("Nothing selected.");

        return;
      }
      chosen = picked.map((n) => pushable[n - 1]);
    }
  }
  console.log("\nPushing with --force-with-lease...");
  for (const b of chosen) if (!pushBranch(b)) console.warn(`Push failed for ${b}; continuing.`);
}

function conflictGuidance(step: Step, remaining: Step[], amendBranch: string, oldHead: string): string {
  const at = step.cwd ? `${step.branch} (in ${step.cwd})` : step.branch;
  const cont = step.cwd ? `git -C ${step.cwd} rebase --continue` : "git rebase --continue";
  const abort = step.cwd ? `git -C ${step.cwd} rebase --abort` : "git rebase --abort";
  const rest = remaining.map((s) => `  ${s.display}`).join("\n");

  return (
    `\nRestack stopped at ${at} (conflict).\nResolve, 'git add', then '${cont}'.` +
    (rest ? `\nThen finish the remaining branches:\n${rest}` : "") +
    `\nOr '${abort}' to back out this branch.` +
    `\nTo undo the amend after aborting:\n  git branch -f ${amendBranch} ${oldHead.slice(0, 9)}`
  );
}

type Result = { ok: boolean; index: number };

function runSteps(steps: Step[]): Result {
  for (const [i, step] of steps.entries()) {
    console.log(`\n[${i + 1}/${steps.length}] ${step.branch}`);
    const prefix = step.cwd ? ["-C", step.cwd] : [];
    if (gitInherit([...prefix, "rebase", "--autostash", "--onto", step.onto, step.cut, step.branch]) !== 0) {
      return { ok: false, index: i };
    }
  }

  return { ok: true, index: -1 };
}

function run(args: string[]): void {
  const { yes, dryRun } = parseArgs(args);
  const amendBranch = currentBranch();
  const oldHead = git(["rev-parse", "HEAD"]).stdout;

  const deps = dependents(oldHead, amendBranch);
  const ordered = topoOrder(oldHead, deps);
  const oldTip: Record<string, string> = { [amendBranch]: oldHead };
  for (const b of deps) oldTip[b] = git(["rev-parse", b]).stdout;

  let selected = ordered;
  if (!yes && !dryRun && ordered.length > 0) {
    console.log("\nDependent branches (bottom -> top):");
    ordered.forEach((b, i) => console.log(`  ${i + 1}) ${b}`));
    const input = (prompt("\nRestack which? (numbers, comma-separated; blank = all):") ?? "").trim();
    if (input !== "") {
      const picked = parseSelection(input, ordered.length);
      if (!picked || picked.length === 0) fail("Invalid selection.");
      const closed = closeUnderAncestry(picked.map((n) => ordered[n - 1]), ordered);
      selected = ordered.filter((b) => closed.has(b));
      const stale = ordered.filter((b) => !closed.has(b));
      if (stale.length > 0) {
        console.log(`\nLeft stale (still on the old base - restack later): ${stale.join(", ")}`);
      }
    }
  }

  const wts = worktrees();
  const selfPath = git(["rev-parse", "--show-toplevel"]).stdout;
  if (midOperation(selfPath)) fail("Current worktree is mid-rebase/merge - finish or abort it first.");

  const blocked: string[] = [];
  for (const b of selected) {
    const wtPath = worktreeForBranch(b, wts);
    if (wtPath && wtPath !== selfPath && (!isClean(wtPath) || midOperation(wtPath))) {
      blocked.push(`${b} (checked out in ${wtPath} - dirty or mid-operation)`);
    }
  }
  if (blocked.length > 0) {
    fail(`\nCannot restack - these selected branches are busy in another worktree:\n  ${blocked.join("\n  ")}\n\nFinish/clean those worktrees or deselect the branches (deselecting drops their descendants).`);
  }

  const steps = planSteps(amendBranch, oldHead, selected, deps, oldTip, wts, selfPath);

  const preview = stagedPreview();
  console.log(preview === "" ? "\n(no staged changes - message-only amend)" : `\nStaged changes:\n${preview}`);
  console.log(`\nAmend ${amendBranch} (${oldHead.slice(0, 9)}) with staged changes.`);
  console.log("Then restack:");
  steps.forEach((s, i) => console.log(`  ${i + 1}) ${s.display}`));
  if (dryRun) {
    console.log("\nDry run - nothing changed.");

    return;
  }
  if (!(yes || confirm("\nProceed? [Y]/n:"))) {
    console.log("Aborted.");

    return;
  }

  amendCommit(yes);

  const result = runSteps(steps);
  if (!result.ok) {
    fail(conflictGuidance(steps[result.index], steps.slice(result.index + 1), amendBranch, oldHead));
  }

  git(["checkout", amendBranch]);

  pushPass([amendBranch, ...selected], yes);

  console.log("\nDone. To undo:");
  console.log(`  git branch -f ${amendBranch} ${oldTip[amendBranch].slice(0, 9)}`);
  for (const b of selected) console.log(`  git branch -f ${b} ${oldTip[b].slice(0, 9)}`);
}

const script: CScriptScript = {
  description: "Amend the current commit and restack every dependent branch onto it.",
  help: `Usage: cscript amend-stack [-y|--yes] [--dry-run]

Amends the current commit with the staged changes (optionally editing its
message), then replays every dependent branch stacked above it onto the
rewritten commit. Dependents are discovered from topology (git branch
--contains) and modelled as a forest: each branch is rebased --onto its
parent's new tip, cutting the parent's old tip.

Only staged changes are folded in (never runs 'git add'). An empty index
means a message-only amend.

Dependents checked out in another clean worktree are rebased in place there
(git -C). A dependent whose worktree is dirty or mid-rebase blocks the run:
amend-stack aborts before any mutation and asks you to clean/finish it or
deselect it. The current worktree must not be mid-rebase/merge.

You pick which dependents to restack (numbered; blank = all). Picking a
branch auto-includes its ancestors; anything left out is reported as stale.

After a clean restack, rewritten branches that live on a remote are offered
for a single force-with-lease push (numbered; blank = all).

Options:
  -y, --yes    Skip confirmation and auto-push every live-remote rewritten
               branch with force-with-lease.
  --dry-run    Print the plan and exit without changing anything.`,
  run,
  complete: () => ["-y", "--yes", "--dry-run"],
};

export default script;
