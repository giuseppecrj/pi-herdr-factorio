# Agent instructions

## Start here

This repository builds a software factory. The work runs as one program, set out in `docs/plans/factory-v1.md`, with one coordinating session at a time. Before acting, read these files in order:

1. **`docs/plans/factory-v1.md`.** The plan: PRs F04a to F13, each with its files, build steps and live checks. Merged PRs are listed in `git log`.
2. **`docs/decisions.tsv`.** The authoritative history of every decision, grant and verdict. The newest rows are at the bottom. The coordinator appends rows with the pstack `show-me-your-work` skill's `log.sh`, and they ship with the next docs PR.
3. **The latest file in `.pi/daily-log/`**, if present. These are personal, untracked notes.
4. **The newest `RESUME-*.md` in `../pi-herdr-factorio-trails/`**, if present. It is the coordinator's handoff note. `docs/handoff.md` is the original 2026-10-28 handoff and is partly stale.

Only one session coordinates the program. If another session's decision rows are recent, ask the owner which session leads before acting.

## How a plan PR runs

- **Walkthrough first, for design-heavy PRs.** That means F07b, F07c, F09a, F10, and any PR that opens new design ground.
  - Run the pstack `how` skill: read-only explorers, then one explainer.
  - Prototypes settle the facts. Settle every open call before a builder starts.
  - Bring the owner only the product calls.
- **One builder per PR.** Give it a bare child in a managed worktree, with a brief at `../pi-herdr-factorio-trails/<PR>/brief.md` that lists the files it may touch.
- **Swarm verification.** The plan names the lanes, and the shared lane briefs live in `../pi-herdr-factorio-trails/<PR>/swarm/`.
  - **Lanes.** A gates lane, two audits, ten live lanes on the VM, and perf.
  - **Batching.** Batch every finding into one fix round.
  - **Convergence.** After the first fix round, block only for a bug a user would hit, a failed gate, or a wrong shipped doc. File the rest as one follow-up issue.
  - **Re-verification.** A minor fix gets one verifier, and a wording-only change gets none. A lane result carries forward while the code it covers is unchanged.
- **Merging.** Squash-merge with `gh pr merge --squash --match-head-commit <sha>`, after a verdict comment, a green `check` and a clean `git merge-tree` against `main`. Then remove the worktree and branch, locally and on GitHub.
  - The coordinator merges only under the owner's current grant. `docs/decisions.tsv` records each grant.
  - When the plan reaches the owner's PR review flow (F09a), each PR stops at merge-ready for the owner.

## Rules learned the hard way

- **Never set an upstream on a branch made from `origin/main`.** A bare `git push` then targets `main`. Create branches with `--no-track`, and push with `../pi-herdr-factorio-trails/bin/checked-push.sh` or an explicit `HEAD:refs/heads/<branch>`.
- **Distrust child summaries.** Check the side effects yourself: diffs, remote heads, CI, fixture state and receipts. A child once said "no changes" over an almost complete draft.
- **Size live lane token caps to stage allowances, not expected spend.** A verifier reserves every stage's full allowance before it launches a run. One full specify, accept and build run reserves about 265,000 tokens. A cap below that launches nothing.
- **Never narrow a stage below the plan's rule in a lane**, unless the lane is testing an exhausted budget. A narrower stage tests the verifier, not the factory.
- **Write lane pass criteria to match the controller's real behavior.** A closed issue's run posts a terminal `released` marker. The gateway logs its own `GET /` readiness probe. Neither is a defect.
- **Some comments are required.** `.oxlintrc.json` requires a `SAFETY:` comment before every type assertion, so a comment cleanup must keep them.
- **The plan checker has style rules.** Run `node <pstack>/skills/poteto-mode/scripts/check-plan.mjs docs/plans/factory-v1.md` after any plan edit. It must print `17 PR sections, 0 problems`. It rejects mid-sentence colons.
- **Long shell output may be cut off by tool wrappers.** Write diffs to a file before reading them.

## Models and spend

- **VM stages use OpenAI models only**, through the owner's ChatGPT subscription and exe.dev's `llm` integration. Spend no exe.dev credits, which rules out Anthropic and xAI routes on the VM.
- **Local reviewers must be from a different model family than the PR's author.** When a GPT model built the PR, review it with Claude or Grok.
- **Raising a token or time limit in the plan needs the owner.** Record the raise in the plan before the perf probe runs.

## Where things run

- **The controller and live lanes run on the exe.dev VM `pi-factorio`.** `docs/handoff.md` and `.pi/skills/verify-factory/` cover access and lane scripts.
- **On the VM, GitHub is reached as `exe-dev-github-integration[bot]`**, with `GH_HOST=github.int.exe.xyz`. Never set `GH_HOST` locally.
- **Fixture issues are titled `[<PR>-...]`.** Close each one, and confirm it is closed.
- **Leave `factory:enabled` alone.** Only the owner creates or deletes it.
- **Stage sandboxes run Pi with `--no-context-files`**, so this file never enters a factory stage's prompt.

## Daily log

After substantive work, read `.pi/skills/daily-log-pi-herdr-factorio/SKILL.md` and append verified outcomes, decisions, blockers, and next steps to `.pi/daily-log/YYYY-MM-DD.md`. Use the machine's local date unless this repo specifies a timezone. Include evidence such as file paths, test commands and results, commit IDs, or PR links. Distinguish completed work from plans. Exclude secrets and never commit personal logs.

For catch-ups, read the latest daily logs first and follow that skill. Fetch only relevant updates beyond the recorded source coverage. Report unavailable sources rather than guessing.
