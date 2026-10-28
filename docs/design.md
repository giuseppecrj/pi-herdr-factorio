# Factory design

Status: proposed, 2026-10-28. Built from `research/SYNTHESIS.md` and `research/reports/`. Owner decisions so far: GitHub Issues first with Linear next, GitHub-hosted runners on this public repo, runners join the tailnet for model access, full autonomy through merge, pstack is a dependency, and the factory's first target is this repository.

## What done means

v1 is done when all of these hold on `giuseppecrj/pi-herdr-factorio`, observed on real Actions runs:

1. A maintainer labels an issue `factory:ready`. With no further human action, a commit lands on `main`, the issue closes with an evidence comment, and the ledger gains a row for the run.
2. That commit passed the repository's checks and a held-out acceptance suite that was written from the ticket before any code existed, by a different model family than the builder, and was never visible to the builder.
3. The same label applied by an account without write access starts nothing visible beyond an admission refusal.
4. With the kill switch off, a labeled issue starts nothing.
5. A seeded known-bad patch is rejected by the validate stage, and nothing lands.
6. A ticket too vague to specify ends as `needs_info` with its questions on the issue, and re-labeling after an answer resumes it.

Rigor is high. Auto-merging to the default branch of a public repo from issue text is the riskiest thing this system does, and issue text is untrusted input.

## The data

Everything hangs off one record per ticket attempt.

```ts
type TicketRef = { provider: "github" | "linear"; key: string; url: string };

type Stage = "admit" | "specify" | "accept" | "build" | "validate" | "review" | "land";

type Outcome =
  | { kind: "landed"; mergeSha: string }
  | { kind: "needs_info"; questions: string[] }
  | { kind: "rejected"; reason: "policy" | "unauthorized" | "disabled" | "forbidden_paths" }
  | { kind: "failed"; stage: Stage; evidence: string }
  | { kind: "budget_exhausted"; stage: Stage }
  | { kind: "cancelled" };

interface Run {
  id: string;
  ticket: TicketRef;
  repo: string;
  baseSha: string;
  contractDigest?: string;
  acceptanceDigest?: string;
  patchDigest?: string;
  verdict?: { patchDigest: string; pass: boolean; checks: CheckResult[] };
  repairRounds: number;
  outcome?: Outcome;
}
```

A run moves forward through `Stage` or ends in exactly one `Outcome`. Stages are fixed by the controller. The model never chooses the next stage and never chooses whether a gate passed.

Ticket systems sit behind one interface, so Linear is a second implementation, not a rewrite:

```ts
interface TicketAdapter {
  normalize(event: unknown): FactoryEvent | null;
  fetch(ref: TicketRef): Promise<Ticket>;
  canAdmit(ref: TicketRef, actor: string): Promise<boolean>;
  report(ref: TicketRef, run: Run): Promise<void>;
  ask(ref: TicketRef, questions: string[]): Promise<void>;
  close(ref: TicketRef, run: Run): Promise<void>;
}
```

`FactoryEvent` is `ready`, `answered`, `cancelled`, or `pr_feedback`. GitHub produces it from `issues.labeled`, `issue_comment` and `pull_request_review`. Linear will produce it from agent-session webhooks relayed to `repository_dispatch` by a small receiver, which v2 adds.

## Pipeline

Each stage is its own Actions job on its own fresh runner. Runner separation is the isolation boundary: a job only sees the artifacts the controller hands it and the token permissions its job declares.

| Stage | Skill source | Model access | GitHub token | Output |
| --- | --- | --- | --- | --- |
| admit | none, deterministic | no | `issues: write` | snapshot of the issue at label time, or `rejected` |
| specify | audit-ticket (clean-room), grill-me + grilling (Pocock, MIT), deep-research (Pocock, MIT) when needed | yes | read | `contract.md`: behavior, exclusions, acceptance criteria, non-functional limits; or `needs_info` |
| accept | new skill, from StrongDM's scenario holdout idea | yes, a different family from build | read | held-out acceptance tests as an artifact, never committed before landing |
| build | pstack Feature or Bug fix playbook, tdd | yes | read | a patch artifact plus visible tests; no push |
| validate | none for checks; an LLM judge only for criteria a test cannot express | judge only, different family from build | read | `verdict.json` bound to the patch digest |
| review | code-review (Anthropic, Apache-2.0), security-review (Anthropic, MIT), simplify (own), ultrareview (own, multi-family) on high-risk patches | yes | read | findings; blocking findings send the run back to build |
| land | none, deterministic | no | `contents: write`, `pull-requests: write`, `issues: write` | branch, PR with evidence, squash merge on the exact validated head |

Rules the controller enforces in code:

- **Admission.** Only a `factory:ready` label applied by an account with write access counts. The issue body is snapshotted at that moment. Later edits are data for a new run, not permission for this one.
- **Kill switch.** Repo variable `FACTORY_ENABLED`. Every job checks it before side effects, and land checks it again right before merging.
- **One run per ticket.** Actions `concurrency: factory-issue-<number>` with `cancel-in-progress: false`.
- **The builder cannot see or edit the oracle.** The acceptance suite lives in an artifact the build job never downloads. Validate applies the patch to the base, then adds the suite, so a patch that touches the suite's paths is rejected.
- **Hard failures veto.** No review verdict or judge score overrides a failing check.
- **Bounded repair.** At most two rounds back to build, and each round re-runs validate and review on the new patch.
- **Land only what passed.** Land merges only if the PR head's tree matches the validated patch applied to the base, using `gh pr merge --squash --match-head-commit`.
- **Forbidden paths.** The factory cannot change `.github/workflows/`. Actions' `GITHUB_TOKEN` can never be granted the `workflows` permission, so GitHub enforces this, not our prompt. A ticket that needs a workflow change ends `rejected: forbidden_paths` with the proposed patch attached to the issue. Lifting this later needs a GitHub App and a separate promotion path that judges factory changes with the previous trusted policy.
- **Budgets.** Every job has `timeout-minutes`, repair rounds are capped, and the controller writes model and runner time per stage to the ledger.

