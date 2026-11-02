# Factory design

This explanation records the v1 design and later owner decisions. F09a implements local human handoff; main-backed reporter/P4, production protection, real owner actions, and live/performance qualification remain pending. Ledger, PR feedback, cadence, metrics, and Linear below remain later plan units. See [the implementation plan](plans/factory-v1.md) for gates and [the operator guide](operations/human-review.md) for the handoff procedure. The original research is in `research/SYNTHESIS.md` and `research/reports/`.

- GitHub Issues first, Linear next.
- v1 ends at Human Review: the factory opens a PR and a human merges it. Full autonomy comes later by loosening the checkpoint policy, not by rebuilding.
- pstack is a dependency.
- The factory's first target is this repository.
- Runtime is a controller on the exe.dev VM `pi-factorio`, with checks in GitHub-hosted CI, shaped after OpenAI's Symphony.
- GitHub access is plain `gh` through exe.dev's GitHub integration (`GH_HOST=github.int.exe.xyz`). No GitHub App of our own, no token on the VM, and no webhooks: the controller polls, as Symphony does.

## What done means

v1 is done when all of these hold on `giuseppecrj/pi-herdr-factorio`, observed on the real VM and real GitHub:

1. A maintainer labels an issue `factory:ready`. With no further human action, a PR opens with its evidence, labeled `factory:review`, with the owner requested as reviewer. When the owner merges it, the controller closes the issue and writes a ledger row.
2. That commit passed `main`'s gates and a held-out acceptance suite in GitHub-hosted CI. The suite was written from the ticket before any code existed, by a different model family than the builder, and the builder never saw it.
3. The same label applied by an account without write access starts no run.
4. With the kill switch off, a labeled issue starts no run.
5. A seeded known-bad patch fails CI, and nothing lands.
6. A ticket too vague to specify ends as `needs_info` with its questions on the issue, and re-labeling after an answer resumes it.
7. Review comments from the owner on the PR start a fix round, and the PR updates in place.
8. Restarting the controller mid-run neither loses the run nor starts a second one.

Rigor is high. Issue text is untrusted input, and the factory runs model-written code on a VM that can write to GitHub.

## Shape

```text
GitHub ◀──gh poll every 30 s──  exe.dev VM pi-factorio: controller ──Pi RPC in sandbox──▶ agents
   ▲                               │  GitHub via github.int.exe.xyz (token held by exe.dev)
   │                               │  models via an exe.dev integration (key held by exe.dev)
   └──push, PR, comment (gh)───────┘◀──────────────── patch, findings ──────────────────┘
GitHub-hosted CI: main's gates + held-out acceptance on the PR head, no secrets
Human: reviews the PR, comments or merges
```

- **The VM is the brain.** It polls GitHub, decides, runs agents, and is the only thing that writes to GitHub.
- **CI is the judge.** It runs on a fresh GitHub VM with nothing to steal, and branch protection requires it before anyone, human or factory, can merge.
- **No credential lives on the VM or in GitHub.** exe.dev integrations inject them at the network edge. GitHub's repo secrets are empty.
- **The factory acts as `exe-dev-github-integration[bot]`,** not as the owner, so the owner can review and approve its PRs.

## Relation to Symphony

Symphony's spec (`openai/symphony` `SPEC.md`, pinned at `be10a1b`) is the template for the coordination layer. Where we copy it, we copy its semantics, not just its names.

