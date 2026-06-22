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
  if (r.code !== 0) fail("Detached HEAD — specify the feature branch explicitly.");

  return r.stdout;
}

function remoteForTarget(target: string): string | null {
  const slash = target.indexOf("/");
  if (slash === -1) return null;
  const candidate = target.slice(0, slash);
  const remotes = git(["remote"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean);

  return remotes.includes(candidate) ? candidate : null;
}

type Parsed = { target: string; feature: string; count: number; base: string; push: boolean; yes: boolean };

function parseArgs(args: string[]): Parsed {
  let push = false;
  let yes = false;
  const positional: string[] = [];
  for (const a of args) {
    if (a === "--push") push = true;
    else if (a === "-y" || a === "--yes") yes = true;
    else positional.push(a);
  }

  let target: string;
  let feature: string;
  let countArg: string;
  if (positional.length === 2) {
    [target, countArg] = positional;
    feature = currentBranch();
  } else if (positional.length === 3) {
    [target, feature, countArg] = positional;
  } else {
    fail("Usage: cscript rebase-stack <target> [feature] <count> [--push] [-y]");
  }

  const count = Number(countArg.replace(/^~/, ""));
  if (!Number.isInteger(count) || count < 1) {
    fail(`Invalid count: '${countArg}' (expected a positive integer, optionally prefixed with '~').`);
  }

  return { target, feature, count, base: `${feature}~${count}`, push, yes };
}

function bullets(oneline: string): string {
  return oneline ? oneline.split("\n").map((l) => `  ${l}`).join("\n") : "  (none)";
}

function run(args: string[]): void {
  const { target, feature, count, base, push, yes } = parseArgs(args);

  const remote = remoteForTarget(target);
  if (remote) {
    console.log(`Fetching ${remote}...`);
    gitInherit(["fetch", remote]);
  }

  if (!verify(target)) fail(`Target ref not found: ${target}`);
  if (!verify(feature)) fail(`Feature ref not found: ${feature}`);
  if (!verify(base)) {
    fail(`${feature} has fewer than ${count} commit(s) above its root; cannot resolve ${base}.`);
  }

  const replay = git(["log", "--oneline", "--reverse", `${base}..${feature}`]).stdout;
  const dropped = git(["log", "--oneline", `${target}..${base}`]).stdout;
  const originalSha = git(["rev-parse", feature]).stdout;

  console.log(`\ngit rebase --autostash --onto ${target} ${base} ${feature}\n`);
  console.log(`Replaying these ${count} commit(s) onto ${target}:`);
  console.log(bullets(replay));
  console.log(`\nDropping from under ${feature} (no longer ancestors):`);
  console.log(bullets(dropped));

  if (!yes && (prompt("\nProceed? y/[N]:") ?? "").trim().toLowerCase() !== "y") {
    console.log("Aborted.");

    return;
  }

  const code = gitInherit(["rebase", "--autostash", "--onto", target, base, feature]);
  if (code !== 0) {
    fail(
      "\nRebase did not complete. Resolve conflicts then run 'git rebase --continue', " +
        "or 'git rebase --abort' to back out.",
    );
  }

  console.log(`\nDone. To undo: git reset --hard ${originalSha}`);

  if (push && gitInherit(["push", "--force-with-lease"]) !== 0) fail("Push failed.");
}

const script: CScriptScript = {
  description: "Rebase the top N commits of a branch onto a new base (stacked-PR restack).",
  help: `Usage: cscript rebase-stack <target> [feature] <count> [--push] [-y|--yes]

Replays the top <count> commits of <feature> onto <target>, dropping the
commits beneath them. Equivalent to:

  git rebase --autostash --onto <target> <feature>~<count> <feature>

Arguments:
  <target>   New base to rebase onto (e.g. origin/master).
  [feature]  Branch to restack. Defaults to the current branch.
  <count>    Number of commits to keep from the tip. Accepts 2 or ~2.

If <target> is a remote ref (e.g. origin/master), that remote is fetched
first so you rebase onto its current tip. A dirty working tree is stashed
and restored automatically (--autostash).

Before rebasing, the resolved command and the commits to replay/drop are
printed for confirmation (skip with -y).

Options:
  --push      After a successful rebase, git push --force-with-lease.
  -y, --yes   Skip the confirmation prompt.

Examples:
  cscript rebase-stack origin/master ~2
  cscript rebase-stack origin/master feature/my-branch 2 --push`,
  run,
};

export default script;
