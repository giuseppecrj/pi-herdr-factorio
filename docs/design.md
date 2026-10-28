# Factory design

Status: proposed, 2026-10-28. Built from `research/SYNTHESIS.md` and `research/reports/`. Owner decisions so far:

- GitHub Issues first, Linear next.
- Full autonomy through merge, with opt-in human checkpoints.
- pstack is a dependency.
- The factory's first target is this repository.
- Runtime is a controller server on an exe.dev VM, with checks in GitHub-hosted CI, shaped after OpenAI's Symphony.

## What done means

v1 is done when all of these hold on `giuseppecrj/pi-herdr-factorio`, observed on the real VM and real GitHub:

1. A maintainer labels an issue `factory:ready`. With no further human action, a commit lands on `main`, the issue closes with an evidence comment, and the ledger gains a row for the run.
2. That commit passed `main`'s gates and a held-out acceptance suite in GitHub-hosted CI. The suite was written from the ticket before any code existed, by a different model family than the builder, and the builder never saw it.
3. The same label applied by an account without write access starts no run.
4. With the kill switch off, a labeled issue starts no run.
5. A seeded known-bad patch fails CI, and nothing lands.
6. A ticket too vague to specify ends as `needs_info` with its questions on the issue, and re-labeling after an answer resumes it.
7. A patch that matches a checkpoint rule waits for a human approval and lands only after it.
8. Restarting the controller mid-run neither loses the run nor starts a second one.

Rigor is high. Auto-merging to the default branch of a public repo from issue text is the riskiest thing this system does, and issue text is untrusted input.

## Shape

```text
GitHub ──webhook (Funnel, signed)──▶ exe.dev VM: controller ──Pi RPC in sandbox──▶ agents
   ▲                                     │   holds: GitHub App key, proxy key       │
   │                                     │   tailnet: tag:factory-server → cliproxy │
   └──push, PR, comment, merge (App)─────┘◀──────────── patch, findings ───────────┘
GitHub-hosted CI: main's gates + held-out acceptance on the PR head, no secrets, no tailnet
```

- **The VM is the brain.** It receives events, decides, runs agents, and is the only thing that writes to GitHub.
- **CI is the judge.** It runs on a fresh GitHub VM with nothing to steal, and branch protection makes its result a hard merge requirement that neither the controller nor an agent can switch off.
- **GitHub holds no model or Tailscale credential** once the VM is live. The `TS_AUTHKEY` and `CLIPROXYAPI_*` repo secrets are deleted then.

## Relation to Symphony

Symphony's spec (`openai/symphony` `SPEC.md`, pinned at `be10a1b`) is the template for the coordination layer. Where we copy it, we copy its semantics, not just its names.

| Symphony | Here | Same or different |
| --- | --- | --- |
| Long-running daemon reading a tracker | controller on the VM | same |
| Poll tick with reconciliation before dispatch (§8.1, §8.5) | webhooks for speed, plus a 60 s reconcile tick as the safety net | same tick, webhooks added |
| One authoritative state; `claimed` and `running` checked before dispatch (§7.4) | same, plus a `waiting` state for human checkpoints | extended |
| Retry with backoff `min(10000·2^(n−1), max)`, stall timeout, bounded concurrency (§8.3, §8.4) | same formulas and defaults, concurrency starts at 2 | same |
| Restart recovery from the tracker and filesystem, no database (§7.4) | from the issue's run marker comment, the PR and the workspace | same idea |
| Per-issue workspace, sanitized key, cwd and root invariants (§9.5) | same invariants, plus a rootless container per stage | stricter |
| Repo-owned `WORKFLOW.md`, front matter config, hot reload (§5, §6.2) | `.github/factory/WORKFLOW.md` with the same loader rules | same, but placed under `.github/` so the factory cannot edit it |
| Tracker adapter normalizing issues (§11) | `TicketAdapter`, GitHub first, Linear second | same |
| One agent session that loops turns until the issue leaves an active state (§7.1) | fixed stages, each a fresh Pi session running one skill | **different** |
| Agent writes to the tracker and PR with its own tools (§11.5) | only the controller writes, with the App token | **different** |
| User-input request fails the attempt (§10.5) | the stage ends `needs_info` and the questions go on the ticket | same intent |
| Success can end at `Human Review` | lands automatically unless a checkpoint rule matches | **different** |
| "Proof of work: CI status" | CI is a required gate and also runs the held-out suite | stricter |

