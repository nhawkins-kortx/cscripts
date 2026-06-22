import { spawnSync } from "node:child_process";
import type { CScriptScript } from "../types";

type Worktree = { path: string; branch: string };
type Failure = Worktree & { reason: string };

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });

  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function listWorktrees(): Worktree[] {
  const r = git(["worktree", "list", "--porcelain"]);
  if (r.code !== 0) {
    console.error(r.stderr.trim() || "Not a git repository.");
    process.exit(1);
  }

  return r.stdout
    .trim()
    .split("\n\n")
    .map((block) => block.split("\n"))
    .map((lines) => {
      const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
      const branchLine = lines.find((l) => l.startsWith("branch "));
      const branch = branchLine
        ? branchLine.slice("branch ".length).replace("refs/heads/", "")
        : "(detached)";

      return path ? { path, branch } : null;
    })
    .filter((w): w is Worktree => w !== null);
}

function reasonFor(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes("modified") || s.includes("untracked")) return "worktree dirty";
  if (s.includes("locked")) return "worktree locked";

  return stderr.trim().split("\n")[0] || "unknown error";
}

function parseSelection(input: string, max: number): number[] | null {
  const nums = input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => Number(s));
  if (nums.some((n) => !Number.isInteger(n) || n < 1 || n > max)) return null;

  return [...new Set(nums)];
}

function remove(path: string, force: boolean): { ok: boolean; stderr: string } {
  const args = force
    ? ["worktree", "remove", "--force", "--force", path]
    : ["worktree", "remove", path];
  const r = git(args);

  return { ok: r.code === 0, stderr: r.stderr };
}

function forceRemovePass(failed: Failure[]): void {
  console.log("\nFailed to remove the following worktrees:");
  failed.forEach((f, i) => console.log(`  ${i + 1}) ${f.path} — ${f.reason}`));

  const wantForce = (prompt("\nDo you want to force remove? y/[N]:") ?? "").trim().toLowerCase();
  if (wantForce !== "y") return;

  const input = (prompt("Choose the numbers you want to force remove (leave blank for 'all'):") ?? "").trim();
  const chosen = input === "" ? failed.map((_, i) => i + 1) : parseSelection(input, failed.length);
  if (!chosen || chosen.length === 0) {
    console.log("Nothing selected.");

    return;
  }

  for (const n of chosen) {
    const f = failed[n - 1];
    const res = remove(f.path, true);
    console.log(res.ok ? `Force-removed ${f.path}` : `Still failed: ${f.path} — ${reasonFor(res.stderr)}`);
  }
}

function run(): void {
  const worktrees = listWorktrees().slice(1);
  if (worktrees.length === 0) {
    console.log("No removable worktrees found.");

    return;
  }

  console.log("Worktrees:");
  worktrees.forEach((w, i) => console.log(`  ${i + 1}) ${w.path}  [${w.branch}]`));

  const selection = parseSelection(prompt("\nEnter numbers to remove (comma-separated):") ?? "", worktrees.length);
  if (!selection || selection.length === 0) {
    console.log("Nothing selected.");

    return;
  }

  const selected = selection.map((n) => worktrees[n - 1]);
  console.log("\nSelected:");
  selected.forEach((w) => console.log(`  ${w.path}  [${w.branch}]`));

  const confirm = (prompt(`\nRemove these ${selected.length} worktree(s)? y/[N]:`) ?? "").trim().toLowerCase();
  if (confirm !== "y") {
    console.log("Aborted.");

    return;
  }

  const failed: Failure[] = [];
  for (const w of selected) {
    const res = remove(w.path, false);
    if (res.ok) {
      console.log(`Removed ${w.path}`);
    } else {
      failed.push({ ...w, reason: reasonFor(res.stderr) });
    }
  }

  if (failed.length > 0) forceRemovePass(failed);
}

const script: CScriptScript = {
  description: "Remove git worktrees of the current repo interactively.",
  help: `Usage: cscript wt-remove

Lists every worktree of the current repo (excluding the main checkout),
each numbered. Enter a comma-separated list of numbers to remove the
corresponding worktrees, then confirm.

Worktrees that can't be removed (e.g. dirty or locked) are reported with a
reason. You're then offered a force-remove pass (git worktree remove
--force --force) where you pick which to force, or leave blank to force all.`,
  run,
};

export default script;
