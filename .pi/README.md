# .pi

Pi project resources for sessions that work on this repository. Pi loads them when a session starts in this checkout. The factory never ships them to a stage sandbox.

| Path | Tracked | What it holds |
| --- | --- | --- |
| `skills/` | Yes | Coordinator skills. See `skills/README.md`. |
| `daily-log/` | No, ignored | Personal daily notes written by the `daily-log-pi-herdr-factorio` skill. |

Lint and format checks skip `.pi/`. `npm run check:layout` still checks its TypeScript imports and its shell scripts' path tokens.