| Symphony | Here | Same or different |
| --- | --- | --- |
| Long-running daemon reading a tracker | controller on the VM | same |
| Poll tick with reconciliation before dispatch (§8.1, §8.5) | a 30 s tick using `gh` | same |
| One authoritative state; `claimed` and `running` checked before dispatch (§7.4) | same, plus a `waiting` state for human checkpoints | extended |
| Retry with backoff `min(10000·2^(n−1), max)`, stall timeout, bounded concurrency (§8.3, §8.4) | same formulas and defaults, concurrency starts at 2 | same |
| Restart recovery from the tracker and filesystem, no database (§7.4) | from the issue's run marker comment, the PR and the workspace | same idea |
| Per-issue workspace, sanitized key, cwd and root invariants (§9.5) | same invariants, plus a bwrap sandbox in its own user scope per stage | stricter |
| Repo-owned `WORKFLOW.md`, front matter config, hot reload (§5, §6.2) | `.github/factory/WORKFLOW.md` with the same loader rules | same, but placed under `.github/` so the factory cannot edit it |
| Tracker adapter normalizing issues (§11) | `TicketAdapter`, GitHub first, Linear second | same |
| One agent session that loops turns until the issue leaves an active state (§7.1) | fixed stages, each a fresh Pi session running one skill | **different** |
| Agent writes to the tracker and PR with its own tools (§11.5) | only the controller writes, with `gh` through the integration | **different** |
| User-input request fails the attempt (§10.5) | the stage ends `needs_info` and the questions go on the ticket | same intent |
| Success can end at `Human Review` | v1 ends at Human Review: PR open, owner merges | same, for now |
| "Proof of work: CI status" | CI is a required gate and also runs the held-out suite | stricter |

Why the two real differences:

- **Fixed stages instead of one looping session.** In Symphony the prompt decides when the work is done. With no human reading the result, "done" has to be decided by code: the validate and review stages, then CI. Fresh sessions per stage also keep the builder away from the acceptance suite.
- **The agent never writes to GitHub.** Symphony assumes a trusted environment. Our input is public issue text. An agent that can comment, push or merge is one prompt injection away from doing it wrongly, so it gets no write credential at all.

Automatic landing is the planned third difference, after v1 has a track record.

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

The types above summarize the design, not the complete wire schema. `src/run.ts` and `src/stages.ts` implement progress, including mandatory merge `waiting`. `advance(run, event)` is pure and delegates candidate decisions to `handoffCandidate` in `src/handoff.ts`. The controller interprets persisted effects; it does not own a second candidate policy. The model never chooses the next stage or decides whether a hard gate passed.

The controller's scheduling state follows Symphony §4.1.8: `running`, `claimed`, `retry_attempts`, totals. Each run also writes a marker comment on its issue (`<!-- factory:run {...} -->`). Recovery needs authenticated markers and protocol-managed private claims/evidence. The public v3 summary cannot reconstruct a missing candidate book, certification, accounts, or budget. A manually rolled-back private file is not covered by the bounded normal-write restart evidence.

