# Agent instructions

This repository builds a GitHub-first software factory. Authorized issues pass through fixed stages to a ready PR. The owner merges it.

## Start here

1. Read `docs/plans/later/codebase-layout.md` for the L00 to L15 layout program run under poteto-mode's `autopilot-stack` playbook, its completed-PR evidence, its pending owner actions, and the owner's post-program checklist. Read `docs/plans/active/factory-v1.md` for the factory program's historical state and remaining evidence gaps. Use `git log` to confirm what landed.
2. Read `docs/decisions.tsv` for decisions, grants, and verdicts. Only the coordinator appends rows, using the installed pstack `show-me-your-work` skill's `log.sh`. Preserve every historical row. New rows ship with the next docs PR. A grant covers only the scope its row names. Later rows can narrow or withdraw it.
3. Read the latest `.pi/daily-log/` file in this repo, when present. The coordinator handoff is the newest `RESUME-*.md` in the private trails checkout, `../pi-herdr-factorio-trails/` beside the root checkout. It lists the grants in force. `docs/history/handoff.md` is historical evidence, not authority.

One session coordinates the program. Children follow their bounded briefs and are leaves unless their brief allows delegation. If coordination ownership is unclear, ask the owner before acting. Resolve `<pstack>` from the installed skill inventory, not a workstation path.

## Authority and delivery

