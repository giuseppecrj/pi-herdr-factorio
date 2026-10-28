# Factory research 2: /security-review, /code-review, /ultrareview, /simplify

Retrieved 2026-10-28. Captured under `research/upstream/<name>/`, each with a SOURCE.md.
Nothing was extracted from an installed binary. "UNOFFICIAL" material is a third-party extraction by Piebald-AI, MIT repo `Piebald-AI/claude-code-system-prompts` @ `53c252d35963adced4ca68434c32da6f1cd5fff3`.
I did not open the housecor tweet. The four names come from the task.

## Licensing, applies to all four (checked precisely)

| Repo | License | Evidence |
|---|---|---|
| anthropics/claude-code | **Not open source.** `LICENSE.md`: "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service." (GitHub API reports no SPDX.) | `gh api repos/anthropics/claude-code/contents/LICENSE.md` @ 58d6da1e34d6cd1c6379dcbf568bd66f5f9b6102 |
| anthropics/claude-plugins-official | Apache-2.0 (repo and each plugin has its own LICENSE) | f8c5e7a1dcb71b10cb74586224b5401f3de5db28 |
| anthropics/claude-code-security-review | MIT, "Copyright (c) 2025 Anthropic" | 0c6a49f1fa56a1d472575da86a94dbc1edb78eda |
| code.claude.com docs | No license stated; treat as all rights reserved | n/a |
| Piebald-AI extraction | MIT on their repo only; it does not license Anthropic's underlying text | n/a |

**Adaptation in an MIT package.**
- MIT (security-review) and Apache-2.0 (code-review plugin, code-simplifier) sources can be redistributed or adapted in an MIT package. Keep the copyright and license notice. For Apache-2.0, also state changes and carry a NOTICE if present. Apache-2.0 content can sit inside an MIT package, but those files stay Apache-2.0, so ship each LICENSE next to them.
- The bundled built-in prompts (`/simplify`, built-in `/code-review` with effort levels, `/ultrareview`) have no published license and no published text. Do NOT copy the Piebald extractions into a shipped package. Write original prompts that match the documented behavior.
- anthropics/claude-code is all-rights-reserved. Its `plugins/` directory no longer holds plugins (commit aef1f311bfd303b3945414a103a28a40c868d453, "this repository no longer holds any plugin code"), so nothing from it was needed. Its CHANGELOG.md (sha 6430caec78e2af5049bf05b8855df882e0754fba) is useful for history only; I did not copy it.
- This is not legal advice. Re-check before shipping.

---

## 1. /security-review

**Canonical source: published file in a repo (also a GitHub Action).**
- Prompt: `anthropics/claude-code-security-review` @ `0c6a49f1fa56a1d472575da86a94dbc1edb78eda`, `.claude/commands/security-review.md`. MIT.
- URL: https://github.com/anthropics/claude-code-security-review/blob/0c6a49f1fa56a1d472575da86a94dbc1edb78eda/.claude/commands/security-review.md
- The Action (`action.yml`, `claudecode/`) is the CI form. The whole repo is saved to `research/upstream/security-review/anthropics__claude-code-security-review/`.
- The built-in command in the binary is documented in `commands.md`: "Analyze the changes on your current branch for security vulnerabilities. Reviews the diff between your branch and origin's default branch… Needs an `origin` remote".
- The built-in is also callable through the Skill tool (`skills.md`: "A few built-in commands are also available through the Skill tool, including `/init` and `/security-review`").
- Whether the shipped built-in still matches the repo file is unverified. The repo file is the best published reference. A Piebald extraction (UNOFFICIAL) is saved for comparison.
- Separate newer product: the **Claude Security plugin** (`plugins/claude-security` in claude-plugins-official, multi-agent, dynamic workflows, SARIF output). Docs say it is "distinct from… `/security-review`, which runs a single pass over your branch". Docs saved (`docs/claude-security.md`); plugin source not downloaded (out of scope, large).

**What it does.** Senior-security-engineer review of only the changes newly added on the branch. It reports high-confidence, exploitable issues. Three phases: repo context, comparative analysis, vulnerability assessment. A sub-task finds issues, then parallel sub-tasks filter false positives. Findings are dropped below confidence 8 (the doc text says "confidence less than 8").