```ts
interface TicketAdapter {
  normalize(event: JsonValue): FactoryEvent | null; // parsed gh output
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
| specify | sandbox | audit-ticket (clean-room), grill-me + grilling (Pocock, MIT), deep-research (Pocock, MIT) when needed | none; the model gateway route | `contract.json` with a posted summary, or `needs_info` with one questions comment |
| accept | sandbox, separate from build | new skill, from StrongDM's scenario holdout idea | none; the model gateway route, a different model family from build | held-out acceptance tests, kept on the VM |
| build | sandbox | pstack Feature or Bug fix playbook, tdd | none; the model gateway route | a patch plus visible tests |
| validate | controller + CI | main's gates and the held-out suite in CI; an LLM judge on the VM only for criteria a test cannot express | judge: none; the model gateway route | `verdict.json` bound to the PR head SHA |
| review | sandbox | code-review (Anthropic, Apache-2.0), security-review (Anthropic, MIT), simplify (own), ultrareview (own, via pstack interrogate) on high-risk patches | none; the model gateway route | findings; blocking findings send the run back to build |
| handoff | controller | none, deterministic | none in a sandbox; the controller uses `gh` | PR marked ready, labeled `factory:review`, owner requested, evidence comment on the issue |

### Rules enforced in code

- **Admission.** Only a `factory:ready` label applied by an account with write access counts. The issue body is snapshotted at that moment. Later edits are data for a new run, not permission for this one.
- **Kill switch.** A repository label named exactly `factory:enabled`, which must exist, plus a local flag file on the VM. Either one off holds new dispatch and publication. Handoff rechecks both before writes. Existing-PR merge observation and necessary stop/account/terminal bookkeeping continue; the controller never merges.
- **One run per ticket.** Symphony's claim rule in the controller, with the issue marker as the record that survives restarts.
- **The builder never sees the oracle.** The acceptance suite stays on the VM until build has finished. The controller then pushes it as its own commit on the PR branch under `test/acceptance/<ticket>/`. A builder patch that touches that path is rejected. In a repair round, the builder gets the names of failing scenarios, not their code.
- **Gates come from `main`, not the patch.** CI checks out `main`'s gate script, test files and check config and runs them against the candidate, then runs the candidate's own new tests and the held-out suite. A patch that edits `package.json` scripts or deletes tests cannot weaken the gate that judges it.
- **Hard failures veto.** No review verdict or judge score overrides a failing check.
- **Bounded repair.** At most two rounds back to build. Each round re-runs CI and review on the new head.
- **Hand off only what passed.** The final suite-bearing candidate passes main-owned CI and fresh review before the stable PR ref points to it. Successor candidates include the previous published head as their second ordered parent before certification. Promotion uses `force:false` with predecessor checks and rereads, not atomic expected-head CAS. Ref/PR lag and the final ordinary PR check remain separate gates.
- **Bounded refresh.** Main movement refreshes the same PR with new CI and review. The candidate book retains at most six generations, two shared repairs, three run-wide refreshes, and three issued review attempts per round, respecting stricter configured limits. No same-patch review carry is valid. Review and repair share 30k and 50k tokens per round and the configured run cap, currently 500k. Captured results charge their own account, not a later execution.
- **After handoff the controller watches.** Waiting is nonterminal and model-slot/token/timer-free. Fresh review uses normal capacity two. Merge observation wins from every PR-backed phase and restart before issue eligibility and switch holds. The controller stops and charges captured work, records actual merged head/SHA/actor, then closes the issue. Matching historical certification remains independent of working readiness; unmatched heads are owner overrides. Closed-unmerged cancels. F10 feedback repair and F09b ledger writing are not enabled by F09a.
- **Forbidden paths.** Nothing under `.github/`. Composite actions, CODEOWNERS, dependabot config and the factory's own `WORKFLOW.md` steer the gates. A ticket that needs such a change ends with the patch attached to the issue for the owner to apply.
- **Budgets.** Per-stage turn and wall-clock limits from `WORKFLOW.md`, Symphony's stall timeout, capped repair rounds, and model and runtime totals per run in the ledger.

## Sandbox

Each stage runs Pi in RPC mode inside a bwrap sandbox on the VM, in its own `systemd-run --user` scope with memory, task and CPU limits. The user namespace is unprivileged, but the host uid is still `exedev`: the boundary is the namespaces, the cgroup and seccomp, not the identity. The controller waits for `agent_settled`, not `agent_end`. `docs/operations/sandbox.md` describes it.

- **Mounts.** The issue workspace and a per-stage agent dir are writable. The pinned asset bundle is read-only. No host home and no controller state.
- **Network.** The sandbox has no network. Its only egress is a host-side gateway that rebuilds every request for a fixed route: the model integration and `registry.npmjs.org`.
- **Credentials.** None. The model integration injects its key at exe.dev's edge, and the gateway strips any credential header the sandbox sends.
- **GitHub stays out of reach.** exe.dev integrations answer any process on the VM, so the sandbox has no route of its own, and the gateway never builds a request for a GitHub host. It allows only the model integration and the npm registry. Otherwise an agent could use `gh` itself.
- **Fan-out.** Herdr runs headless inside the sandbox for pstack's fan-out skills. That was verified on a GitHub runner in `docs/prototypes/herdr-on-runner.md`. The VM is the same pattern with more room.

A per-issue directory is not a security boundary on its own. Symphony says so too, and leaves it to the host. The sandbox is our boundary.

## Human checkpoints

V1 requires `checkpoints.approve_merge.mode: always`. No automatic merge path exists. `approve_contract` remains a future type and a disabled attention group, not a supported workflow setting. Path-selected checkpoints, approval-driven autonomous resumption, and CODEOWNERS policy are not shipped v1 behavior.

The conditional production policy has two rulesets. The integrity/check ruleset has no bypass and requires a PR, strict up-to-date `check` and `factory-gates` from app 15368. A separate one-approval rule dismisses stale approvals and permits the tested repository-admin role-5 `pull_request` exception. That exception applies to eligible admins, not a permanently bound username, and cannot bypass the separate failed-check rule. Actions approval stays disabled. The owner alone applies settings after bootstrap and supported main-backed P4 proof; scratch evidence is not production enforcement. See [the owner setup procedure and limits](operations/human-review.md#bootstrap-and-enable-protection-as-the-owner).

The same VM-local attention reader serves CLI status and the registered extension. It groups questions asked/answered, disabled spec review, PR review, blocked, and failed runs without models or GitHub reconstruction. Missing private evidence and unknown ages stay visible. The viewer separates published historical certification from selected working generations and execution accounting.

## Feedback and cadence

- **PR feedback, planned in F10.** A review or comment on an open factory PR, from an account with write access, is intended to trigger address-pr-comments (mnapoli, MIT) as a build round. The planned F10 skill cannot push or reply. Only the controller does both in that planned loop. F10 also turns feedback on a merged PR into a new `factory:proposed` issue. F09a has no PR-comment repair loop and leaves post-publication failures open, not-ready, and observed.
- **Scheduled jobs**, weekly at first. Each files `factory:proposed` issues and changes no code:
  - improve-codebase-architecture (Pocock, MIT) with codebase-design and domain-modeling;
  - security-review over the whole repo;
  - audit-instructions (melodic-software, MIT, `--unattended`);
  - agent-loop-hygiene (owner skill, adapted) over the ledger.
- **Self-improvement.** agent-loop-spec (owner skill, adapted) defines the metric: the share of `factory:ready` tickets that land with zero repair rounds and no follow-up defect within a week. pstack's `reflect`, adapted to read the ledger, files skill and prompt proposals as `factory:proposed` issues. Changes to the factory's own skills are judged against a fixed corpus of past tickets replayed on the previous version.

## Ledger and evidence

F09b is planned to append one JSON line per finished run to `ledger/runs.jsonl` on the orphan branch `factory/ledger`, written only by the controller. Raw Pi sessions stay on the VM. Only redacted evidence (contract, verdict, findings, CI links) is posted to the issue, because this repo is public.

## Package layout

```text
package.json          pi manifest: extension + skills; peer deps pi, pi-herdr-pstack
extension/            /factory status, /factory run <issue> for local runs
skills/               adapted upstream skills, each with SOURCE.md and its license or NOTICE
src/                  run state, stages, policy, adapters, orchestrator, workflow loader
server/               the VM service entry: tick loop, sandbox runner
.github/workflows/    ci.yml (gates + acceptance)
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
| 3 | VM bring-up: Pi, Herdr, `gh` and models through exe.dev integrations | VERIFIED: `gh` reads and writes (labels created); `pi -p` passes on anthropic/claude-sonnet-5-5, anthropic/claude-haiku-4-5, openai/gpt-5.6-luna, openai/gpt-6-astra |
| 4 | Orchestrator: Symphony claims, reconcile tick, retries, stall; GitHub adapter; admit; kill switch; marker recovery | tests 3, 4 and 8 of the definition of done |
| 5 | Sandbox runner: Pi RPC in a bwrap sandbox behind an egress gateway | an agent inside cannot reach `github.int.exe.xyz` or GitHub's API |
| 6 | specify + accept | a vague issue ends `needs_info`; a clear one yields a contract and a held-out suite |
| 7 | build + CI gates from `main` + held-out suite in CI | the seeded bad patch fails CI; a good one passes |
| 7d | Read-only run viewer on loopback (owner decision 2026-10-29, after comparing Warp Factories) | one finished run shows its timeline, per-model usage for parent and children, a children tab and gateway decisions, with untrusted text escaped and no writes |
| 8 | review + bounded repair | a planted vulnerability produces a blocking finding and a repair round |
| 9 | handoff + branch protection + ledger + attention view in `/factory status` | tests 1, 2 and 7 end to end; runs needing the owner are grouped by kind |
| 10 | PR feedback | a write-access review comment on an open factory PR produces a new round |
| 11 | cadence jobs | one scheduled run files `factory:proposed` issues |
| 12 | self-improvement loop, scorers and benchmarks | the metric computed from the ledger; reflect files one proposal; a scorer labels a run and a benchmark compares two variants |
| 13 | Linear adapter, polled like GitHub | the same tests driven from a Linear issue |

