# scripts

This folder holds repository tools that a person or `npm run check` runs from the repository root. None of them run inside the factory. The trusted gate copies this folder from the candidate, like `src/`.

| Script | Run by | What it does |
| --- | --- | --- |
| `check-layout.mjs` | `npm run check:layout`, `npm run check` | Runs the layout guard against HEAD and the working tree. See below. |
| `layout-baseline.json` | `check-layout.mjs` | What the layout guard expects: file owners and review seats, allowed reverse imports, path readers, allowed path literals, shell path tokens and the trusted gate's test selection. |
| `check-decisions.mjs` | `npm run check:decisions`, `npm run check` | Checks `docs/decisions.tsv` against `decisions-checkpoint.json`. |
| `decisions-checkpoint.json` | `check-decisions.mjs` | The row count, byte length and SHA-256 of the committed decisions prefix. |
| `design-tokens.mjs` | A person, after a Shep update | Generates `host/viewer/design/tokens.css` from `tokens.json`. Run `node scripts/design-tokens.mjs sync --shep <dir>` from a pinned Shep revision. Never edit `tokens.css` by hand. |
| `provenance.sh` | A person | Regenerates `research/PROVENANCE.md` from the local-only `research/upstream/` captures. |
| `herdr-probe.sh` | A person | A disposable Herdr and Pi RPC experiment. It is not part of any check. |

## Layout guard

`node scripts/check-layout.mjs [--root DIR] [--only CATEGORY,...] [--json]` prints one line per problem and exits 1 if there are any. It reads no Git history and makes no network request, so it runs the same in a depth-1 clone and in the trusted gate's exported tree. Its categories are:

- `imports` fails a relative import whose target is missing, and every `src` to `server` or `host` import, type-only imports included. L05 retired the `imports.reverseEdges` allowance, so the guard also fails a baseline that lists it again. It fails an exception that no longer exists.
- `classification` fails a file under `src/` or `host/` with no entry in `classification.files`, an entry whose file is gone, and a file whose `reviewSeats` are fewer than its entry or its sources require.
- `readers` checks each code path that finds another file by name or depth, including each test that reads a repository file at runtime (the `test-reads-*` entries). Each named snippet must appear the recorded number of times, each named target must exist with the recorded kind, and each constant must be declared exactly once. It also runs `replayStageCaps` against the working tree. When you move a target, update its entry in `readers`. When a test starts reading a repository file at runtime, add the read to that test's `test-reads-*` entry.
- `literals` checks every string literal in TypeScript and JavaScript outside the folders in `literals.exclude` (`test/` and the frozen prototypes among them), and every string in the configs listed in `literals.configs`, that names a repository path. Each one must exist with the kind it implies: a file, a folder for a trailing `/`, a prefix of some file for an open template, or a glob that matches a file. It also fails a `tsconfig.json` `include` entry that matches no file. Tests are left out because they name synthetic paths for temporary repositories and fake diffs; their real reads are `readers` entries. To resolve a failure, fix the path. If the path is meant not to exist, add it to `literals.allow` with a reason and the files that may name it. An allow path or glob that no literal still needs also fails, so delete it when its last user goes.
- `shell` fails a path token added to or removed from an inventoried shell script, a token whose target is missing, and a heredoc import of a name the target no longer exports.
- `discovery` fails a test file outside the `npm test` and `npm run test:integration` globs, and a `.cases.ts` file that is not imported exactly once by exactly one discovered test. Type-only imports do not count. It also checks parity with the trusted gate, which selects tests from `discovery.trusted.manifest` (`testGlobs` in `.github/factory/gates/gates.json`) through the code in `discovery.trusted.materializer` (`host/gates/manifest.ts`, `materialize.ts` and `gates.ts`). The `testGlobs` must be a non-empty list without duplicates, each accepted by the gate and matching a file. Every test the local runner runs must also run under trusted discovery, and the reverse. The pinned selection expressions in `discovery.trusted.predicates` must each appear once. `test/acceptance/**` and `test/fixtures/**` are excluded, as `discovery.exclude` records. To resolve a parity failure, change the runner globs and `testGlobs` together. If `host/gates/gates.ts` moves or its selection code changes, audit the new selection code, then update `discovery.trusted.materializer` and the file-scoped expressions in `discovery.trusted.predicates` to match it. The manifest owns the accepted globs; each predicate names the implementation file that owns it.
- `navigation` fails a top-level folder, `.pi/` or `.pi/skills/` without a `README.md`.
- `citations` checks `path:line` citations in current Markdown. `docs/README.md` explains the rule.

When a PR moves a file, it updates the matching entries in `layout-baseline.json` and appends the move to `docs/history/path-map.md`.

## Decisions guard

`node scripts/check-decisions.mjs [--root DIR] [--json]` checks the six-column header, that each row has six non-empty cells, and that timestamps are valid UTC times in order. It also checks that the first `bytes` bytes of `docs/decisions.tsv` still have the recorded SHA-256. It cannot tell which tool appended a row. Only the coordinator appends rows, with `log.sh`. Leave the checkpoint fixed when rows are appended. Advance it only after a lane with full history proves the previous prefix unchanged.