**Inputs.** No arguments. It inlines `git status`, `git diff --name-only origin/HEAD...`, `git log origin/HEAD...` and `git diff --merge-base origin/HEAD` through `!` shell injection (file lines 8-30). It needs an `origin/HEAD`.

**Outputs.** A markdown report only ("Your final reply must contain the markdown report and nothing else", line ~194). Fields: file, line, severity, category, description, exploit scenario, recommendation. No files are written and nothing is posted. The Action wrapper posts PR comments (`scripts/comment-pr-findings.js`).

**Human wait points.** None in the prompt. It is read-only and one-shot. (Docs mention an `ambiguous argument` failure when `origin/HEAD` is missing; that is an error, not a prompt.)

**Tools needed.** Frontmatter line 2: `allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Bash(git show:*), Bash(git remote show:*), Read, Glob, Grep, LS, Task`.

**Claude-Code mechanics.**
- `allowed-tools` frontmatter.
- `!` command injection of the diff.
- `Task` sub-tasks, with parallel false-positive filters.
- Numeric confidence scoring (1-10, threshold 8).
- A long hard-exclusion list and a precedent list inside the prompt.
- The Action path uses the Claude API client plus `gh`.

**Portability to Pi.** High. The prompt is plain text. In Pi, replace `Task` with a subagent call and the `!` injection with explicit git commands.

**License/redistribution.** MIT, copy and adapt freely with notice. Docs are not redistributable.

**Confidence: high** that the prompt is the published lineage. **Gaps:** the exact text in the current binary is unknown; the Piebald extraction was not diffed against the repo file.

---

## 2. /code-review

**Two different canonical things share the name. Confirmed.**

**A. Built-in `/code-review` (bundled skill, alias `/review`): bundled in the binary, docs only.**
- `commands.md` marks it **Skill**.
- Syntax: `/code-review [low|medium|high|xhigh|max|ultra] [--fix] [--comment] [--max-findings n|all|default] [pr#|branch|path]`.
- It "Review[s] the current diff, or a PR number, branch, or path you pass, for correctness bugs".
- `/review` was a separate read-only PR command before v2.1.223. Docs also say `/simplify` was the pre-v2.1.147 name of this review, which applied fixes by default.
- Docs saved: `code-review/docs/{commands,code-review-local,code-review-customize,code-review-cloud-service,whats-new-2026-w21}.md`.
- UNOFFICIAL extraction (many parts: effort modes, finder angles, 3-state verification, GitHub comment posting, fix application) is saved under `code-review/UNOFFICIAL__Piebald-AI__.../`.

**B. Published plugin `code-review` (PR reviewer).**
- `anthropics/claude-plugins-official` @ `f8c5e7a1dcb71b10cb74586224b5401f3de5db28`, `plugins/code-review/` (commands/code-review.md, README.md, plugin.json v1.0.1, LICENSE).
- URL: https://github.com/anthropics/claude-plugins-official/tree/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/code-review
- Apache-2.0.

**What B does.**
- Pipeline for a PR: gate-check agent, then CLAUDE.md file discovery, then a PR summary.
- Then 4 parallel reviewers: 2 CLAUDE.md-compliance sonnet agents and 2 Opus bug agents.
- Each bug finding is validated by a parallel subagent. Unvalidated findings are dropped.
- The README says confidence 0-100 with an 80 threshold. The command file itself uses validation subagents rather than a numeric score. That is a README/prompt mismatch.

**Inputs (B).** A PR (number or URL), plus an optional `--comment` flag. It uses `gh pr view/diff`.

**Outputs (B).** Terminal summary. With `--comment`, inline PR comments, or a "No issues found" comment (lines 60-78, 94-102).

**Human wait points (B).**
- `code-review.md:64`: "If `--comment` argument was NOT provided, stop here. Do not post any GitHub comments." Posting is opt-in via flag, not an interactive question.
- Line 72: inline comments are created "with `confirmed: true`". That is a tool parameter, not a human prompt.
- Line 21: stops automatically if the PR is closed, draft, trivial, or already reviewed by Claude.
- No interactive human waits otherwise.

