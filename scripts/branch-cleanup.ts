import { spawnSync } from "node:child_process";
import type { CScriptScript } from "../types";

type Category = "merged" | "gone" | "remote" | "local-only";
type Branch = { name: string; category: Category };

const GROUPS: { category: Category; header: (base: string) => string }[] = [
  { category: "merged", header: (base) => `Merged into ${base}:` },
  { category: "gone", header: () => "Gone (remote deleted - merged via PR):" },
  { category: "remote", header: () => "Remote (still on origin, not merged):" },
  { category: "local-only", header: () => "Local-only  ⚠ no backup:" },
];

function git(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { encoding: "utf8" });

  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function confirm(message: string): boolean {
  return !(prompt(message) ?? "").trim().toLowerCase().startsWith("n");
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function lines(stdout: string): string[] {
  return stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

function defaultBranch(): string {
  if (git(["show-ref", "--verify", "--quiet", "refs/heads/master"]).code === 0) return "master";
  if (git(["show-ref", "--verify", "--quiet", "refs/heads/main"]).code === 0) return "main";

  return "master";
}

function mergedSet(base: string): Set<string> {
  return new Set(lines(git(["branch", "--merged", base, "--format=%(refname:short)"]).stdout));
}

function remoteBranchNames(): Set<string> {
  const names = new Set<string>();
  for (const ref of lines(git(["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).stdout)) {
    const slash = ref.indexOf("/");
    if (slash > 0) names.add(ref.slice(slash + 1));
  }

  return names;
}

function classify(base: string): Branch[] {
  const merged = mergedSet(base);
  const remotes = remoteBranchNames();
  const current = git(["branch", "--show-current"]).stdout.trim();
  const rows = lines(git(["for-each-ref", "--format=%(refname:short)\t%(upstream:track)", "refs/heads"]).stdout);

  const branches: Branch[] = [];
  for (const row of rows) {
    const [name, track = ""] = row.split("\t");
    if (name === base || name === "master" || name === "main" || name === current) continue;

    const category: Category = merged.has(name) ? "merged"
      : track.includes("gone") ? "gone"
      : remotes.has(name) ? "remote"
      : "local-only";
    branches.push({ name, category });
  }

  return branches;
}

function printList(base: string, branches: Branch[]): Branch[] {
  const ordered: Branch[] = [];
  const counts: string[] = [];
  for (const group of GROUPS) {
    const inGroup = branches.filter((b) => b.category === group.category);
    if (inGroup.length === 0) continue;
    counts.push(`${inGroup.length} ${group.category}`);
    console.log(group.header(base));
    for (const b of inGroup) {
      ordered.push(b);
      console.log(`  ${ordered.length}) ${b.name}`);
    }
  }
  console.log(`\n${branches.length} branch(es): ${counts.join(", ")}`);

  return ordered;
}

const KEYWORDS: Category[] = ["merged", "gone", "remote", "local-only"];

function parseSelection(input: string, ordered: Branch[]): Branch[] | null {
  const selected = new Set<Branch>();
  for (const item of input.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (item === "all") {
      ordered.forEach((b) => selected.add(b));
    } else if ((KEYWORDS as string[]).includes(item)) {
      ordered.filter((b) => b.category === item).forEach((b) => selected.add(b));
    } else {
      const n = Number(item);
      if (!Number.isInteger(n) || n < 1 || n > ordered.length) return null;
      selected.add(ordered[n - 1]);
    }
  }

  return [...selected];
}

function run(args: string[]): void {
  const noFetch = args.includes("--no-fetch");
  if (args.some((a) => a !== "--no-fetch")) fail("Usage: cscript branch-cleanup [--no-fetch]");
  if (git(["rev-parse", "--git-dir"]).code !== 0) fail("Not a git repository.");

  if (noFetch) {
    console.log("(--no-fetch) remote/gone status reflects your last fetch.");
  } else {
    const f = git(["fetch", "--prune"]);
    if (f.code !== 0) console.error(f.stderr.trim() || "git fetch failed; using last-known remote state.");
  }

  const base = defaultBranch();
  const branches = classify(base);
  if (branches.length === 0) {
    console.log("No deletable local branches found.");

    return;
  }

  const ordered = printList(base, branches);

  const input = (prompt("\nEnter numbers or keywords to delete (e.g. 1,3 or merged,gone or all):") ?? "").trim();
  if (input === "") {
    console.log("Nothing selected.");

    return;
  }

  const selected = parseSelection(input, ordered);
  if (selected === null) {
    console.log("Invalid selection.");

    return;
  }
  if (selected.length === 0) {
    console.log("Nothing selected.");

    return;
  }

  console.log("\nSelected:");
  selected.forEach((b) => console.log(`  ${b.name}  [${b.category}]`));
  if (!confirm(`\nDelete these ${selected.length} branch(es)? [Y]/n:`)) {
    console.log("Aborted.");

    return;
  }

  const localOnly = selected.filter((b) => b.category === "local-only");
  if (localOnly.length > 0) {
    console.log("\nThese have no remote backup and will be force-deleted:");
    localOnly.forEach((b) => console.log(`  ${b.name}`));
    if (!confirm(`Force-delete these ${localOnly.length} local-only branch(es)? [Y]/n:`)) {
      console.log("Aborted.");

      return;
    }
  }

  for (const b of selected) {
    const res = git(["branch", "-D", b.name]);
    console.log(res.code === 0 ? `Deleted ${b.name}` : `Failed: ${b.name} - ${res.stderr.trim().split("\n")[0]}`);
  }
}

const script: CScriptScript = {
  description: "Delete local git branches interactively, grouped by how safe they are to delete.",
  help: `Usage: cscript branch-cleanup [--no-fetch]

Lists every local branch (except the current one and master/main), numbered and
grouped by how safe it is to delete:

  merged      reachable from master/main (provably in the default branch)
  gone        upstream was deleted on the remote (merged PR, branch cleaned up)
  remote      upstream still exists on the remote, not merged
  local-only  never pushed; force-deleting discards unbacked work

Runs 'git fetch --prune' first so remote/gone are accurate; --no-fetch skips it
and uses your last-known remote state.

At the prompt enter a comma-separated mix of numbers (e.g. 1,3,5), category
keywords (merged, gone, remote, local-only), or 'all'. Blank aborts. Selected
local-only branches need a second confirm. All deletes use 'git branch -D'.`,
  run,
};

export default script;
