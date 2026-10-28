# factory-research-3: upstreams of deep-research, address-pr-comments, audit-instructions

Retrieved 2026-10-28. Source tweet (verified via firecrawl): https://x.com/housecor/status/2115482034906800200 (Cory House, 2026-10-28). The tweet names no repo or author for any skill. No `housecor` skills repo exists (`gh repo list housecor` and `gh search code --owner housecor` both returned nothing).

## Headline findings

- **None of the three has a single provable canonical upstream.** Cory's versions may be private or local. Below, "canonical" means "best candidate for our package". Confidence is low-to-medium for all three.
- Claude Code docs (https://code.claude.com/docs/en/skills) list `/code-review` as a bundled skill. They also document `/doctor prompt-audit` (v2.1.283+), a native instruction audit. They have no bundled `deep-research` or `address-pr-comments`. The `deep-research` in those docs is only a sample SKILL.md (`context: fork`, `agent: Explore`, 3 steps).
- **License blockers.** `vincenzodomina/ai` and `199-biotechnologies/claude-deep-research-skill` have no LICENSE file. Redistributing either in an MIT package is not allowed without permission, so they are reference-only.
- Vincenzo's README (https://github.com/vincenzodomina/ai) credits no origin for `audit-instructions` or `fix-pr-review`. They look like his own work. His README SDLC list (grill-me, improve-codebase-architecture, audit-instructions) overlaps Cory's tweet closely, which suggests a shared ecosystem, but the README does not say so. Only `audit-Instructions` is in the history before the README rewrite (2026-06-07), and `fix-pr-review` was added 2026-10-08.
- `mattpocock/skills` (MIT, ~305k stars) is the likely origin of `grill-me` and `improve-codebase-architecture` (see factory-research-1). It has no `audit-instructions` or `address-pr-comments`. It does have a `research` skill, which is not named `deep-research`.

## Layout

Everything is under `research/upstream/<skill>/<owner>__<repo>/`, with a SOURCE.md in each directory. The only files added are the SOURCE.md files. Each directory contains only the skill's paths plus the root LICENSE if the repo has one.

---

## 1. deep-research

Candidates, ranked for "what a Claude Code user in Oct 2026 means by /deep-research":

| Rank | Variant | Evidence | License |
|---|---|---|---|
| 1 | `199-biotechnologies/claude-deep-research-skill` @ `f2f2c0fa4e7617ca84c86b63f4bb40f77a746933` | Skill is literally `name: deep-research`. 1201 stars, created 2025-11-04, last push 2026-04-11. Self-contained pipeline with Python validators. | **None** (reference only) |
| 2 | `daymade/claude-code-skills` `deep-research/` @ `5d405aefd378ce10fd9134c5b9868bc0a2cd0a74` | `name: deep-research`. Repo has 1502 stars, created 2025-10-22. The skill has 20 commits from 2026-01-25 to 2026-10-11, and the repo is actively maintained. | MIT |
| 3 | `mattpocock/skills` `skills/engineering/research` @ `59db609eb1e18aaf59b63284d0e52255aff0c63c` | Named `research`, not `deep-research`. Very popular repo (~305k stars). 12-line skill that dispatches a background agent and writes a cited Markdown file. | MIT |

Others seen but not captured: `Weizhena/Deep-Research-skills` (2438 stars, MIT, named `/research`, multi-phase human-in-loop outline), `langchain-ai/open_deep_research` (12.7k stars, MIT, a LangGraph app and not a skill), `glebis/claude-skills` deep-research (OpenAI Deep Research API wrapper, MIT), `jl-cmd/claude-deep-research` (3 stars).

**Best for the factory:** variant 3 for headless safety and MIT. It is tiny, has no human gate, and fits an ordinary ticket. Variant 1 is the strongest "deep research" in function but cannot be redistributed. Variant 2 is MIT but heavy (provider lanes, paid-provider handoff, clipboard or file collection). We would likely need to write our own thin skill, borrowing the ideas.

### Variant 1 (199-biotechnologies) — detail
- **What it does:** a multi-phase pipeline (scope, plan, retrieve, triangulate, synthesize, critique, refine, package) with modes quick, standard, deep and ultradeep. It produces a citation-tracked report plus JSONL evidence ledgers (SKILL.md:10, 24-29, 74-100).
- **Inputs:** a free-text research query.
- **Outputs:** Markdown, `sources.jsonl`, `evidence.jsonl`, `claims.jsonl`, `run_manifest.json`, HTML and PDF, written to `~/Documents/[Topic]_Research_[YYYYMMDD]/` (SKILL.md:86-93). HTML and PDF are "auto-opened", which is a desktop side effect.
- **Human waits:**
  - SKILL.md:12 — "**Autonomy Principle:** Operate independently. Infer assumptions from context. Only stop for critical errors or incomprehensible queries." This is headless-friendly.
  - reference/quality-gates.md:37 — "After 2 failures: STOP, report issues, ask user"
  - reference/quality-gates.md:49 — "Maximum 3 retry cycles. If still failing after 3 cycles: STOP and report issues to user."
  - reference/quality-gates.md:174-177 — "Stop immediately if: … <5 sources after exhaustive search … User interrupts/changes scope"
  - These are failure-only stops. They need a headless override to "fail the ticket" instead.
- **Tools:** WebSearch (fallback), optional `mcp__Exa__exa_search` and a "search-cli" (reference/methodology.md:84-137). It spawns general-purpose subagents via the Task tool (methodology.md:98, 128-130) and runs Python scripts (`validate_report.py`, `verify_citations.py`, `md_to_html.py`). It needs WeasyPrint for PDF (requirements.txt).
- **Claude-Code specifics:** the Task tool with `subagent_type="general-purpose"`, `mcp__Exa__*` tool names, auto-spawned continuation agents for reports over 18K words (continuation.md), and `~/Documents` output paths.
- **License:** none. The GitHub API reports no license, and the README does not grant one. Cannot be redistributed or adapted in an MIT package without the author's permission.
- **Canonical URL + SHA:** https://github.com/199-biotechnologies/claude-deep-research-skill @ `f2f2c0fa4e7617ca84c86b63f4bb40f77a746933`.

### Variant 2 (daymade) — detail
- **What it does:** a lead agent plus parallel subagents. It runs P0-P7 (environment, question map, dispatch, citation registry, outline, draft, counter-review, verify). It also has an enterprise-company mode and provider lanes (ChatGPT, Kimi, UniFuncs) with durable `study.json` assets (SKILL.md:13-48).
- **Inputs:** a research question, optional seed URLs and entities.
- **Outputs:** a source-traced report, a research-notes directory, and a study archive registered through `research_assets.py` and `provider_runs.py`.
- **Human waits:**
  - SKILL.md:147 — "E7: Present draft for human review and iterate"
  - SKILL.md:135 — "E1: Intake — confirm company entity, research depth, format contract" (enterprise mode only)
  - SKILL.md:216 — "Confirm the exact legal entity being researched"
  - SKILL.md:48 — paid-plugin spending needs explicit authorization or the lane is deferred, so a human decision is needed.
  - Its provider lanes involve a human operating ChatGPT or Kimi web UIs (references/provider-run-contract.md, report-file-collection.md). That is a poor fit for a headless run.
- **Tools:** subagent dispatch ("Preferred", SKILL.md:116, with sequential fallback), web search or fetch, a writable filesystem, and Python 3 scripts.
- **Claude-Code specifics:** Task subagents and `references/subagent_prompt.md`.
- **License:** MIT (daymade). Redistribution and adaptation are allowed with the notice kept. https://github.com/daymade/claude-code-skills/blob/5d405aefd378ce10fd9134c5b9868bc0a2cd0a74/LICENSE

### Variant 3 (mattpocock `research`) — detail
- **What it does:** it spins up a background agent that investigates a question against primary sources and writes one cited Markdown file in the repo (SKILL.md:6-12). It does not answer in conversation (docs/engineering/research.md:5).
- **Inputs:** a question. **Outputs:** one Markdown file, placed where the repo keeps such notes.
- **Human waits:** none in the skill. Its only human-facing step is "say where" the file went (SKILL.md:12). Fully headless-safe.
- **Tools:** a background or subagent mechanism plus web and docs access. **Specifics:** "background agent" mechanics; includes an `agents/openai.yaml`.
- **License:** MIT (Matt Pocock). https://github.com/mattpocock/skills/blob/59db609eb1e18aaf59b63284d0e52255aff0c63c/LICENSE

**Confidence:** medium that variants 1-3 are the right candidate set. Low that Cory means any specific one. Gap: Cory's own version is unknown.

---

## 2. address-pr-comments

Candidates:

| Rank | Variant | Evidence | License |
|---|---|---|---|
| 1 | `microsoft/vscode-pull-request-github` `src/lm/skills/address-pr-comments` @ `5c9265159f71033d6ae386bf0d860db157e7b0c4` | Exact name. First commit 2026-03-17, 3 commits. Official GitHub PR extension, 2636 stars. | MIT |
| 2 | `fallow-rs/fallow` `.claude/skills/address-pr-comments` (generated from `.agents/skills/…`) @ `255f50fe417491a6e9d3dbae20359d36a7640135` | Exact name. 5264 stars. First commit 2026-07-29, last 2026-09-23. Evidence-triage design. | MIT |
| 3 | `mnapoli/skill-address-pr-review` @ `db7024d4537e6ec24f0f53cef6445c3731bd117d` | Named `address-pr-review`. 15 stars, 2026-03-11. Has helper `gh` GraphQL scripts and handles CI failures. | MIT |
| ref | `vincenzodomina/ai` `skills/fix-pr-review` @ `3613bfada452322476b3cd2e7516ad409976a871` | Named `fix-pr-review`, a 9-line skill. 2 stars. | **None** (reference only) |

Many other copies exist (`majiayu000/claude-skill-registry`, `Automattic/pocket-casts-ios` (MPL-2.0), `Cecilapp/Cecil` (EUPL-1.2), `androoAGI/starnet`). Those are aggregators or project-specific. Not captured.

**Canonical (best candidate):** Microsoft's has the earliest dated exact-name skill from a credible org. It depends on VS Code Copilot tools (`github-pull-request_*`), so it is not portable to Claude Code as-is. For the factory, variant 3 (`mnapoli`) is the most directly usable: `gh`-based, with ready scripts. Variant 2 has the best triage logic but is repo-specific (cites `docs/development/quality-gates.md` and AGENTS.md).

### Per-variant details
- **What each does:**
  - Microsoft: reads the active PR via a VS Code tool, collects unresolved threads, plans and applies minimal fixes, resolves threads, summarizes.
  - fallow: checks each comment against the code at PR head, buckets it into Act on, Consider, Noted or Dismissed, and fixes the "Act on" items. It then runs validation and drafts replies.
  - mnapoli: fetches unresolved threads and failing CI by script, fixes both, commits and pushes, then replies to and resolves each thread.
- **Inputs:** the active or current PR (Microsoft), PR metadata via GitHub (fallow), or the current branch's PR via `gh` (mnapoli). Microsoft takes an optional reviewer or file focus.
- **Outputs:** code changes and a summary. mnapoli also commits, pushes, and posts replies. Microsoft resolves threads. fallow only drafts replies.
- **Human waits:**
  - fallow, `.claude/skills/address-pr-comments/SKILL.md:20` — "Consider: valid, but it has a cost or changes scope. Ask the maintainer."
  - fallow, lines 24-25 — "Draft one reply per thread for the maintainer to approve. Never post a reply or resolve a thread." The skill never posts, so a factory would need to override this.
  - Microsoft, SKILL.md:52 — "If a comment is unclear or contradictory, note it for a follow-up reply rather than guessing." Line 72 — "Any follow-up questions for the reviewer". These are deferred notes and not blocking.
  - mnapoli, SKILL.md:30 — "If there are no unresolved threads and CI is green, stop here." That is a no-op exit and not a human wait. Line 3 has `disable-model-invocation: true`, so the user must invoke it explicitly, which a ticket trigger can do. Otherwise there are no human gates, and it pushes and replies autonomously (SKILL.md:47-60).
- **Tools:**
  - Microsoft: the VS Code GitHub PR extension tools `github-pull-request_currentActivePullRequest` and `github-pull-request_resolveReviewThread` (SKILL.md:21, 63). Not available in the Pi or Claude CLI.
  - fallow: `gh` or GitHub API, the local checkout, and a test runner.
  - mnapoli: `gh` plus the three bash scripts `get-unresolved-threads.sh`, `get-failing-ci.sh` and `reply-to-thread.sh`.
- **Claude-Code specifics:**
  - mnapoli: frontmatter `context: fork` and `allowed-tools: Bash(bash ~/.claude/skills/address-pr-review/*)` (lines 5-6). It assumes install at `~/.claude/skills/`, and the task-per-item tip assumes TodoWrite/Task.
  - fallow: the `.claude` copy is generated from `.agents/skills` (a "Do not edit" header), and it follows repo-specific AGENTS.md rules ("no AI attribution, signed commits").
  - Microsoft: VS Code LM tools only.
- **License:** all three are MIT (Microsoft, fallow, mnapoli), so redistribution and adaptation are allowed with notices kept. `vincenzodomina/ai` has no license, so it is reference-only.
- **Canonical URL + SHA:** https://github.com/microsoft/vscode-pull-request-github @ `5c9265159f71033d6ae386bf0d860db157e7b0c4`.

**Confidence:** medium on the candidate set, low on canonical. Gaps: I did not check older copies in the registries. Cory's version is unknown, and the exact earliest author was not established.

---

## 3. audit-instructions

Candidates:

| Rank | Variant | Evidence | License |
|---|---|---|---|
| 1 | `melodic-software/claude-code-plugins` `plugins/harness-config/skills/audit-instructions` @ `f885cd1751e5b729ba153bbd56f6f385ad0f4143` | Most complete: 36KB SKILL.md, a check catalog I1-I42, scripts, evals. 28 stars. 23 commits, 2026-10-02 to 2026-10-25. Report-only. | MIT |
| 2 | `desertcache/agent-os` `skills/audit-instructions` @ `211bd89ec63701389213cbe0085280c484970edd` | 83 lines. Single commit 2026-02-26 (the earliest dated variant found). Audits CLAUDE.md, memory, skills and settings.json for stale, missing, redundant and conflicting rules. | MIT |
| 3 | `vincenzodomina/ai` `skills/audit-Instructions` @ `3613bfada452322476b3cd2e7516ad409976a871` | 13 lines. Created 2026-06-07. A "post-mortem" prompt: "What in your instructions caused this behavior?". Differs in kind: it explains a specific bad outcome and does not sweep files. | **None** (reference only) |

Others: `0xb11a/crypto-claw` (no license), `sextondjc/agentic-marketplace` (MIT, a governance review variant), and the native `/doctor prompt-audit` in Claude Code.

**Canonical (best candidate):** none is demonstrably canonical. Cory's tweet puts it on a scheduled cadence ("check for opportunities"), which matches a file-sweep audit (variants 1 and 2) rather than Vincenzo's post-mortem. For a factory, variant 2 is the smallest MIT option to adapt. Variant 1 is the most capable but is a heavy, Claude-Code-plugin-specific workflow. The native `/doctor prompt-audit` is also an option, with no packaging needed.

### Per-variant details
- **Variant 1:**
  - **What it does:** it sweeps CLAUDE.md, AGENTS.md, rules, skills, agents and hook text for stale, misstated or conflicting instructions against current model capability. It tiers findings by evidence and produces a human-gated diff (SKILL.md:15-32).
  - **Inputs:** `[scope] [--target-model <version>] [--opinion] [--persist-findings] [--unattended]` (frontmatter `argument-hint`).
  - **Outputs:** a findings table. It is report-only, with `disallowed-tools: Edit, NotebookEdit` (line 4).
  - **Human waits:**
    - Lines 281-283 — "Before the total dispatch count … would exceed ~20, confirm with the user; with `--unattended`, proceed instead".
    - Lines 191-192 — "`--unattended` declares that nobody is available to answer … a run without the flag asks."
    - Lines 167-172 — an ambiguous target model aborts with a suggested `--target-model`. That is a non-interactive abort that the user must confirm by re-running.
    - Lines 107-108 and 125 — never applies fixes. The human applies the diff.
    - So it is headless-capable via `--unattended`.
  - **Tools:** a fresh read-only subagent per lane (line 207), bash scripts (`instruction-scan.sh`, `lane-runs.sh`, `conflict-scan.sh`, `emit-findings.sh`), and python3 for `restatement-scan.py`.
  - **Claude-Code specifics:** `${CLAUDE_PLUGIN_ROOT}`, the `disallowed-tools` frontmatter, references to the bundled `claude-api` skill and `/doctor`, non-fork subagents, and Claude Code docs URLs. It is tightly coupled.
  - **License:** MIT (https://github.com/melodic-software/claude-code-plugins/blob/f885cd1751e5b729ba153bbd56f6f385ad0f4143/LICENSE).
- **Variant 2:**
  - **What it does:** it reads fixed config paths (`~/.claude/CLAUDE.md`, memory files, a `BRAIN.md` vault file, all skills, settings.json) and reports STALE, MISSING, REDUNDANT and CONFLICT items.
  - **Human waits:**
    - Line 12 — "Do NOT apply fixes without user confirmation."
    - Line 75 — "After presenting the report, ask: \"Want me to apply the suggested fixes?\""
    - Line 81 — "Don't auto-fix anything — always ask first"
    - A headless run just stops at the report.
  - **Specifics:** paths come from `agent-os.config.json`, which is private to that project (line 16), plus a personal vault path and `BRAIN.md`. It needs adapting to run elsewhere.
  - **License:** MIT (desertcache).
- **Variant 3:**
  - **What it does:** a 13-line prompt that asks the agent to explain what in its instructions caused an unexpected result, and to propose fixes.
  - **Human waits:** it is triggered by a human saying the behavior was unexpected, so it needs a prior conversation. It is not a standalone scheduled sweep and does not fit a ticket trigger without context.
  - **License:** none, so reference-only.
- **Tools needed:** file read and Glob. Variant 1 additionally needs subagents, bash and python3.
- **Canonical URL + SHA:** none established. The nominal pick is https://github.com/desertcache/agent-os @ `211bd89ec63701389213cbe0085280c484970edd`.

**Confidence:** low-to-medium. Gaps: Cory's version is unknown, and it is unclear whether he means the native `/doctor prompt-audit` or Vincenzo's post-mortem prompt.

---

## Headless-factory summary

| Skill | Best MIT candidate | Human gate to remove or override |
|---|---|---|
| deep-research | mattpocock `research` | None. The variants with gates are 199-bio (failure stops only, no license) and daymade (E7 draft review, entity confirm, paid-lane approval). |
| address-pr-comments | mnapoli (or Microsoft/fallow ideas) | mnapoli has none and posts and pushes autonomously. fallow needs "ask the maintainer" and "approve replies" replaced. Microsoft needs its VS Code tools swapped for `gh`. |
| audit-instructions | desertcache (small) or melodic (`--unattended`) | desertcache asks before applying fixes; skip that step. melodic asks for confirmation above ~20 dispatches; `--unattended` covers it. |

## Not done / gaps
- Cory's own skills were not found; no repo is credited. Origin attribution (who copied whom) could not be proven from commit dates alone.
- I did not search the skills.sh directory beyond a failed page scrape, and did not check older registry copies.
- `.ruff_cache/` files in the 199-bio capture are verbatim from the upstream tree (they are committed there).
- The pi-lens Pyright warnings on `daymade/.../provider_runs.py` are upstream code and were left unmodified on purpose.
- Evals and tests are included where they sit inside the skill path, so the captures are large (deep-research 744K, audit-instructions 848K, address-pr-comments 404K).
