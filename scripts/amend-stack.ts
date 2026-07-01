import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  // Bun's prompt() returns null for BOTH an empty line (Enter) and EOF - they can't be
  // told apart, so empty input follows the documented [Y]/n default (yes). Non-interactive
  // callers must pass -y explicitly (see help).
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
  // A parent must be a STRICT ancestor: co-located branches (equal commits, ancestor
  // both ways) are siblings, not parents - treating them as parents yields a no-op rebase.
  const cands = deps.filter((c) => c !== branch && isAncestor(c, branch) && !isAncestor(branch, c));
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
  const tokens = input.split(",").map((s) => s.trim()).filter(Boolean);
  if (tokens.some((t) => !/^\d+$/.test(t))) return null; // reject 1e0, 0x2, 1.0, etc.
  const nums = tokens.map(Number);
  if (nums.some((n) => n < 1 || n > max)) return null;

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
  // Untracked files are safe: rebase --autostash never touches them. Only tracked
  // (staged/unstaged) changes make a worktree unsafe to rebase in place.
  return git(["status", "--porcelain", "--untracked-files=no"], path).stdout === "";
}

function midOperation(path: string): boolean {
  const gitDir = git(["rev-parse", "--absolute-git-dir"], path).stdout;

  return ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]
    .some((m) => existsSync(join(gitDir, m)));
}

function rebasingBranch(path: string): string | null {
  const gitDir = git(["rev-parse", "--absolute-git-dir"], path).stdout;
  for (const d of ["rebase-merge", "rebase-apply"]) {
    const hn = join(gitDir, d, "head-name");
    if (existsSync(hn)) {
      try {
        return readFileSync(hn, "utf8").trim().replace("refs/heads/", "");
      } catch {
        return null;
      }
    }
  }

  return null;
}

function busyOccupier(branch: string, wts: Worktree[], selfPath: string): string | null {
  const w = wts.find(
    (wt) => wt.path !== selfPath && (wt.branch === branch || rebasingBranch(wt.path) === branch),
  );
  if (!w) return null;

  return !isClean(w.path) || midOperation(w.path) ? w.path : null;
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
  const slash = up.indexOf("/");
  const remote = up.slice(0, slash);
  const remoteBranch = up.slice(slash + 1);

  return gitInherit(["push", "--force-with-lease", remote, `${branch}:${remoteBranch}`]) === 0;
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

  let chosen = new Set(pushable);
  if (!yes) {
    const input = (prompt("Which? (numbers, comma-separated; blank = all):") ?? "").trim();
    if (input !== "") {
      const picked = parseSelection(input, pushable.length);
      if (!picked || picked.length === 0) {
        console.log("Nothing selected.");

        return;
      }
      chosen = new Set(picked.map((n) => pushable[n - 1]));
    }
  }

  console.log("\nPushing with --force-with-lease...");
  // pushable is parent-first (bottom -> top). If an ancestor's push fails, pushing a
  // descendant would leave the remote stack based on a commit that isn't on the remote.
  const failed: string[] = [];
  for (const b of pushable) {
    if (!chosen.has(b)) continue;
    if (failed.some((f) => isAncestor(f, b))) {
      console.warn(`Skipping ${b}: an ancestor push failed - pushing it would leave an inconsistent remote stack.`);
      continue;
    }
    if (!pushBranch(b)) {
      console.warn(`Push failed for ${b}; continuing.`);
      failed.push(b);
    }
  }
}

function restoreLine(branch: string, sha: string, cwd?: string): string {
  return cwd ? `  git -C ${cwd} reset --hard ${sha.slice(0, 9)}` : `  git branch -f ${branch} ${sha.slice(0, 9)}`;
}

function conflictGuidance(step: Step, done: Step[], remaining: Step[], amendBranch: string, oldHead: string, oldTip: Record<string, string>): string {
  const at = step.cwd ? `${step.branch} (in ${step.cwd})` : step.branch;
  const cont = step.cwd ? `git -C ${step.cwd} rebase --continue` : "git rebase --continue";
  const abort = step.cwd ? `git -C ${step.cwd} rebase --abort` : "git rebase --abort";
  const rest = remaining.map((s) => `  ${s.display}`).join("\n");
  // Everything already rewritten before this conflict: the amend branch + each completed step.
  const undo = [
    restoreLine(amendBranch, oldHead),
    ...done.map((s) => restoreLine(s.branch, oldTip[s.branch], s.cwd)),
  ].join("\n");

  return (
    `\nRestack stopped at ${at} (conflict).\nResolve, 'git add', then '${cont}'.` +
    (rest ? `\nThen finish the remaining branches:\n${rest}` : "") +
    `\nOr '${abort}' to back out this branch.` +
    `\nTo undo everything already rewritten (after aborting this rebase):\n${undo}`
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
  const headRef = git(["rev-parse", "HEAD"]);
  if (headRef.code !== 0) fail(`No commits on ${amendBranch} yet - nothing to amend.`);
  const oldHead = headRef.stdout;

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

  // Preflight abort conditions. Skipped under --dry-run so the plan is always previewable.
  if (!dryRun) {
    if (midOperation(selfPath)) fail("Current worktree is mid-rebase/merge - finish or abort it first.");
    if (git(["diff", "--quiet"]).code !== 0) {
      fail("You have unstaged changes to tracked files.\namend-stack only folds in the staged index; stash or stage the rest first (otherwise a dependent rebase could drag them across branches).");
    }

    const withMerges = selected.filter((b) => git(["rev-list", "--merges", `${oldHead}..${b}`]).stdout !== "");
    if (withMerges.length > 0) {
      fail(`\nCannot restack - a merge commit sits above the amended commit and can't be replayed with --onto:\n  ${withMerges.join(", ")}\n\nRebase these manually (e.g. git rebase --rebase-merges) or exclude them.`);
    }

    const blocked: string[] = [];
    for (const b of selected) {
      const busyPath = busyOccupier(b, wts, selfPath);
      if (busyPath) blocked.push(`${b} (busy in ${busyPath} - dirty or mid-operation)`);
    }
    if (blocked.length > 0) {
      fail(`\nCannot restack - these selected branches are busy in another worktree:\n  ${blocked.join("\n  ")}\n\nFinish/clean those worktrees or deselect the branches (deselecting drops their descendants).`);
    }
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
    fail(conflictGuidance(steps[result.index], steps.slice(0, result.index), steps.slice(result.index + 1), amendBranch, oldHead, oldTip));
  }

  if (git(["checkout", amendBranch]).code !== 0) {
    console.warn(`\nWarning: could not return to ${amendBranch}; you may be left on a dependent branch.`);
  }

  pushPass([amendBranch, ...selected], yes);

  console.log("\nDone. To undo:");
  console.log(restoreLine(amendBranch, oldTip[amendBranch]));
  for (const s of steps) console.log(restoreLine(s.branch, oldTip[s.branch], s.cwd));
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

Empty input follows the [Y]/n default (proceed), so non-interactive callers
that do NOT want to proceed must not invoke it without a real answer; pass -y
for intentional non-interactive runs.

Options:
  -y, --yes    Skip confirmation and auto-push every live-remote rewritten
               branch with force-with-lease.
  --dry-run    Print the plan and exit without changing anything.`,
  run,
  complete: () => ["-y", "--yes", "--dry-run"],
};

export default script;