**Human wait points (A, docs).**
- `code-review-local.md:40`: "With `--fix` or `--comment`… you may be asked to approve its edits." Edits go through the permission mode.
- Line 31: `--fix` edits go "through your permission mode".

**Tools (B).** Frontmatter line 2: `Bash(gh issue view:*), Bash(gh search:*), Bash(gh issue list:*), Bash(gh pr comment:*), Bash(gh pr diff:*), Bash(gh pr view:*), Bash(gh pr list:*), mcp__github_inline_comment__create_inline_comment`.

**Claude-Code mechanics (B).**
- Model-tiered subagents (haiku, sonnet, opus).
- Parallel agents, validation fan-out, and a todo list.
- `mcp__github_inline_comment__create_inline_comment` (a Claude Code GitHub-app MCP tool).
- CLAUDE.md scoping by file path.
- Permalink format requires a full SHA.

**Portability to Pi.** Medium. The prompt is portable, but the inline comment tool needs a replacement such as `gh api` review comments. Agent-tier names map to Pi model routing.

**License.** B is Apache-2.0 (adaptable with notice). A has no published text; write your own from the docs. Only the docs describe A officially.

**Also exists, not captured:** the managed "Code Review" GitHub service (docs saved) and `pr-review-toolkit` (Apache-2.0, plugins-official; not downloaded).

**Confidence: high** on B. **Medium** on A, since the text is unpublished and the extraction is version-dependent. **Gap:** the README/prompt scoring mismatch above.

---

## 3. /ultrareview

**Canonical source: bundled in the binary and server-side; docs only. No published prompt exists.**
- Docs: https://code.claude.com/docs/en/ultrareview.md, saved as `ultrareview/docs/ultrareview.md`, along with `commands.md`.
- The Piebald-extracted client strings (UNOFFICIAL) hold no review prompt. The review fleet runs in the cloud, so the prompt is not in the client.

**Current status per docs.**
- Preferred invocation is `/code-review ultra`. `/ultrareview [PR or branch]` is an alias; the UNOFFICIAL string calls it "deprecated".
- Non-interactive form: `claude ultrareview` subcommand.
- Docs state "a larger fleet of reviewer agents explores the change in parallel" in a cloud sandbox.

**What it does.** A deep multi-agent review in an Anthropic cloud sandbox. It verifies findings and reports them back to the session.

**Inputs.**
- No argument: the current branch vs. the default branch (the local repo is bundled and uploaded).
- `<PR#>`: github.com PRs only; the sandbox clones the PR.
- A base branch or commit.
- Free text becomes a note.

**Outputs.** Findings return to the terminal after about 15-25 minutes. Optional single PR comment with `--post`.

**Human wait points (docs, `ultrareview.md`).**
- Line 35: "Before launching, Claude Code shows a confirmation dialog with the review scope, your remaining free runs, and the estimated cost".
- Line 71: "Claude Code never posts unless you choose to on that run, and `--no-post` is the default."
- Line 73: interactive, you pick "Run and post the findings to the PR as me". `--post` only preselects it and "still asks before launching".
- Line ~132: usage-credits billing confirmed once per conversation.
- Line 108: a first-commit review needs confirmation.
- Line 160: the `claude ultrareview` subcommand treats running it as consent and does not stop to ask.

**Tools/integrations.**
- A claude.ai login (API key alone is not enough).
- Usage credits: 3 free runs on Pro/Max, then about $5-25 per review.
- git ≥ 2.31 for upload; GitHub account connected via `/web-setup` for PR mode.
- Workspace trust prompt for the subcommand (`--trust-workspace`).
- 45-minute default timeout.

**Claude-Code mechanics.** Cloud sessions, background tasks, `/tasks`, billing, and upload filtering of credential files (per CHANGELOG).

**Portability to Pi.** Not reproducible. It is a proprietary cloud service; the package can at best shell out to `claude ultrareview` if the user has Claude Code, or provide a local multi-agent approximation.

**License.** The service and prompt are unpublished. Only the docs text was captured (not redistributable).

