# cscript

A tiny dispatcher for personal scripts. Drop a TypeScript file in `scripts/`
and it's instantly runnable via `cscript <name>` — no new shim, no PATH edits.

## Usage

    cscript list                     # list available scripts + descriptions
    cscript <name> [args...]         # run a script
    cscript <name> help|--help|-h    # show a script's help
    cscript help|--help|-h           # show cscript's own help

## Adding a script

Create `scripts/<name>.ts` that default-exports a `CScriptScript`:

    import type { CScriptScript } from "../types";

    const script: CScriptScript = {
      description: "One-line summary shown by `cscript list`.",
      help: `Usage: cscript <name>\n\nLonger help text...`,
      run: (args) => {
        // ...
      },
    };

    export default script;

The file name (without `.ts`) is the command name. `cscript` discovers it
automatically — nothing else to wire up.

## Install

`cscript` runs on [Bun](https://bun.sh). The single shim is a symlink on your
PATH pointing at `cscript.ts`:

    ln -s ~/Git/scripts/cscript.ts ~/.local/bin/cscript

## Tab-completion (zsh)

`completions/_cscript` completes subcommands, flags, and script names
(`cscript <Tab>` lists every script, `cscript <name> <Tab>` offers help
flags). It reads `scripts/` live, so new scripts complete automatically.

Add the completions dir to `fpath` **before** `compinit` runs in `~/.zshrc`:

    fpath=("$HOME/Git/scripts/completions" $fpath)
    autoload -Uz compinit && compinit

Then open a new shell (or `exec zsh`). The `scripts_dir` path inside
`_cscript` is hardcoded to this repo's location — update it if the repo moves.