Why the three real differences:

- **Fixed stages instead of one looping session.** In Symphony the prompt decides when the work is done. With no human reading the result, "done" has to be decided by code: the validate and review stages, then CI. Fresh sessions per stage also keep the builder away from the acceptance suite.
- **The agent never writes to GitHub.** Symphony assumes a trusted environment. Our input is public issue text. An agent that can comment, push or merge is one prompt injection away from doing it wrongly, so it gets no write credential at all.
- **Automatic landing.** You chose full autonomy. Symphony's human acceptance step becomes our checkpoint policy, used only where you ask for it.

## The data

```ts
type Stage = "admit" | "specify" | "accept" | "build" | "validate" | "review" | "land";

type Progress =
  | { kind: "active"; stage: Stage }
  | { kind: "waiting"; checkpoint: "contract" | "merge"; reasons: NonEmpty<string> }
  | { kind: "finished"; outcome: Outcome };

type Outcome =
  | { kind: "landed"; mergeSha: string }
  | { kind: "needs_info"; questions: NonEmpty<string> }
  | { kind: "rejected"; reason: "policy" | "unauthorized" | "disabled" | "forbidden_paths" }
  | { kind: "failed"; stage: Stage; evidence: string }
  | { kind: "budget_exhausted"; stage: Stage }
  | { kind: "cancelled" };

interface Run {
  id: string;
  ticket: TicketRef;
  repo: string;
  baseSha: string;
  contractDigest?: Digest;
  acceptanceDigest?: Digest;
  patchDigest?: Digest;
  verdict?: Verdict;          // always names the patch digest it judged
  repairRounds: number;
  progress: Progress;
}
```

`src/run.ts` and `src/stages.ts` implement this, except `waiting`, which arrives with the checkpoint unit. `advance(run, event)` is pure. The model never chooses the next stage and never decides whether a gate passed.

The controller's scheduling state follows Symphony §4.1.8: `running`, `claimed`, `retry_attempts`, totals. Each run also writes a marker comment on its issue (`<!-- factory:run {...} -->`), so a restarted controller can rebuild its state from GitHub alone.

```ts
interface TicketAdapter {
  normalize(event: unknown): FactoryEvent | null;
  fetchCandidates(): Promise<Ticket[]>;
  fetchStates(refs: TicketRef[]): Promise<Map<string, TicketState>>;
  canAdmit(ref: TicketRef, actor: string): Promise<boolean>;
  report(ref: TicketRef, run: Run): Promise<void>;
  ask(ref: TicketRef, questions: string[]): Promise<void>;
  close(ref: TicketRef, run: Run): Promise<void>;
}
```

## Stages

| Stage | Runs where | Skill source | Credentials inside the sandbox | Output |
| --- | --- | --- | --- | --- |
| admit | controller | none, deterministic | none | issue snapshot at label time, or `rejected` |
| specify | sandbox | audit-ticket (clean-room), grill-me + grilling (Pocock, MIT), deep-research (Pocock, MIT) when needed | proxy key | `contract.md`, or `needs_info` |
| accept | sandbox, separate from build | new skill, from StrongDM's scenario holdout idea | proxy key, a different model family from build | held-out acceptance tests, kept on the VM |
| build | sandbox | pstack Feature or Bug fix playbook, tdd | proxy key | a patch plus visible tests |
| validate | controller + CI | main's gates and the held-out suite in CI; an LLM judge on the VM only for criteria a test cannot express | judge: proxy key | `verdict.json` bound to the PR head SHA |
| review | sandbox | code-review (Anthropic, Apache-2.0), security-review (Anthropic, MIT), simplify (own), ultrareview (own, via pstack interrogate) on high-risk patches | proxy key | findings; blocking findings send the run back to build |
| land | controller | none, deterministic | none in a sandbox; the controller uses the App token | squash merge of the exact verified head |

### Rules enforced in code

