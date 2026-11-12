# tools

This folder holds build tools that the checks load. Nothing here ships or runs in the factory.

| Path | What it is |
| --- | --- |
| `oxlint/anti-slop/` | A vendored Oxlint plugin. `.oxlintrc.json` loads it, and `npm run lint` applies its rules. This repository owns the copy; `UPSTREAM.md` records its origin and `LICENSE` its license. Lint skips this folder itself. |

Add a rule as a file in `oxlint/anti-slop/rules/`, register it in `oxlint/anti-slop/index.ts`, and enable it in `.oxlintrc.json`.
