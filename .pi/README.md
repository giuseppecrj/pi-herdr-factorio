# .pi

This folder holds Pi project resources for sessions that work on this repository. Pi loads them when a session starts in this checkout. The factory never ships them to a stage sandbox.

| Path | Tracked | What it holds |
| --- | --- | --- |
| `skills/` | Yes | Coordinator skills. See `skills/README.md`. |
| `daily-log/` | No, ignored | Personal daily notes written by the `daily-log-pi-herdr-factorio` skill. |

`npm run check` typechecks, lints and formats the TypeScript in `skills/`, and `npm run check:layout` checks its imports and its shell scripts' path tokens. Nothing outside `skills/` is checked, and the trusted gate never copies it from a candidate.
