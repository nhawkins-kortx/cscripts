#!/usr/bin/env bun
import { readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CScriptScript } from "./types";

const HELP_FLAGS = new Set(["help", "--help", "-h"]);

const scriptsDir =
  process.env.CSCRIPT_SCRIPTS_DIR ?? join(dirname(realpathSync(import.meta.path)), "scripts");

function scriptNames(): string[] {
  return readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => f.slice(0, -3))
    .sort();
}

async function loadScript(name: string): Promise<CScriptScript> {
  const mod = await import(join(scriptsDir, `${name}.ts`));

  return mod.default as CScriptScript;
}

function usage(): void {
  console.log(`cscript — run scripts from ${scriptsDir}

Usage:
  cscript list                     List available scripts.
  cscript <name> [args...]         Run a script.
  cscript <name> help|--help|-h    Show a script's help.
  cscript help|--help|-h           Show this help.`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || HELP_FLAGS.has(cmd)) {
    usage();

    return;
  }

  if (cmd === "list") {
    const names = scriptNames();
    if (names.length === 0) {
      console.log("No scripts found.");

      return;
    }
    const width = Math.max(...names.map((n) => n.length));
    for (const name of names) {
      const { description } = await loadScript(name);
      console.log(`  ${name.padEnd(width)}  ${description}`);
    }

    return;
  }

  if (!scriptNames().includes(cmd)) {
    console.error(`Unknown script: ${cmd}\nRun 'cscript list' to see available scripts.`);
    process.exit(1);
  }

  const script = await loadScript(cmd);

  if (rest[0] && HELP_FLAGS.has(rest[0])) {
    console.log(script.help);

    return;
  }

  await script.run(rest);
}

if (import.meta.main) {
  await main();
}
