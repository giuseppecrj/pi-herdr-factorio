# Owner skill audit

Audit of `~/dotfiles/agents/skills/*` and `~/.pi/agent/pi-honcho/skills/*` against the factory stages in `research/SYNTHESIS.md`. Performed by a read-only child (claude-sonnet-5-5) on 2026-10-28. The parent spot-checked the cited lines. Full transcript stays in the local session.

## Verdict

No owner skill replaces an upstream or pstack skill. Two are worth adapting as the factory's self-improvement job. The rest stay out.

| Skill | Factory slot | Verdict | Main reason |
| --- | --- | --- | --- |
| agent-loop-spec | Self-improvement spec; research step for metric tickets | adapt | Only skill anywhere that defines a metric, baseline and keep-or-reject rule (`SKILL.md:59-63`). |
| agent-loop-hygiene | Scheduled audit of recent factory runs | adapt | Treats missing evidence as unknown and checks the passing revision is the head (`SKILL.md:21-22`, `:33-35`). Defaults to recommendations (`:73-75`). |
| council | none on hosted runners | keep out | Needs other vendors' CLIs and keys (`SKILL.md:33-41`). Reviews plans, not diffs. Its `pi -p --no-session --no-mcp --tools read,grep,find,ls` row is the pattern ultrareview should use. |
| agent-release-waves | none in v1 | keep out | Overlaps pstack swarm and orchestrate, and assumes Herdr worktrees. |
| autonomous-delivery | none | keep out | An adaptive orchestrator conflicts with fixed stages. Its recurring-work contract (watermark, overlap, no-delta-no-task, `SKILL.md:211-238`) is a design reference for the scheduler. |
| daily-log-init | none | keep out | Personal, untracked log. The run ledger replaces it. |
| rewrite-in-my-voice | none | keep out | Factory output must not read as authored by Giuseppe (`SKILL.md:56`). |
| setup-github-runner | runner docs only | keep out | Host-specific paths, `sudo`, classic PAT. |
| verify-manual-github-ops-workflows (learned) | authoring checklist for the factory workflow | reference | Isolated run blocks, stub only irreversible boundaries, pin action refs, no persisted checkout credentials (`SKILL.md:12-17`). |
| diagnose-stacked-ci-gas-snapshot-failures (learned) | none | keep out | Foundry-specific. Its lesson that a green early stage hides skipped later steps belongs in the gate stage. |
| preserve-uncommitted-worktree-without-commits (learned) | none | keep out | Depends on Herdr worktree tools. |

## Gaps no existing skill fills

1. audit-ticket. Clean-room rewrite.
2. ultrareview and simplify. Our own implementations. `interrogate` and `unslop` are the closest bases, but `interrogate` launches `subagent` children, which need Herdr, so on a hosted runner it becomes sequential `pi -p --model <id>` calls.
3. A scheduler for the cadence jobs.
4. A closed self-improvement loop. Spec and hygiene measure and recommend; pstack `reflect` proposes skill edits but reads transcripts. The factory needs a run ledger as the data source.
5. Headless publish and merge. pstack's shipping and opening-a-pr playbooks were not yet checked for headless use.

## Correction to the child's report

The child flagged `disable-model-invocation: true` as a packaging blocker. It is not one. Pi documents that the flag only hides a skill from automatic selection, and an explicit `/skill:name` still works (Pi `docs/skills.md:53`). Factory stages invoke skills explicitly, which is the behavior we want anyway.
