# Design: per-script tab-completion + `[Y]/n` prompts

## Goal

Two changes to the `cscript` dispatcher and its git scripts:

1. **Scalable, per-script tab-completion.** Each script supplies its own
   completion logic via a callback on the exported `CScriptScript`. The
   framework stays generic — it knows nothing about git. `restack` and
   `rebase-stack` use this to complete git branch and remote-tracking refs.
2. **Flip y/n confirmation prompts** from `y/[N]` (default No) to `[Y]/n`
   (default Yes) everywhere they appear in both scripts.

## Background

- `cscript.ts` is a dispatcher: each `scripts/<name>.ts` default-exports a
  `CScriptScript` (`{ description, help, run }`); the filename is the command.
- `completions/_cscript` is a generic zsh completion that reads `scripts/`
  live. Today it completes subcommands, script names, and `help`/`-h` flags —
  but not argument values.
- `restack <target>` and `rebase-stack <target> [feature] <count>` take git
  refs as positional arguments. `<target>` is usually a remote ref like
  `origin/master`.
- Both scripts confirm before acting via `prompt("... y/[N]:")` and proceed
  only on a literal `y`.

## Architecture

The completion design follows the cobra / `kubectl` / `gh` pattern: a hidden
`__complete` command calls back into the program, and **the program decides the
candidates**. The shell is a dumb pipe.

### 1. `complete` callback on the type (`types.ts`)

```ts
export type CScriptScript = {
  description: string;
  help: string;
  run: (args: string[]) => void | Promise<void>;
  complete?: (args: string[]) => string[] | Promise<string[]>;
};
```

**`args` contract:** the words typed after the script name, up to and
including the word currently being completed (the last element, possibly the
empty string). Therefore:

- `args.length` tells the script which positional slot is being completed.
- Earlier elements give context (a script may complete arg 2 based on arg 1).
- The shell prefix-filters whatever list the script returns, so the script
  need not filter by the partial word itself.
- It may be async (mirrors `run`), so candidates can come from a network/API.

This is fully general — git refs, file paths, enum values, dynamic lists. The
framework knows about none of them.

### 2. Each script implements its own `complete`

Self-contained, duplicating the small git helper exactly as the existing
`git`/`verify` helpers are duplicated across scripts.

```ts
// shared shape in each script
function gitRefs(): string[] {
  return git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
    .stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

// restack.ts — only <target> is a ref
complete: (args) => {
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional.length === 1 ? gitRefs() : [];
}

// rebase-stack.ts — <target> and [feature] are refs; <count> is not
complete: (args) => {
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional.length <= 2 ? gitRefs() : [];
}
```

Flag handling (`-y`/`--yes`) lives in the script because flags are the
script's business; the framework stays generic. Counting non-flag words means
`-y` anywhere in the line does not shift the positional slot.

### 3. Hidden `__complete` dispatcher (`cscript.ts`)

```
cscript __complete <script> <word1> <word2> … <currentPartial>
```

- Handled in `main()` **before** the unknown-script check, so it never errors
  out the way an unknown command would.
- Loads the script, `await`s `script.complete?.(words)`, prints candidates one
  per line.
- **Wrapped in try/catch** — any failure (bad index, missing script, git
  error, not a repo) prints nothing and exits 0, so a broken state never
  sprays text into the prompt.
- It is not a file in `scripts/`, so `cscript list` never shows it.

### 4. Generic zsh glue (`completions/_cscript`)

For `cscript <script> …` + Tab, the completion passes the words from after the
script name through the cursor to `cscript __complete <script> …` and
`compadd`s the returned candidates. It still offers the universal
`help`/`--help`/`-h` at the first argument slot via `_alternative`. No script
names are hardcoded — any script that defines `complete` gets completion
automatically with zero edits here.

The trailing (possibly empty) current word is passed through so `args.length`
on the script side reflects the slot being completed.

### 5. `[Y]/n` prompt flip (both scripts)

Every y/n confirmation prompt:

- Text changes from `... y/[N]:` to `... [Y]/n:`.
- Default flips to **yes**: proceed unless the trimmed, lowercased answer
  **starts with `n`** (`n`, `no`, `nope` → abort; empty / Enter / `y` /
  anything else → proceed).

Affected prompts:

- `rebase-stack`: `Proceed?` and `Push <feature> with --force-with-lease?`
- `restack`: `Proceed?` (both the initial and post-recovery confirmations) and
  `Push N branch(es) with --force-with-lease?`

**Unchanged:** restack's squash-merge recovery prompt — it asks for a *branch
name or blank*, not yes/no.

**Behavior change (intended):** hitting Enter at any of these prompts now
proceeds, including the force-with-lease push.

## Testing

- **Completion** (integration, spawning `cscript __complete` in throwaway repos
  with a bare `origin`, matching the existing test harness):
  - `restack` slot 1 returns refs including remote-tracking refs.
  - `restack` slot 2 returns empty.
  - `rebase-stack` slot 2 returns refs; slot 3 returns empty.
  - A script with no `complete` returns empty.
  - Non-repo / git error returns empty and exit 0.
  - A `-y` among the words does not shift the positional slot.
- **Prompts:**
  - Existing `"y\nn\n"` stdin tests still pass (`y` does not start with `n`).
  - Add: Enter / empty answer proceeds; an `n` answer aborts.

## Docs

- `README.md`: document the `complete` callback and its `args` contract in the
  tab-completion section, plus the import-on-Tab caveat — scripts must stay
  side-effect-free at module load, since Tab now imports them.
- `AGENTS.md`: note the `complete` field and the side-effect-free-on-import
  requirement alongside the existing conventions.

## Out of scope

Cobra-style completion **directives** (NoSpace, NoFileComp, etc.) returned
alongside candidates. No current script needs one; adding it later is an
additive change to the callback's return type.
