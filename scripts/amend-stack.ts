import { spawnSync } from "node:child_process";
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

  return [...deps].sort((a, b) => rank(a) - rank(b));
}

type Step = { branch: string; onto: string; cut: string; cwd?: string; display: string };

function planSteps(amendBranch: string, oldHead: string, ordered: string[], deps: string[], oldTip: Record<string, string>): Step[] {
  return ordered.map((branch) => {
    const parent = parentOf(branch, deps);
    const onto = parent ?? amendBranch;
    const cut = parent ? oldTip[parent] : oldHead;

    return {
      branch,
      onto,
      cut,
      display: `git rebase --autostash --onto ${onto} ${cut.slice(0, 9)} ${branch}`,
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

  const steps = planSteps(amendBranch, oldHead, ordered, deps, oldTip);

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
  if (!result.ok) fail(`\nRestack stopped at ${steps[result.index].branch} (conflict). Resolve, 'git add', 'git rebase --continue'.`);

  git(["checkout", amendBranch]);

  console.log("\nDone. To undo:");
  console.log(`  git branch -f ${amendBranch} ${oldTip[amendBranch].slice(0, 9)}`);
  for (const b of ordered) console.log(`  git branch -f ${b} ${oldTip[b].slice(0, 9)}`);
}

const script: CScriptScript = {
  description: "Amend the current commit and restack every dependent branch onto it.",
  help: `Usage: cscript amend-stack [-y|--yes] [--dry-run]`,
  run,
};

export default script;