- No plan grants execution. Obtain the owner's current grant for external actions. No merges, dispatch, deployments, settings changes, or cleanup follow from general autonomy. L00 to L15 stop at STACK-READY for owner landing. Historical grants are not standing permission. Reconcile a standing owner grant with a child's narrower task scope before declaring a project-wide permission blocker or asking again.
- For merges granted outside a plan, use `gh pr merge --squash --match-head-commit <sha>` after a verdict comment, green exact-head `check`, and clean `git merge-tree`. Cleanup needs its own grant.
- `nubl-factory` is production since 2026-11-13 (#734): the only controller, installed at `3ee264c` and held. This host's exe.dev key reaches it because Giuseppe tagged it `tester`. Routine read-only checks are allowed. Installing the Shep bridge, upgrades, the #735 hold-lift and any fixture run each need Giuseppe's explicit go. Never delete, copy over or retag it. `pi-factorio` was retired and deleted on 2026-11-13 (#734 closed), with its state archived. The ms-a2 host plan is later. Only exmach is parked.
- Use `.pi/skills/verify-factory/SKILL.md` for authorized CLI, extension, viewer, installer, and native checks. Use `.pi/skills/verify-factory-state/SKILL.md` for existing bounded formal checks. Recipes grant no VM or fixture action.
- On exe.dev, GitHub uses `exe-dev-github-integration[bot]` and `GH_HOST=github.int.exe.xyz`. Never set `GH_HOST` locally. Only the owner creates or deletes `factory:enabled`.
- Name fixture issues `[<PR>-...]`. Close each under its grant and confirm CLOSED. Never run competing controllers over the same repository, even when one is held. Stage sandboxes use Pi's `--no-context-files`, so they do not load this file.
- Preserve exact-head CI and review binding, captured execution identity, cumulative budgets, owner edits, and required live and performance checks. Test preparation, execution, persistence, fresh-process recovery, and handoff through real entry points. Synthetic local evidence is not live proof.
- Cite each blocker's requirement or observed failure, risk, and next action. Diagnose the verifier before changing the product. Do not weaken assertions, stage allowances, or gates to make a check pass. Do not invent a stronger release gate while verifying the existing one.
- Bound investigations before starting. A timeout is incomplete, not a pass or counterexample. Keep formal limits separate from delivery decisions and bootstrap readiness separate from deployment.
- Use the active plan's walkthrough, one-writer, swarm, and convergence rules. Batch corrections. After the first fix round, block only for a user-hit bug, failed gate, or wrong shipped doc. A minor fix gets one affected verifier. A wording-only change gets none. File the rest in one follow-up. Reuse evidence only for unchanged covered code.

## Placement and checks

Follow the folder READMEs rather than infer ownership from a filename. The root README routes to every folder README. Coordinator procedures belong in `.pi/skills/`. Sandbox stage prompts belong in `skills/`.

| Changed path | Required checks |
| --- | --- |
| Any PR | `npm run check`, including `check:layout` and `check:decisions`. Retain exact-head output. |
| `docs/plans/` | Installed `node <pstack>/skills/poteto-mode/scripts/check-plan.mjs <plan>`. Layout stays 16/0 and factory-v1 stays 22/0. |
| `.pi/skills/verify-factory/` prose | Feature-index equality, ordered recipe headings, and links. Source checks do not establish live proof. |
| State models or covered candidate/controller policy | The formal wrapper's correspondence review, bounded checks, and runtime replay. |
| Source moves | Layout inventory, review-seat inheritance, path map, test identity parity, and the active plan's native and performance checks. |
| Viewer and dashboard | `DESIGN.md`, viewer/style tests, and the applicable real interaction checks. |

## Rules learned the hard way

- Never set an upstream on a branch made from `origin/main`. A bare `git push` then targets `main`. Create branches with `--no-track`. Push through `../pi-herdr-factorio-trails/bin/checked-push.sh` beside the root checkout or an explicit `HEAD:refs/heads/<branch>`.
- Distrust child summaries. Inspect diffs, remote heads, CI, fixture state, and receipts. A child once said "no changes" over an almost complete draft.
- Size lane token caps to full stage allowances, not expected spend. Specify, accept, and build reserve about 540,000 tokens together, about 40,000, 100,000, and 400,000 respectively. A smaller cap launches nothing.
- Never narrow a stage below the plan's rule unless testing exhaustion. That tests the verifier, not the factory.
- Match pass criteria to real behavior. A closed issue's run posts a terminal `released` marker. The gateway logs its own `GET /` readiness probe. Neither is a defect.
- Keep required `SAFETY:` comments before type assertions. `.oxlintrc.json` requires them.
- Run the plan checker after plan edits. Factory-v1 must print `22 PR sections, 0 problems`. The checker rejects mid-sentence colons.
- Save long diffs to a file before reading them. Tool wrappers can truncate output.

## Models and spend

- VM stages default to OpenAI through the owner's ChatGPT subscription and exe.dev's `llm` integration. The owner allowed Anthropic on 2026-11-02. F10c implemented it for accept and one blocking review seat, spending exe.dev credits. On 2026-11-06 the owner returned every stage to OpenAI. Keep that default unless the owner changes it. Any Anthropic stage, including the dormant F10c accept stage and review seat, needs the owner's approval. xAI stays unused.
- Local independent reviewers must use a different provider and model family from the author. Review GPT-authored PRs with an authenticated Claude or Grok model. Report unavailable independence.
- Raising a plan's token or time limit needs the owner. Record the cap raise in the plan before the performance probe.

## Design

- Read `DESIGN.md` before viewer or dashboard UI work. It applies Shep's design system to Factorio.
- Use tokens such as `var(--color-…)` and `var(--space-…)`, never raw colours.
- Never hand-edit `host/viewer/design/tokens.css`. `scripts/design-tokens.mjs` generates it.
- Update tokens only with `node scripts/design-tokens.mjs sync --shep <dir>` from a pinned, committed Shep revision.

## Daily log

After substantive work, read `.pi/skills/daily-log-pi-herdr-factorio/SKILL.md`. Append verified outcomes, decisions, blockers, next steps, and evidence to the untracked `.pi/daily-log/YYYY-MM-DD.md`. Use the machine's local date unless this repo specifies a timezone. Separate completed work from plans. Exclude secrets and never commit personal logs. A bounded brief's file boundary still applies.

For catch-ups, read the latest logs first and follow that skill. Fetch only relevant updates beyond their recorded source coverage. Report unavailable sources rather than guessing.