**Confidence: high** that no prompt is published (searched claude-code, claude-plugins-official and the docs). **Gaps:** the fleet's structure and prompts are unknown.

---

## 4. /simplify

**Canonical source: bundled skill in the binary; docs only. A different published thing exists: the `code-simplifier` plugin.**
- Docs: `commands.md` row, saved as `simplify/docs/commands.md`: "**Skill.** Review the changed code for cleanup opportunities and apply the fixes. Four review agents run in parallel, covering reuse of existing helpers, simplification, efficiency, and whether the change is at the right level of abstraction. The review doesn't look for correctness bugs."
- Syntax: `/simplify [target]` (path or PR reference).
- `skills.md:71`: with a skill named `verify` or `simplify` present, commit instructions tell Claude to run it before each commit. The bundled `/simplify` does not count; only user, project or enterprise copies do.
- History: before v2.1.147 `/simplify` was the bug-hunting review and applied fixes by default; it is now cleanup-only (`code-review-local.md:164`).
- UNOFFICIAL extraction (ccVersion 2.1.154) is saved: `agent-prompt-simplify-slash-command.md`. The angle blocks are template variables, so it is incomplete. It adds a companion inline-mode prompt for when the agent tool is unavailable.
- Published alternative: `anthropics/claude-plugins-official` @ `f8c5e7a1dcb71b10cb74586224b5401f3de5db28`, `plugins/code-simplifier/agents/code-simplifier.md`. Apache-2.0.
  - URL: https://github.com/anthropics/claude-plugins-official/tree/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/code-simplifier
  - It is a single `opus` subagent that simplifies recently modified code while preserving behavior. It is not the same as the bundled four-agent skill.

**What it does.** The bundled skill gathers the diff and runs 4 parallel cleanup agents (reuse, simplification, efficiency, altitude/abstraction). It deduplicates, then applies fixes directly, skipping fixes that change behavior or reach outside the diff. It ends with a summary of what was fixed and skipped.

**Inputs.** The diff of changed code by default; optionally a path or PR reference.

**Outputs.** Edits to the working tree and a summary. No posting.

**Human wait points.**
- None in the extracted prompt ("Wait for all four agents to complete" refers to subagents, not a human).
- Edits go through the user's permission mode.
- Plugin agent: none.

**Tools.** The Agent/Task tool (parallel, in one message), file edit tools, and git. The plugin agent's frontmatter has only `name`, `description` and `model: opus`.

**Claude-Code mechanics.** Parallel subagents in a single message, skill auto-run before commit (user-defined copy only), and the CLAUDE.md standards that the plugin agent assumes. The plugin agent's body hardcodes ES-module and React conventions that would need generalizing.

**Portability to Pi.** High for a re-implementation from the documented behavior (4 angles, then apply). Good fit as a pre-commit step.

**License.** The bundled prompt has no published license. The plugin is Apache-2.0 and can be adapted with notice.

**Confidence: high** on the docs behavior. **Medium** on the extraction, which is version-dated (2.1.154) and templated. **Gap:** the angle block texts are not in the captured file.

---

## Summary table

| Item | Form | Published prompt | License | Pinned SHA |
|---|---|---|---|---|
| /security-review | repo file + GitHub Action | yes (`.claude/commands/security-review.md`) | MIT | 0c6a49f1fa56a1d472575da86a94dbc1edb78eda |
| /code-review (plugin) | plugin in repo | yes | Apache-2.0 | f8c5e7a1dcb71b10cb74586224b5401f3de5db28 |
| /code-review (built-in) | bundled skill | no (docs; UNOFFICIAL extraction) | unpublished | n/a |
| /ultrareview | cloud service | no (docs only) | n/a | n/a |
| /simplify (built-in) | bundled skill | no (docs; UNOFFICIAL extraction) | unpublished | n/a |
| code-simplifier | plugin agent | yes | Apache-2.0 | f8c5e7a1dcb71b10cb74586224b5401f3de5db28 |

## Not done
- I did not diff the UNOFFICIAL extractions against the repo files.
- I did not download the `pr-review-toolkit` or `claude-security` plugins.
- I did not read the tweet.
- The Piebald extractions were taken at their latest main, so their ccVersion headers differ across files.
