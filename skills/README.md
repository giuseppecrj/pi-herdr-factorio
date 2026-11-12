# Skills

These skills ship in the stage sandbox bundle and run inside factory stages. Coordinator skills for interactive Pi sessions live in `.pi/skills/` instead. To add a stage skill, create `<name>/SKILL.md` with `SOURCE.md`, plus a `LICENSE` only when the skill has its own upstream license. Add its name to the stage's skill list in `src/`, and add it to the table below. The lists are `SPECIFY_SKILLS` in `src/specify.ts`, `ACCEPTANCE_SKILLS` in `src/accept.ts`, `CADENCE_SKILLS` in `src/cadence.ts`, and the build and feedback-repair lists (`["build"]` and `["build", "address-pr-comments"]`) inline in `src/orchestrator.ts`.

These are the factory's stage skills. The specify stage runs `audit-ticket`, `grill-me` and `deep-research`, in that order. Accept runs `acceptance` in a fresh sandbox session with the immutable contract and trusted base only. Build runs `build` with the applicable Feature or Bug fix playbook excerpt read from the pinned pstack dependency in that same bundle. A published feedback repair also runs `address-pr-comments`, with controller-selected owner cards and no GitHub write authority. It receives no suite or previous session. Review runs fresh sequential code-review, security-review and simplify seats, plus ultrareview for deterministic risk paths. The security seat alone has a refusal fallback.

`server/provision.sh` copies every skill directory into the sandbox bundle at `skills/`, so the bundle digest in each stage receipt names the exact skill text that ran. The stage executor reads each `SKILL.md` from the bundle on the host and appends it to the stage prompt. The stage Pi runs with `--no-skills`, so it loads no other skill.

Each skill sets `disable-model-invocation`, because it is a stage prompt and not a skill for an interactive session.

| Skill | Upstream | License | `SOURCE.md` |
| --- | --- | --- | --- |
| `audit-ticket` | none, a clean-room rewrite | this repository's MIT | `audit-ticket/SOURCE.md` |
| `acceptance` | none, clean-room scenario-holdout skill | this repository's MIT | `acceptance/SOURCE.md` |
| `build` | factory protocol plus bundled pstack playbook | repository MIT and pstack's bundled license | `build/SOURCE.md` |
| `address-pr-comments` | `mnapoli/skill-address-pr-review` at `db7024d` | MIT, Matthieu Napoli, `address-pr-comments/LICENSE` | `address-pr-comments/SOURCE.md` |
| `grill-me` | `mattpocock/skills` `grilling` at `59db609` | MIT, Matt Pocock, `grill-me/LICENSE` | `grill-me/SOURCE.md` |
| `code-review` | `anthropics/claude-plugins-official` at `f8c5e7a` | Apache-2.0, `code-review/LICENSE` | `code-review/SOURCE.md` |
| `security-review` | `anthropics/claude-code-security-review` at `0c6a49f` | MIT, `security-review/LICENSE` | `security-review/SOURCE.md` |
| `simplify` | none, written fresh | repository MIT | `simplify/SOURCE.md` |
| `ultrareview` | none, written fresh | repository MIT | `ultrareview/SOURCE.md` |
| `deep-research` | `mattpocock/skills` `research` at `59db609` | MIT, Matt Pocock, `deep-research/LICENSE` | `deep-research/SOURCE.md` |

## Maintenance audits

The `maintain` sandbox stage runs a single-pass weekly audit with no tools, a read-only pinned main tree, and model-only egress. Architecture, security, instructions and hygiene use the skills below. Reflect uses both `reflect-ledger` and `agent-loop-spec` over bounded redacted ledger rows, scores and source lines, never private sessions. Each audit returns JSON proposals or an empty no-delta list. Only the controller files `factory:proposed` issues; it never labels them ready or changes skills, prompts or gates. See [cadence](../docs/operations/cadence.md).

| Skill | Upstream | License | `SOURCE.md` |
| --- | --- | --- | --- |
| `improve-codebase-architecture` | `mattpocock/skills` architecture, domain-modeling and vocabulary at `59db609` | MIT, Matt Pocock, `improve-codebase-architecture/LICENSE` | `improve-codebase-architecture/SOURCE.md` |
| `audit-instructions` | `desertcache/agent-os` at `211bd89` | MIT, desertcache, `audit-instructions/LICENSE` | `audit-instructions/SOURCE.md` |
| `agent-loop-hygiene` | owner's work at `b7f7c33` | owner-authored, no upstream licence; selected in the approved design and plan, adapted under autonomous-run | `agent-loop-hygiene/SOURCE.md` |
| `reflect-ledger` | pstack reflect via pi-herdr-pstack 0.6.0, pinned source hashes and upstream commits in SOURCE | MIT, Lauren Tan, `reflect-ledger/LICENSE` | `reflect-ledger/SOURCE.md` |
| `agent-loop-spec` | owner's work at `8495754` | owner-authored, no upstream licence; adapted under the approved F12 plan and builder brief, including disclosure of a Cursor Agent-authored upstream commit | `agent-loop-spec/SOURCE.md` |

## Human review

Sandboxed model stages have no GitHub write authority; the trusted controller handles GitHub publication and progress reporting. The candidate must pass exact-head CI and review before the controller opens a ready, non-draft PR labeled `factory:review`. The factory then waits for the owner and never merges or arms auto-merge. See the [owner guide](../docs/operations/human-review.md).
