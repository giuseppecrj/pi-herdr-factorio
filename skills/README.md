# Skills

These are the factory's stage skills. The specify stage runs `audit-ticket`, `grill-me` and `deep-research`, in that order. Accept runs `acceptance` in a fresh sandbox session with the immutable contract and trusted base only. Build runs `build` with the applicable Feature or Bug fix playbook read from the pinned pstack dependency in that same bundle. It receives no suite or previous session.

`server/provision.sh` copies every skill directory into the sandbox bundle at `skills/`, so the bundle digest in each stage receipt names the exact skill text that ran. The stage executor reads each `SKILL.md` from the bundle on the host and appends it to the stage prompt. The stage Pi runs with `--no-skills`, so it loads no other skill.

Each skill sets `disable-model-invocation`, because it is a stage prompt and not a skill for an interactive session.

| Skill | Upstream | License | `SOURCE.md` |
| --- | --- | --- | --- |
| `audit-ticket` | none, a clean-room rewrite | this repository's MIT | `audit-ticket/SOURCE.md` |
| `acceptance` | none, clean-room scenario-holdout skill | this repository's MIT | `acceptance/SOURCE.md` |
| `build` | factory protocol plus bundled pstack playbook | repository MIT and pstack's bundled license | `build/SOURCE.md` |
| `grill-me` | `mattpocock/skills` `grilling` at `59db609` | MIT, Matt Pocock, `grill-me/LICENSE` | `grill-me/SOURCE.md` |
| `deep-research` | `mattpocock/skills` `research` at `59db609` | MIT, Matt Pocock, `deep-research/LICENSE` | `deep-research/SOURCE.md` |
