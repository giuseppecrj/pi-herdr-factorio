# Phase A synthesis

Source list: Cory House, https://x.com/housecor/status/2115482034906800200 (2026-10-28). His post names no repositories, and he has no public skills repo, so every pick below is our choice of the best licensed upstream, not proof of what he runs.

Detailed evidence lives in `research/reports/factory-research-{1,2,3,4}.md`. Verbatim captures, each with a `SOURCE.md` (URL, pinned SHA, license), live in `research/upstream/<skill>/<owner>__<repo>/`. Licenses below were re-checked by the parent with `gh api repos/<repo>/license`.

## Skill inventory

| Skill | Chosen upstream | License | Ship as | Human gates to replace for headless runs |
| --- | --- | --- | --- | --- |
| grill-me | mattpocock/skills `productivity/grill-me` + `grilling` @59db609 | MIT | adapt | Every question waits for the user. Headless: answer from the codebase first, post the rest to the ticket, pause. |
| audit-ticket | bhagyamudgal/skills @006f29e (best found, provenance unproven) | none | clean-room rewrite | Ends on an `AskUserQuestion` "Ticket fate" prompt. |
| deep-research | mattpocock/skills `research` @59db609 | MIT | adapt | None. Alternatives: daymade (MIT), 199-biotechnologies (no license, reference only). |
| security-review | anthropics/claude-code-security-review `.claude/commands/security-review.md` @0c6a49f | MIT | adapt | None. |
| code-review | anthropics/claude-plugins-official `plugins/code-review` @f8c5e7a | Apache-2.0 | adapt with NOTICE | Posts only with `--comment`. |
| ultrareview | Anthropic hosted service, docs only | unpublished | own implementation, multi-family review modeled on pstack `interrogate` | Confirmation dialog before launch. |
| simplify | Claude Code bundled skill, docs only; `code-simplifier` plugin is a different Apache-2.0 agent | unpublished | own implementation from docs, or adapt code-simplifier | None documented. |
| address-pr-comments | mnapoli/skill-address-pr-review | MIT | adapt | None, which is the problem: it pushes and replies on its own. Must sit behind the publisher's authorization. |
| improve-codebase-architecture | mattpocock/skills `engineering/improve-codebase-architecture` + `codebase-design`, `domain-modeling`, `grilling` @59db609 | MIT | adapt | "Which of these would you like to explore?" Headless: file candidates as proposed tickets instead. |
| audit-instructions | melodic-software/claude-code-plugins (`--unattended`) or desertcache/agent-os | MIT | adapt | desertcache asks before applying fixes; melodic confirms above ~20 dispatches unless `--unattended`. |

Never ship: anything from `anthropics/claude-code` (All rights reserved), the Piebald prompt extractions, vincenzodomina/ai, 199-biotechnologies.

## Integration findings that constrain the design

- Pi runs headless through `pi -p`, `--mode json`, `--mode rpc` and the SDK. RPC and SDK consumers must wait for `agent_settled`, not `agent_end` (Pi `docs/rpc.md:69`).
- pi-herdr-agents only runs children inside Herdr (`isHerdrAvailable` requires `HERDR_ENV=1` and the `herdr` binary, `maestro/surfaces/herdr/herdr.ts:56-58`). A CI runner cannot use it unless Herdr runs there too.
- GitHub Actions `issues: labeled` needs no public ingress. Linear native agents need a receiver that acknowledges within 5 s and posts activity within 10 s, so Linear needs an always-on receiver (Tailscale Funnel is the candidate).
- The model proxy is on the tailnet. A hosted runner cannot reach it without an approved ephemeral Tailscale join.
- Closest prior art: OpenAI Symphony (tracker polling, per-issue workspace, repo-owned WORKFLOW.md), claude-code-action (admission separated from prompt), Copilot coding agent (assign, draft PR, review comments loop).
