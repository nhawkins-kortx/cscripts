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

Cloning the repo isn't enough on its own — these one-time steps wire it up:

1. Install [Bun](https://bun.sh) (the runtime `cscript` runs on).
2. Clone anywhere, then symlink the shim onto your PATH (`~/.local/bin` must
   be on `$PATH`); substitute your clone path:

       ln -s /path/to/scripts/cscript.ts ~/.local/bin/cscript

3. (Optional) Wire up tab-completion — see below.
4. Open a new shell, then `cscript list` to confirm.

Both `cscript` and its completion resolve the scripts directory from the
installed shim's location, so any clone path works with no extra config. To
point them at a different directory, set `CSCRIPT_SCRIPTS_DIR`:

    export CSCRIPT_SCRIPTS_DIR="$HOME/my-scripts"

## Tab-completion (zsh)

`completions/_cscript` completes subcommands, flags, and script names
(`cscript <Tab>` lists every script, `cscript <name> <Tab>` offers help
flags). It reads `scripts/` live, so new scripts complete automatically.

A script can also complete its own arguments by adding a `complete` callback to
its exported `CScriptScript`:

    complete: (args) => string[] | Promise<string[]>

`args` is the words typed after the script name, up to and including the word
being completed (the last element, possibly `""`). So `args.length` tells you
which slot is being completed and the earlier elements give context; the shell
prefix-filters whatever list you return. `restack` and `rebase-stack` use this
to complete git refs for their target/feature arguments:

    complete: (args) => {
      const positional = args.filter((a) => !a.startsWith("-"));
      return positional.length === 1 ? gitRefs() : [];
    }

The framework knows nothing about git — a callback can return file paths, enum
values, or anything else, sync or async. The shell asks for candidates via the
hidden `cscript __complete <name> <words...>` command, which loads the script
and calls its `complete`. **Because Tab now imports the script, scripts must
stay side-effect-free at module load** — define the object and helpers, but do
no work at the top level. Errors during completion are swallowed so they never
disturb the prompt.

Add the completions dir to `fpath` **before** `compinit` runs in `~/.zshrc`:

    fpath=("$HOME/Git/scripts/completions" $fpath)
    autoload -Uz compinit && compinit

Then open a new shell (or `exec zsh`). The completion resolves the scripts
directory from the `cscript` shim (or `CSCRIPT_SCRIPTS_DIR` if set), so it
needs no path configuration.
