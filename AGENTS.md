# Agent guidance for `cscript`

A tiny Bun-based dispatcher for personal scripts. Each script is a TypeScript
file in `scripts/` that default-exports a `CScriptScript` (`{ description, help,
run }`); the filename is the command name. See `README.md` for the full picture.

## Git workflow

This project pushes directly to `master`. No feature branch, no PR — commit on
`master` and push. (This overrides the usual "branch off the default branch"
default.)

## Running

    bun cscript.ts <name> [args...]      # run a script
    bun cscript.ts <name> help           # show a script's help

## Tests

    bun test                             # run everything
    bun test scripts/restack.test.ts     # one file

Tests use Bun's built-in runner (`bun:test`). The git-touching scripts are
covered by integration tests that build throwaway repos under `os.tmpdir()` —
including a bare repo as `origin` for push paths — so they run fully offline and
never touch this repo's own git state. Clean up temp dirs in `afterEach`.

## Conventions

- Scripts are self-contained and duplicate the small git helpers (`git`,
  `gitInherit`, `verify`, etc.) rather than sharing a module. Match that shape.
- No type defs / tsconfig in this repo, so a standalone `tsc` run reports
  missing `node`/`bun` globals — that noise is expected; trust `bun test`.
