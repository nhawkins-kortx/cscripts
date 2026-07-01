import { spawnSync } from "node:child_process";
import type { CScriptScript } from "../types";

type Git = { code: number; stdout: string; stderr: string };

function git(args: string[]): Git {
  const r = spawnSync("git", args, { encoding: "utf8" });

  return { code: r.status ?? 1, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}


function gitInherit(args: string[]): number {
  return spawnSync("git", args, { stdio: "inherit" }).status ?? 1;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function confirm(message: string): boolean {
  return !(prompt(message) ?? "").trim().toLowerCase().startsWith("n");
}

function verify(ref: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", ref]).code === 0;
}

function currentBranch(): string {
  const r = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.code !== 0) fail("Detached HEAD — restack needs a branch as the top of the stack.");

  return r.stdout;
}

function gitRefs(): string[] {
  return git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
    .stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function remoteForTarget(target: string): string | null {
  const slash = target.indexOf("/");
  if (slash === -1) return null;
  const candidate = target.slice(0, slash);
  const remotes = git(["remote"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  return remotes.includes(candidate) ? candidate : null;
}

function inferChain(target: string, top: string): string[] {
  const commits = git(["rev-list", "--reverse", `${target}..${top}`]).stdout.split("\n").filter(Boolean);
  if (commits.length === 0) fail(`No commits in ${target}..${top} — nothing to restack.`);

  const chain: string[] = [];
  for (const c of commits) {
    const branches = git(["for-each-ref", "--format=%(refname:short)", "--points-at", c, "refs/heads"])
      .stdout.split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (branches.length === 0) continue;
    if (branches.length > 1) {
      fail(`Ambiguous chain: multiple branches point at ${c.slice(0, 9)} (${branches.join(", ")}).`);
    }
    chain.push(branches[0]);
  }
  if (chain[chain.length - 1] !== top) chain.push(top);

  return chain;
}

type Parsed = { target: string; yes: boolean };

function parseArgs(args: string[]): Parsed {
  let yes = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "-y" || a === "--yes") yes = true;
    else positional.push(a);
  }
  if (positional.length !== 1) fail("Usage: cscript restack <target> [-y]");

  return { target: positional[0], yes };
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
  if (up === null) {
    console.warn(`No upstream for ${branch}; skipping push.`);

    return true;
  }
  const remote = up.split("/")[0];

  return gitInherit(["push", "--force-with-lease", remote, branch]) === 0;
}

type Step = { branch: string; args: string[]; display: string };
type Plan = { used: string[]; steps: Step[] };
type Result = { ok: boolean; index: number };

function isAncestor(ancestor: string, descendant: string): boolean {
  return git(["merge-base", "--is-ancestor", ancestor, descendant]).code === 0;
}

function planSteps(target: string, chain: string[], oldTip: Record<string, string>, merged: string | null): Plan {
  const cutTip = merged ? git(["rev-parse", merged]).stdout : null;
  const used = merged ? chain.filter((b) => b !== merged && isAncestor(merged, b)) : chain;

  const steps = used.map((branch, i) => {
    if (i === 0) {
      const onto = cutTip
        ? { args: ["--onto", target, cutTip], display: `--onto ${target} ${cutTip.slice(0, 9)}` }
        : { args: [target], display: `${target}` };

      return {
        branch,
        args: ["rebase", "--autostash", ...onto.args, branch],
        display: `git rebase --autostash ${onto.display} ${branch}`,
      };
    }
    const parent = used[i - 1];
    const cut = oldTip[parent];

    return {
      branch,
      args: ["rebase", "--autostash", "--onto", parent, cut, branch],
      display: `git rebase --autostash --onto ${parent} ${cut.slice(0, 9)} ${branch}`,
    };
  });

  return { used, steps };
}

function confirmPlan(target: string, plan: Plan, yes: boolean): boolean {
  console.log(`\nStack (bottom → top): ${plan.used.join(" → ")}`);
  console.log(`Restacking onto ${target}:\n`);
  plan.steps.forEach((s, i) => console.log(`  ${i + 1}) ${s.display}`));

  return yes || confirm("\nProceed? [Y]/n:");
}

function runSteps(steps: Step[]): Result {
  for (const [i, step] of steps.entries()) {
    console.log(`\n[${i + 1}/${steps.length}] ${step.branch}`);
    if (gitInherit(step.args) !== 0) return { ok: false, index: i };
  }

  return { ok: true, index: -1 };
}

function manualGuidance(branch: string, steps: Step[], failedIndex: number): string {
  const remaining = steps.slice(failedIndex + 1).map((s) => `  ${s.display}`).join("\n");

  return (
    `\nRestack stopped at ${branch} (conflict). Resolve, 'git add', then 'git rebase --continue'.` +
    (remaining ? `\nThen finish the remaining branches:\n${remaining}` : "") +
    `\nOr 'git rebase --abort' to back out this branch.`
  );
}

function finish(plan: Plan, oldTip: Record<string, string>, yes: boolean): void {
  const pushable = pushableBranches(plan.used);
  if (pushable.length === 0) {
    console.log("\nNo branches with live remotes to push.");
  } else {
    console.log("\nThese branches are on a remote:");
    for (const b of pushable) console.log(`  ${b}`);
    const go = yes || confirm(`\nPush ${pushable.length} branch(es) with --force-with-lease? [Y]/n:`);
    if (go) {
      console.log("\nPushing with --force-with-lease...");
      for (const b of pushable) {
        if (!pushBranch(b)) console.warn(`Push failed for ${b}; continuing.`);
      }
    }
  }

  console.log("\nDone. To undo:");
  for (const b of plan.used) console.log(`  git branch -f ${b} ${oldTip[b].slice(0, 9)}`);
}

function run(args: string[]): void {
  const { target, yes } = parseArgs(args);
  const top = currentBranch();

  const remote = remoteForTarget(target);
  if (remote) {
    console.log(`Fetching ${remote}...`);
    gitInherit(["fetch", "--prune", remote]);
  }
  if (!verify(target)) fail(`Target ref not found: ${target}`);

  const chain = inferChain(target, top);
  const oldTip: Record<string, string> = {};
  for (const b of chain) oldTip[b] = git(["rev-parse", b]).stdout;

  let plan = planSteps(target, chain, oldTip, null);
  if (!confirmPlan(target, plan, yes)) {
    console.log("Aborted.");

    return;
  }

  let result = runSteps(plan.steps);

  if (!result.ok) {
    const stalled = plan.steps[result.index].branch;
    const merged = (
      prompt(
        `\nRestack stopped at ${stalled} (conflict).` +
          `\nIf a dependency was squash-merged, enter that branch to cut at its tip and retry;` +
          `\nleave blank to resolve manually: `,
      ) ?? ""
    ).trim();

    if (merged === "") fail(manualGuidance(stalled, plan.steps, result.index));
    if (!verify(merged)) fail(`Ref not found: ${merged}.${manualGuidance(stalled, plan.steps, result.index)}`);

    gitInherit(["rebase", "--abort"]);
    for (let j = 0; j < result.index; j++) git(["branch", "-f", plan.steps[j].branch, oldTip[plan.steps[j].branch]]);

    plan = planSteps(target, chain, oldTip, merged);
    if (plan.used.length === 0) {
      git(["checkout", top]);
      fail(`Nothing above ${merged} to restack.`);
    }
    if (!confirmPlan(target, plan, yes)) {
      git(["checkout", top]);
      console.log("Aborted.");

      return;
    }

    result = runSteps(plan.steps);
    if (!result.ok) {
      const again = plan.steps[result.index].branch;
      gitInherit(["rebase", "--abort"]);
      for (let j = 0; j < result.index; j++) git(["branch", "-f", plan.steps[j].branch, oldTip[plan.steps[j].branch]]);
      git(["checkout", top]);
      fail(`Retry also stopped at ${again} — likely a genuine conflict, not a stale dependency. Resolve manually.`);
    }
  }

  finish(plan, oldTip, yes);
}

const script: CScriptScript = {
  description: "Restack a whole stacked-PR chain onto a new base (current branch = top of stack).",
  help: `Usage: cscript restack <target> [-y|--yes]

Restacks the chain of stacked branches leading up to the current branch onto
<target>, rebasing each branch bottom-up onto its parent's new tip.

The chain is inferred from topology: walking <target>..HEAD, any local branch
pointing at a commit on that line is part of the stack, in order. The current
branch is the top.

Equivalent to, for chain B1 → B2 → ... → Bn (= current branch):

  git rebase --autostash <target> B1
  git rebase --autostash --onto B1 <old B1 tip> B2
  ...
  git rebase --autostash --onto B(n-1) <old B(n-1) tip> Bn

If <target> is a remote ref (e.g. origin/master), that remote is fetched
first. A dirty working tree is auto-stashed.

The inferred chain and rebase sequence are printed for confirmation (skip with
-y).

After a clean restack, any branch in the chain that lives on a remote (upstream
configured and not [gone]) is listed and you're offered a single
force-with-lease push of all of them. Branches whose remote was deleted are
skipped so merged/closed PR branches aren't resurrected.

Squash-merged deps: if a dependency was squash-merged into <target>, its
commits live on under the stack with a new SHA, so topology can't tell they're
already merged and the rebase conflicts replaying them. On any conflict you're
prompted for the merged branch — enter it to cut at its tip and cleanly restack
everything above it (the rebase is aborted and retried). Leave it blank to stop
and resolve manually (the conflict is left in place with the usual git hints).

Limitations: assumes a linear stack — one branch per commit tip and no merge
commits in <target>..HEAD. Ambiguous topology fails with a clear message.

Options:
  -y, --yes   Skip the confirmation prompt and auto-accept the push offer
              (force-with-lease pushes every live-remote branch with no prompt).

Examples:
  cscript restack origin/master
  cscript restack origin/master -y`,
  run,
  complete: (args) => {
    const positional = args.filter((a) => !a.startsWith("-"));

    return positional.length === 1 ? gitRefs() : [];
  },
};

export default script;
