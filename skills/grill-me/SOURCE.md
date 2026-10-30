# Source: grill-me

- Upstream: https://github.com/mattpocock/skills
- Commit: `59db609eb1e18aaf59b63284d0e52255aff0c63c`
- Path: `skills/productivity/grilling/SKILL.md`. Upstream `skills/productivity/grill-me/SKILL.md` is a one-line stub that calls `grilling`, so this adapts `grilling`.
- License: MIT (SPDX `MIT`), Copyright (c) 2026 Matt Pocock. The full text is in `LICENSE` beside this file.
- Retrieved: 2026-10-30, with `gh api -H "Accept: application/vnd.github.raw" "repos/mattpocock/skills/contents/<path>?ref=59db609eb1e18aaf59b63284d0e52255aff0c63c"`. The upstream `SKILL.md` had sha256 `befdff1e27a1dfe2a294d5871169ac1afe16d983911daa4f32627514a48c1e15` and `LICENSE` had sha256 `0e7ac423bf2c6e223b7c5b156f8cf72da49d748e56a1641402c31f22ad07dbb5`.

## Changes

- Kept the design tree, the frontier, "finding facts is your job" and "the decisions are the user's".
- Replaced "dispatch a sub-agent" with reading the checkout: the draft session reads with `read`, `grep` and `ls`; the controller runs a separate reviewer session with no tools.
- Replaced "wait for the user's answers" and the interactive round format with the structured `questions` output. The answers arrive in a later linked run.
- Renamed it `grill-me` and set `disable-model-invocation`, because it is a stage prompt and not a user skill.