## VM

- `pi-factorio` on exe.dev: 2 vCPU, 8 GB, 40 GB, Ubuntu 24.04, tag `factory`, created fresh rather than cloned from `dotfiles` so it inherits no personal integrations.
- Integration `pi-factorio-repo`: exe.dev's GitHub integration for this repo only, acting as its bot, attached to this VM only.
- Model access: exe.dev's built-in `llm` integration at `https://llm.int.exe.xyz`, so no model key and no tailnet on this VM. Anthropic models come through exe.dev's gateway and draw on the account's exe.dev credits. OpenAI models come through the owner's ChatGPT subscription. The owner's 2026-11-02 decision allows Anthropic models on the VM, and plan unit F10c is the first to use them. Pi reaches both by overriding the built-in `anthropic` and `openai` providers' `baseUrl` (`server/provision.sh`).
- Provisioning is `server/provision.sh`, idempotent, run with `ssh pi-factorio.exe.xyz bash -s < server/provision.sh`. It installs Node 26 (at least 26.12.1), Pi 1.4.0, Herdr 0.9.5 (checksum-pinned), pi-herdr-agents and pi-herdr-pstack.

## Known risks

- **Integrations answer anything on the VM.** No key can be stolen, but code running on the VM can use them. The sandbox network blocks the GitHub integration, and the model integration is the only one agents can reach.
- **Public repo.** Anyone can write issue and comment text, and anyone can read logs. Only text from write-access accounts is fed to a model, raw sessions never leave the VM, and no workflow uses `pull_request_target`.
- **Anthropic usage spends exe.dev credits** ($119.75 available on 2026-10-28, no automatic top-up). Every stage defaults to `openai/gpt-6.1-sol` through the ChatGPT subscription, set in `server/provision.sh`. On 2026-11-02 the owner allowed Anthropic models on the VM. Plan unit F10c moves only the accept stage and one blocking review seat to an Anthropic model. The builder and repair stay on OpenAI. Anthropic tokens count against the same stage and run caps. If the credits run out, the Anthropic route is unavailable, and the stage follows the normal retry and refusal rules. No other model substitutes for it unless trusted `WORKFLOW.md` names a fallback, and a same-family fallback run is reported as not cross-family.
- **Review is context-isolated, not cross-family, until F10c ships.** Today reviewer and acceptance seats run the same family as the builder in fresh sessions, and every evidence comment says so. The cross-family requirement in the definition of done stays unmet until F10c records a run whose accept author and at least one blocking seat were observed answering from a different family.
- **One VM is a single point of failure.** If it is down, nothing runs, and nothing lands anyway without a human merge. The reconcile tick and issue markers let it resume after a restart.
- **Correlated blind spots.** The acceptance writer, the judge and the builder are all models. Different families reduce this but do not remove it. The seeded-defect fixtures measure it, and that is the most we can claim.
- **Computer use is deferred.** Owner decision 2026-10-29, after comparing Warp Factories. This repo has no UI, so v1 verifies with text evidence. When the factory targets a UI repo, follow Warp's pattern. Run Xvfb and Chromium inside the stage sandbox. Attach annotated recordings and a bounded number of screenshots to the PR. Give the verifier comment rights only, never approval or merge. Open extra gateway routes only for the app under test.
- **Merged means done for now.** This repo has no deployment. Publishing to npm stays manual until a deploy contract with a smoke check and a rollback exists.