One GitHub quirk shapes land. Pull requests opened with `GITHUB_TOKEN` do not start other workflows without approval, so required checks cannot come from a separate PR workflow. Instead, land posts a `factory/validate` commit status from the verdict, and branch protection on `main` requires it. A separate `ci.yml` runs the same checks and posts the same status for human PRs.

## Feedback and cadence

- **PR feedback.** A review or comment on an open factory PR triggers address-pr-comments (mnapoli, MIT) as a build round with the comments as input. It cannot push or reply itself. Land does both. Feedback on an already-merged PR becomes a new issue labeled `factory:proposed`.
- **Scheduled jobs**, weekly at first:
  - improve-codebase-architecture (Pocock, MIT) with codebase-design and domain-modeling;
  - security-review over the whole repo;
  - audit-instructions (melodic-software, MIT, `--unattended`);
  - agent-loop-hygiene (owner skill, adapted) over the ledger.

  Each one files issues labeled `factory:proposed`, and none of them changes code directly.
- **Self-improvement.** agent-loop-spec (owner skill, adapted) defines the factory's metric. The first metric is the share of `factory:ready` tickets that land with zero repair rounds and no follow-up defect within a week. pstack's `reflect`, adapted to read the ledger instead of a transcript, proposes skill and prompt changes as `factory:proposed` issues. Changes to the factory's own skills go through the same pipeline, but their acceptance suite is a fixed corpus of past tickets replayed against the previous version.

## Ledger and evidence

Each run appends one JSON line to `ledger/runs.jsonl` on an orphan branch `factory/ledger`, written only by land. Stage artifacts (contract, acceptance suite, patch, verdict, review findings, Pi session files with secrets redacted) are uploaded per job and linked from the issue's evidence comment. The ledger is what agent-loop-hygiene and reflect read.

## Package layout

```text
package.json          pi manifest: extension + skills; peer deps pi, pi-herdr-pstack
extension/            /factory run <issue> for local runs, /factory status
skills/               adapted upstream skills, each with SOURCE.md and its license or NOTICE
src/                  controller: run state, stage table, policy, adapters, ledger
.github/workflows/    factory.yml, factory-feedback.yml, factory-cadence.yml, ci.yml, model-smoke.yml
test/                 controller unit tests with a fake TicketAdapter; seeded-bad-patch fixture
```

The same stage table drives two executors. In CI, each stage is an Actions job running `pi -p`. Locally, `/factory run` drives the same stages in one Pi session and can use Herdr panes when they exist.

## Build order

Riskiest unknowns first. Each unit ends in a check before the next starts.

| # | Unit | Check |
| --- | --- | --- |
| 0 | Model access from a hosted runner over the tailnet | `model-smoke` run prints `factory-smoke-ok` |
| 1 | Can Herdr run headless on a hosted runner? Decides whether pstack's fan-out skills (interrogate, architect) work in CI or get a sequential `pi -p` fallback | prototype workflow launches one Herdr pane child and gets its result |
| 2 | Package skeleton: manifest, controller types, stage table, fake adapter, `npm run check` | unit tests green; `pi -e .` loads the extension and lists factory skills |
| 3 | admit + kill switch + GitHub adapter | tests 3 and 4 of the definition of done on a real issue |
| 4 | specify + accept | a vague issue ends `needs_info`; a clear one yields a contract and a held-out suite |
| 5 | build + validate | the seeded bad patch is rejected; a good one gets a passing verdict |
| 6 | review + bounded repair | a planted vulnerability produces a blocking finding and a repair round |
| 7 | land + branch protection + ledger | definition-of-done test 1 end to end |
| 8 | PR feedback | a review comment on an open factory PR produces a new round |
| 9 | cadence jobs | one scheduled run files `factory:proposed` issues |
| 10 | self-improvement loop | metric computed from the ledger; reflect files one proposal |
| 11 | Linear adapter and receiver | the same tests driven from a Linear issue |

## Known risks

- **The model proxy key is on runners that execute generated code.** A prompt injection that survives admission could exfiltrate it. Mitigations: only maintainers can trigger, the key is dedicated to the factory and revocable, and the tailnet grant reaches only the proxy on 443. The residual risk is accepted for v1 and needs your sign-off.
- **Public repo.** Secrets stay private, but logs and artifacts are readable by anyone, and anyone can write issue and comment text. So: only text from accounts with write access is ever fed to a model (issue bodies admitted by label, PR feedback filtered by author permission); nothing raw from a model run is uploaded, only redacted evidence; secrets live in a `main`-only environment; no workflow uses `pull_request_target`; and the Tailscale key is consumed by the join step and never reaches agent steps.
- **Correlated blind spots.** The acceptance writer, the judge and the builder are all models. Using different families reduces this but does not remove it. The seeded-defect fixtures measure it, and that is the most we can claim.
- **Merged means done for now.** This repo has no deployment. Publishing to npm stays a manual release until a deploy contract with a smoke check and a rollback exists.
