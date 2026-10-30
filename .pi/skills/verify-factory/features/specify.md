# Specify

From F06a, the `specify` stage turns an admitted issue into a contract or into questions. The behavior and the files are documented under "Specify" in `docs/operations/factory-cli.md`. The sandbox side is under "What F06a adds" in `docs/operations/sandbox.md`.

Every passing lane spends model tokens and needs the model-spend grant as well as the fixture grant. Count each lane's tokens from its receipts, and keep the lane under its grant. A stage overshoots its cap by up to one model request.

## Sub-features

- `specify-contract`: a clear issue stores its contract after `specify:claimed`, `specify:running`, then moves to `accept:claimed` on the same run (F06b). See `acceptance.md` for the terminal stage. One summary comment, posted before `stage_passed`, ends `<!-- factory-contract run=<runId> c=<contractDigest> -->`. It lists the behavior, the exclusions and criteria `A1`, `A2` and so on. `<state>/contracts/<runId>/contract.json` and `receipt.json` are mode 0600. `receipt.json`'s `contractDigest` is the sha256 of `contract.json`, and `contract.json` has `base.sha` equal to the markers' `workflowSha`. The log has `contract_stored`. `factory:ready` stays on.
- `specify-questions`: a vague issue ends `needs_info`. One questions comment ends `<!-- factory-questions run=<runId> q=<digest> -->` and never starts with `<!-- factory:`. Then `factory:needs-info` is added and `factory:ready` removed, both by `exe-dev-github-integration[bot]` on the timeline, and only then comes the `needs_info` marker. Further ticks launch nothing and post nothing.
- `specify-linked`: after `needs_info`, an answer comment from an account with write access, then `factory:ready` added again at least two seconds later, starts a new run. Its log has `run_linked prevRunId=<old run> answers=<n>`, and `factory:needs-info` is removed after its `claimed` marker. `<state>/links/<newRunId>.json` names the old run, and `<state>/answers/<newRunId>.json` holds the answer. The new contract's `link` names the old run and the answers digest. The old run's markers are unchanged, and the ledger is not corrupt.
- `specify-same-second`: an answer and the relabel in the same second refuse the admission as `ambiguous_snapshot`, logged with `detail=answer_at_label_time`.
- `specify-output`: `output.txt` beside a passing receipt, mode 0600, holds the final text, and the receipt's `output` gives only its size.
- `specify-no-output`: a stage that ends `budget_exhausted` or `refused` keeps no `output.txt`, no contract and no comment.

## Driving it with ssh

Preconditions are those of `sandbox-stage.md`, with the bundle provisioned from a commit that has `skills/`. `readlink /var/lib/factory-sandbox/current` must name a bundle whose `skills/` lists `audit-ticket`, `deep-research` and `grill-me`.

1. Create the fixture as the owner with `gh issue create --title "[<pr-id>] ..."`, then add `factory:ready` as the owner with `gh issue edit <n> --add-label factory:ready`.
2. Run `.pi/skills/verify-factory/scripts/vm.sh .pi/skills/verify-factory/scripts/drive-stage.sh <pr-id> <worker-n> <issue>`. One `tick --once` claims the issue, runs specify and accept, and posts their comments and the terminal marker. A needs-info result stops at specify.
3. Read the comments with `gh api repos/giuseppecrj/pi-herdr-factorio/issues/<n>/comments`, and the labels and their actors with the timeline.
4. For a linked run, comment the answer as the owner, wait two seconds, add `factory:ready` again, and run `drive-stage.sh` once more.
5. Close every fixture with `gh issue close`, and confirm it with `gh issue view <n> --json state`.

## Results observed

On 2026-10-30 at `bdc54da`, lane `f06a-w1`, bundle `assets-336f926556f1…`, fixture #434 `[F06a-build] Add a --version flag to the factory CLI`, labeled by `giuseppecrj` (event 34655808428):

| Step | Result |
| --- | --- |
| `drive-stage.sh f06a 1 434` | exit 0, 61.8 s; markers `1:claimed`, `2:running`, `3:stage_passed`; `contract_stored digest=5a6524c654e3…`; one summary comment before `stage_passed`; no scope or sandbox process left |
| Receipt | `passed`, `agent_settled` with `aborted: false`, 7 turns, 51.8 s, 128,068 tokens (parent 126,795, one reviewer child 1,273), every model request `model-openai`, no xAI |

That first build read the bundled `pi-herdr-agents` `SKILL.md` and two test files before drafting. Fix round 1 removes the extension from stage argv and runs review in the controller. At `4fedafb`, with bundle `assets-116f6d3af325…`, lane `f06a-fix1-w1` proved:

| Step | Result | Tokens | Requests | Wall |
| --- | --- | ---: | ---: | --- |
| Clear #437 | Contract and summary, then `stage_passed` | 38,283 | 5 | 35.9 s stage, 45.4 s through terminal marker |
| Vague #438 | One concrete question, label swap, then `needs_info` | 8,045 | 1 | 8.0 s stage, 19.4 s tick |
| Answer without relabel | No launch or new marker | 0 | 0 | 4.1 s tick |
| Answer and relabel #438 | Linked contract says `Hello, factory!`, then `stage_passed` | 38,752 | 5 | 33.6 s stage, 45.5 s tick |

All 85,080 tokens went to `openai/gpt-6.1-sol`. Each contract had one reviewer and no revision. Both fixtures are closed; the lane was removed with no processes or scopes left. The clear SSH caller timed out at 30 seconds, but the controller completed. Its wall figure is from the controller log through the terminal marker, not a completed shell timer. Evidence is in `pi-herdr-factorio-trails/F06a/fix-1/live/` and `/tmp/swarm-f06a-fix1/worker-1/` on the VM.

## Gotchas

- The controller now runs the reviewer separately, with no tools and only the draft, snapshot and answers. No delegation extension loads. A clear draft with no tool calls and no finding takes two requests, not three parent requests plus a child.
- Specify's root receipt aggregates `draft/`, `review/` and optional `revision/` session receipts. Count root totals once. Read nested `egress.jsonl` files for the per-request breakdown.
- A restart with recorded session output resumes the same attempt without repeating that session. An unrecorded interrupted reviewer fails the attempt rather than launching it twice.
- Do not edit the questions or summary comment. An edited controller comment makes the issue corrupt with `edited`.
- `factory:ready` comes off the issue at `needs_info`, so `issues?labels=factory:ready` may still list it for a few seconds (F06a prototype E5). The controller rereads the issue before it launches.