- **Admission.** Only a `factory:ready` label applied by an account with write access counts. The issue body is snapshotted at that moment. Later edits are data for a new run, not permission for this one.
- **Kill switch.** Repo variable `FACTORY_ENABLED` plus a local flag file on the VM. Either one off stops new dispatch. Land re-checks both right before merging.
- **One run per ticket.** Symphony's claim rule in the controller, with the issue marker as the record that survives restarts.
- **The builder never sees the oracle.** The acceptance suite stays on the VM until build has finished. The controller then pushes it as its own commit on the PR branch under `test/acceptance/<ticket>/`. A builder patch that touches that path is rejected. In a repair round, the builder gets the names of failing scenarios, not their code.
- **Gates come from `main`, not the patch.** CI checks out `main`'s gate script, test files and check config and runs them against the candidate, then runs the candidate's own new tests and the held-out suite. A patch that edits `package.json` scripts or deletes tests cannot weaken the gate that judges it.
- **Hard failures veto.** No review verdict or judge score overrides a failing check.
- **Bounded repair.** At most two rounds back to build. Each round re-runs CI and review on the new head.
- **Land only what passed.** Merge uses `--match-head-commit` with the SHA the verdict names.
- **Forbidden paths.** Nothing under `.github/`. Composite actions, CODEOWNERS, dependabot config and the factory's own `WORKFLOW.md` steer the gates. The App has no `workflows` permission, so GitHub also enforces this for workflow files. A ticket that needs such a change stops at the merge checkpoint with the patch attached.
- **Budgets.** Per-stage turn and wall-clock limits from `WORKFLOW.md`, Symphony's stall timeout, capped repair rounds, and model and runtime totals per run in the ledger.

## Sandbox

Each stage runs Pi in RPC mode inside a rootless container on the VM. The controller waits for `agent_settled`, not `agent_end`.

- **Mounts.** Only the issue workspace is mounted. No host home and no controller state.
- **Network.** Egress is limited to the model proxy and the package registries the repo needs.
- **Credentials.** The only one inside is a proxy key. No GitHub token and no App key.
- **Fan-out.** Herdr runs headless inside the container for pstack's fan-out skills. That was verified on a GitHub runner in `docs/prototypes/herdr-on-runner.md`. The VM is the same pattern with more room.

A per-issue directory is not a security boundary on its own. Symphony says so too, and leaves it to the host. The container is our boundary.

## Human checkpoints

The default is no human. `.github/factory/WORKFLOW.md` front matter can name the decisions that need one:

```yaml
checkpoints:
  approve_contract:
    labels: ["factory:plan-first"]
    when: [architecture_change, public_api_change]
  approve_merge:
    paths: ["src/policy.ts", "src/stages.ts", "skills/**", "package.json"]
    when: [new_dependency, migration, security_finding_accepted]
    diff_lines_over: 400
```

- **Two checkpoints.** `approve_contract` pauses after specify, before any code. `approve_merge` pauses after review, before land.
- **Waiting.** The run moves to `waiting` and requests review from the owner. Nothing runs and no budget is spent while it waits.
- **Resuming.** An `Approve` review on the exact head SHA, from an account with write access, resumes the run. `Request changes` becomes a feedback round. A new push invalidates an earlier approval.
- **Enforcement.** Path rules are mirrored in `CODEOWNERS` with "require review from code owners" on `main`, so GitHub blocks the merge. The App cannot approve its own PR. Other rules are evaluated by land using `main`'s copy of `WORKFLOW.md`.
- **Signals come from code.** Lockfile changes mean `new_dependency`, files under a migrations directory mean `migration`, and an exported-symbol diff means `public_api_change`. A model may add a signal but never remove one.

## Feedback and cadence

- **PR feedback.** A review or comment on an open factory PR, from an account with write access, triggers address-pr-comments (mnapoli, MIT) as a build round. It cannot push or reply; the controller does both. Feedback on a merged PR becomes a new `factory:proposed` issue.
- **Scheduled jobs**, weekly at first. Each files `factory:proposed` issues and changes no code:
  - improve-codebase-architecture (Pocock, MIT) with codebase-design and domain-modeling;
  - security-review over the whole repo;
  - audit-instructions (melodic-software, MIT, `--unattended`);
  - agent-loop-hygiene (owner skill, adapted) over the ledger.
- **Self-improvement.** agent-loop-spec (owner skill, adapted) defines the metric: the share of `factory:ready` tickets that land with zero repair rounds and no follow-up defect within a week. pstack's `reflect`, adapted to read the ledger, files skill and prompt proposals as `factory:proposed` issues. Changes to the factory's own skills are judged against a fixed corpus of past tickets replayed on the previous version.

## Ledger and evidence

