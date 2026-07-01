import { spawnSync } from "node:child_process";
import type { CScriptScript } from "../types";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
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

function run(args: string[]): void {
  parseArgs(args);
  fail("not implemented");
}

const script: CScriptScript = {
  description: "Amend the current commit and restack every dependent branch onto it.",
  help: `Usage: cscript amend-stack [-y|--yes] [--dry-run]`,
  run,
};

export default script;
