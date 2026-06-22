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

function verify(ref: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", ref]).code === 0;
}

function currentBranch(): string {
  const r = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (r.code !== 0) fail("Detached HEAD — restack needs a branch as the top of the stack.");

  return r.stdout;
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

type Parsed = { target: string; push: boolean; yes: boolean };

function parseArgs(args: string[]): Parsed {
  let push = false;
  let yes = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--push") push = true;
    else if (a === "-y" || a === "--yes") yes = true;
    else positional.push(a);
  }
  if (positional.length !== 1) fail("Usage: cscript restack <target> [--push] [-y]");

  return { target: positional[0], push, yes };
}

function pushBranch(branch: string): boolean {
  const up = git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`]);
  if (up.code !== 0) {
    console.warn(`No upstream for ${branch}; skipping push.`);

    return true;
  }
  const remote = up.stdout.split("/")[0];

  return gitInherit(["push", "--force-with-lease", remote, branch]) === 0;
}

type Step = { branch: string; args: string[]; display: string };

function run(args: string[]): void {
  const { target, push, yes } = parseArgs(args);
  const top = currentBranch();

  const remote = remoteForTarget(target);
  if (remote) {
    console.log(`Fetching ${remote}...`);
    gitInherit(["fetch", remote]);
  }
  if (!verify(target)) fail(`Target ref not found: ${target}`);

  const chain = inferChain(target, top);
  const oldTip: Record<string, string> = {};
  for (const b of chain) oldTip[b] = git(["rev-parse", b]).stdout;

  const steps: Step[] = chain.map((branch, i) => {
    if (i === 0) {
      return {
        branch,
        args: ["rebase", "--autostash", target, branch],
        display: `git rebase --autostash ${target} ${branch}`,
      };
    }
    const parent = chain[i - 1];
    const cut = oldTip[parent];

    return {
      branch,
      args: ["rebase", "--autostash", "--onto", parent, cut, branch],
      display: `git rebase --autostash --onto ${parent} ${cut.slice(0, 9)} ${branch}`,
    };
  });

  console.log(`\nInferred stack (bottom → top): ${chain.join(" → ")}`);
  console.log(`Restacking onto ${target}:\n`);
  steps.forEach((s, i) => console.log(`  ${i + 1}) ${s.display}`));

  if (!yes && (prompt("\nProceed? y/[N]:") ?? "").trim().toLowerCase() !== "y") {
    console.log("Aborted.");

    return;
  }

  for (const [i, step] of steps.entries()) {
    console.log(`\n[${i + 1}/${steps.length}] ${step.branch}`);
    if (gitInherit(step.args) !== 0) {
      const remaining = steps.slice(i + 1).map((s) => `  ${s.display}`).join("\n");
      fail(
        `\nRestack stopped at ${step.branch} (conflict). Resolve, 'git add', then 'git rebase --continue'.` +
          (remaining ? `\nThen finish the remaining branches:\n${remaining}` : "") +
          `\nOr 'git rebase --abort' to back out this branch.`,
      );
    }
  }

  console.log("\nDone. To undo:");
  for (const b of chain) console.log(`  git branch -f ${b} ${oldTip[b].slice(0, 9)}`);

  if (push) {
    console.log("\nPushing chain with --force-with-lease...");
    for (const b of chain) {
      if (!pushBranch(b)) fail(`Push failed for ${b}.`);
    }
  }
}

const script: CScriptScript = {
  description: "Restack a whole stacked-PR chain onto a new base (current branch = top of stack).",
  help: `Usage: cscript restack <target> [--push] [-y|--yes]

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
-y). On a conflict the restack stops and prints how to finish the current
branch plus the exact commands for the remaining ones.

Limitations: assumes a linear stack — one branch per commit tip and no merge
commits in <target>..HEAD. Ambiguous topology fails with a clear message.

Options:
  --push      After a clean restack, force-with-lease push every branch in the
              chain to its upstream.
  -y, --yes   Skip the confirmation prompt.

Examples:
  cscript restack origin/master
  cscript restack origin/master --push`,
  run,
};

export default script;