Each finished run appends one JSON line to `ledger/runs.jsonl` on the orphan branch `factory/ledger`, written only by the controller. Raw Pi sessions stay on the VM. Only redacted evidence (contract, verdict, findings, CI links) is posted to the issue, because this repo is public.

## Package layout

```text
package.json          pi manifest: extension + skills; peer deps pi, pi-herdr-pstack
extension/            /factory status, /factory run <issue> for local runs
skills/               adapted upstream skills, each with SOURCE.md and its license or NOTICE
src/                  run state, stages, policy, adapters, orchestrator, workflow loader
server/               the VM service entry: webhook receiver, tick loop, sandbox runner
.github/workflows/    ci.yml (gates + acceptance), model-smoke.yml, herdr-probe.yml
.github/factory/      WORKFLOW.md: config front matter and repo-specific stage guidance
test/                 unit tests with fake adapters; seeded-bad-patch fixture
```

## Build order

Riskiest unknowns first. Each unit ends in a check before the next starts.

| # | Unit | Check |
| --- | --- | --- |
| 0 | Model access from a hosted runner over the tailnet | VERIFIED: run 40767252647 |
| 1 | Herdr headless on a Linux runner | VERIFIED: run 40768344796 (`docs/prototypes/herdr-on-runner.md`) |
| 2 | Package skeleton and pure controller core | VERIFIED: `npm run check` 60/60, commit `db91d1a` |
| 3 | VM bring-up: tailnet node, Pi, provider, Herdr, Funnel route, GitHub App webhook | from the VM, `pi -p` answers; a GitHub App ping passes signature verification |
| 4 | Orchestrator: Symphony claims, reconcile tick, retries, stall; GitHub adapter; admit; kill switch; marker recovery | tests 3, 4 and 8 of the definition of done |
| 5 | Sandbox runner: Pi RPC in a rootless container with egress limits | an agent inside cannot read the App key or reach GitHub's API |
| 6 | specify + accept | a vague issue ends `needs_info`; a clear one yields a contract and a held-out suite |
| 7 | build + CI gates from `main` + held-out suite in CI | the seeded bad patch fails CI; a good one passes |
| 8 | review + bounded repair | a planted vulnerability produces a blocking finding and a repair round |
| 9 | land + branch protection + checkpoints + ledger | tests 1, 2 and 7 end to end |
| 10 | PR feedback | a write-access review comment on an open factory PR produces a new round |
| 11 | cadence jobs | one scheduled run files `factory:proposed` issues |
| 12 | self-improvement loop | the metric computed from the ledger; reflect files one proposal |
| 13 | Linear adapter on the same receiver | the same tests driven from a Linear issue |

## Owner setup for unit 3

- An exe.dev VM.
- The VM joined to the tailnet as `tag:factory-server`, signed once with `tailscale lock sign`, with a grant to `tag:cliproxy:443` and Funnel allowed for that node only.
- A GitHub App installed on this repo with these settings:
  - **Permissions:** contents, pull requests and issues read/write; checks and metadata read; no `workflows`.
  - **Webhook events:** issues, issue comments, pull requests, pull request reviews, check suites.
  - **Webhook URL:** the Funnel route.
- The App's private key and a dedicated proxy key stored on the VM only.

## Known risks

- **The proxy key is inside agent sandboxes.** A prompt injection could exfiltrate it. It only works from inside the tailnet, the key is dedicated and revocable, and egress from the sandbox is limited. Accepted for v1; needs your sign-off.
- **Public repo.** Anyone can write issue and comment text, and anyone can read logs. Only text from write-access accounts is fed to a model, raw sessions never leave the VM, and no workflow uses `pull_request_target`.
- **One VM is a single point of failure.** If it is down, nothing runs, but nothing wrong lands either: CI and branch protection still guard `main`. The reconcile tick and issue markers let it resume after a restart.
- **Funnel exposes one public route.** It accepts only requests with a valid GitHub (later Linear) signature, acknowledges fast, and queues. Everything else on the VM stays tailnet-only.
- **Correlated blind spots.** The acceptance writer, the judge and the builder are all models. Different families reduce this but do not remove it. The seeded-defect fixtures measure it, and that is the most we can claim.
- **Merged means done for now.** This repo has no deployment. Publishing to npm stays manual until a deploy contract with a smoke check and a rollback exists.
