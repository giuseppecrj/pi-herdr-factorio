# factory-research-1: upstreams of grill-me, improve-codebase-architecture, audit-ticket

Retrieved 2026-10-28. Source tweet (verified via firecrawl): https://x.com/housecor/status/2115482034906800200 (Cory House, 2026-10-28). It lists `/grill-me`, `/audit-ticket`, `/deep-research` before work; `/improve-codebase-architecture` on a cadence. It names no repo or author for any skill.

Summary

| Skill | Canonical upstream | SHA | License | Redistribute in MIT pkg | Confidence |
|---|---|---|---|---|---|
| grill-me | mattpocock/skills `skills/productivity/grill-me` (+ `grilling`) | 59db609eb1e18aaf59b63284d0e52255aff0c63c | MIT | Yes, keep copyright + license text | high |
| improve-codebase-architecture | mattpocock/skills `skills/engineering/improve-codebase-architecture` (+ 3 sibling skills) | 59db609eb1e18aaf59b63284d0e52255aff0c63c | MIT | Yes, same | high |
| audit-ticket | UNVERIFIED. Best candidate bhagyamudgal/skills `skills/audit-ticket` | 006f29ecebda32a74fc0594d84872661540b9c32 | none | NO, without permission | low |

Files are in `research/upstream/<skill>/<owner>__<repo>/` (each has SOURCE.md). All were pinned to the SHA above and left verbatim. Paths below are relative to that directory.

Note on `/deep-research` and others in the tweet: out of scope here.

---

## 1. grill-me

**Canonical**: https://github.com/mattpocock/skills (Matt Pocock, 305,644 stars, MIT, created 2026-02-03, HEAD pushed 2026-10-27). The repo README (via search snippet) says "The fix for this is a grilling session" and links `/grill-me` as the "for non-code uses" skill. vincenzodomina/ai (2 stars, no license) credits Matt's repo in its README. It is an aggregator, not canonical.
Evidence of earliest: `grill-me/SKILL.md` first commit 78649baa 2026-02-25, author Matt Pocock (in the root-level layout). Current path `skills/productivity/grill-me`. Other variants: none checked as credible. I did not diff aggregator copies.

**Important structure**: `grill-me/SKILL.md` is now a 7-line stub. The whole behaviour lives in the sibling skill `skills/productivity/grilling/SKILL.md`. I saved it at `_dependencies/grilling/`. Without it, grill-me does nothing.

**What it does**: Interviews the user relentlessly about a plan until shared understanding. Maps decisions as a design tree. Asks the whole "frontier" of unblocked questions per round, each with a recommended answer. Delegates fact-finding to sub-agents. Ends when the frontier is empty.

**Inputs**: a plan, decision or idea in conversation context. No args, no files.
**Outputs**: no files. A conversation. The "shared understanding" is only in the chat.

**Human gates** (all of them; the skill is human-interactive by design):
- `_dependencies/grilling/SKILL.md:6` "Interview the user relentlessly until you reach a shared understanding."
- `grilling/SKILL.md:8` "Ask the whole frontier in one round ... Then wait for the user's answers before the next round."
- `grilling/SKILL.md:26` "Recompute the frontier and ask the next round."
- `grilling/SKILL.md:28` "The _decisions_ are the user's: put each to them and wait."
- `grilling/SKILL.md:30` "Do not act on it until the user confirms you have reached a shared understanding."
- `SKILL.md:4` `disable-model-invocation: true` (the user must invoke it explicitly).
Headless implication: it cannot run unmodified. In a ticket-triggered factory, either the answer source is the ticket author (post questions as a ticket comment, pause, resume on reply) or a variant that answers its own recommended answers (each question carries "➡️ recommended answer") and flags low-confidence ones. That is a design decision for the factory, not something upstream supports.

**Tools / integrations**: sub-agent dispatch for fact lookup (grilling:28). Filesystem read. No gh, Linear or web.
**Claude-Code-specific**: `Call the Skill tool with "grilling"` (SKILL.md:7); `disable-model-invocation` frontmatter; `agents/openai.yaml` (Codex metadata: `allow_implicit_invocation: false`). No AskUserQuestion; questions are plain chat text.
**License**: MIT, Copyright (c) 2026 Matt Pocock. https://github.com/mattpocock/skills/blob/59db609eb1e18aaf59b63284d0e52255aff0c63c/LICENSE. Redistribution allowed with the copyright and permission notice kept (LICENSE copy saved in the dir).
**Confidence**: high. Not verified: whether Cory uses Matt's version unchanged (he says `/grill-me`; very likely, not confirmed).

---

## 2. improve-codebase-architecture

**Canonical**: same repo, https://github.com/mattpocock/skills, path `skills/engineering/improve-codebase-architecture`. Earliest commit touching the root-level path: d1beb4fe 2026-03-13 by Matt Pocock (the history list showed 949472a7 2026-04-23 and d1beb4fe; earlier history may have been under another path, which I did not trace). Matt's own later commit messages describe "Enhanced the improve-codebase-architecture skill to provide visual reports". vincenzodomina/ai lists it among its aggregated skills; not canonical. No other credible variants found.

**What it does**: Scans a codebase for "deepening opportunities" (shallow modules to deep ones). It uses recent git history for hot spots, spawns a sub-agent to explore, writes a self-contained HTML report (Tailwind and Mermaid via CDN) to the OS temp dir, and opens it. Then a grilling loop on the chosen candidate. It updates GLOSSARY.md and optionally offers ADRs.

**Inputs**: optional user-named direction (module/subsystem/pain point); else it infers from `git log`. Reads `GLOSSARY.md` and `docs/adr/` if present.
**Outputs**: `<tmpdir>/architecture-review-<timestamp>.html` (not in repo). Later, edits to `GLOSSARY.md` and possibly `docs/adr/NNNN-*.md`. No code changes, no issues.

**Human gates**:
- `SKILL.md:22` "If the user named a direction ... take it, and skip the inference below." (optional input, not a block)
- `SKILL.md:39` opens the HTML file for the user (`xdg-open`/`open`/`start`). Fails or is useless headless.
- `SKILL.md:60` "Do NOT propose interfaces yet. After the file is written, ask the user: "Which of these would you like to explore?"" (hard stop)
- `SKILL.md:64` "Once the user picks a candidate, call the Skill tool with "grilling" to walk the decision tree with them" (all of the grilling gates above apply)
- `SKILL.md:70` "Want me to record this as an ADR so future architecture reviews don't re-suggest it?" (yes/no question)
- `_dependencies/domain-modeling/SKILL.md:46,50,58` asks for term clarification, e.g. "Which is it?", "do you mean the Customer or the User?"
- `_dependencies/codebase-design/DESIGN-IT-TWICE.md:11,17,42` shows designs "sequentially so the user can absorb each one" and expects the user to react.
- `SKILL.md:4` `disable-model-invocation: true`.
Headless implication: Step 1 and Step 2 (explore and report) are autonomous and cleanly separable. The factory can run those, attach the report (swap the HTML-to-tmp for a file/comment artifact), and stop at line 60. Step 3 needs a human. A top-recommendation section already exists (SKILL.md:52).

**Tools / integrations**: git (`git log`), sub-agents (explore SKILL.md:27; parallel design in DESIGN-IT-TWICE), local browser open, Tailwind/Mermaid CDNs (network at view time). No gh/Linear.
**Claude-Code-specific**: `Call the Skill tool with "codebase-design" | "grilling" | "domain-modeling"` (SKILL.md:13,64,66,71), so it needs three sibling skills (saved under `_dependencies/`). `disable-model-invocation`. `agents/openai.yaml` for Codex. It also references `/codebase-design` slash syntax (SKILL.md:54). No AskUserQuestion.
**License**: MIT, Copyright (c) 2026 Matt Pocock. Same URL as above. Redistribution allowed with notice. The `_dependencies` are from the same repo and license.
**Confidence**: high on origin and license. Not verified: the earliest introduction commit (path moved); whether Cory runs a modified copy.

---

## 3. audit-ticket (origin NOT established)

**Search done**: `gh search code "audit-ticket" --filename SKILL.md` (about 22 hits, 6 repos), `gh search repos`, `gh repo list housecor` (returned no public repos), firecrawl web searches. Cory House has no public skills repo that I could find. The tweet names no source. I could not tell which `audit-ticket` he uses; it may be private or custom.

Candidates:
1. **bhagyamudgal/skills** `skills/audit-ticket` (Bhagya Mudgal, 2 stars, repo created 2026-04-13, no license). Earliest commit on that path 5d8760d8 2026-07-23. Description: "Audit a stale GitHub issue against the current codebase, then update or sunset it." Closest in name and trigger ("/audit-ticket"), actively maintained (HEAD 2026-10-27). **Best match, chosen for capture. Not proven canonical, and not proven what Cory uses.**
2. **akienm/UnseenUniversity** (and duplicate akienm/TheIgors `lab/claudecode/cc_skills/audit-ticket`): "Filing-time ticket quality gate" (16 checks, duplicate/size/scope) run inside a personal /sorted pipeline. 0 stars, no license, repo created 2026-04-27. Different purpose (checks new drafts, tied to a private "Igor" memory palace). Not downloaded. SHA of UnseenUniversity HEAD at check: 399a0c9776992074141704ce14b47a10292035e5.
3. Others (cromford-ai/cromford, jamesacarr/agent-skills `write-tickets/workflows/audit-ticket.md`, TangleML/tangent-shell `audit-tickets`): only mentions or different skills. Not downloaded. If you need an MIT-clean audit-ticket, these were not evaluated for licence.

**What the captured one does**: Reads a GitHub issue and all comments and images, extracts requirements R1..Rn, pins HEAD and tree SHA, runs one sub-agent per requirement (3-4 parallel) to verify against the frozen tree with file:line evidence, prints a verdict table (done/partial/not-done/obsolete/unverified), then offers fate: update in place, sunset, split, leave. Heavy provenance and guard machinery for writes.

**Inputs**: issue number or URL (`/audit-ticket 123`); asks if missing (SKILL.md:18). Needs a git checkout of the code and `gh auth`.
**Outputs**: markdown report printed to chat. Optionally (only after approval) `gh issue comment`, `gh issue edit`, `gh issue close`, `gh issue create --label ai-created`; temp images in `/tmp/audit-ticket-<n>-img<i>.png`.

**Human gates** (file:line in `SKILL.md` unless noted):
- 15, 18 "When no issue is given, I ask for the number or URL."
- 20 "When the issue repo differs from the code being audited, I stop and confirm which working tree to ground against."
- 64 "When zero requirements are extractable ... I ask the user what specifically to verify before dispatching anything."
- 174-186 Phase 4 "Decide (AskUserQuestion)", header "Ticket fate", 4 options. This is the main block. Report is always printed, but "every `gh` write waits for that explicit choice" (192).
- 196-198 changed HEAD/tree or ticket source means "return to Phase 4 for fresh approval".
- 202 update/sunset: "present their exact frozen bytes and SHA-256 digests ... for fresh explicit approval".
- 204, 206 split: needs "an existing durable ledger that the user has already authorized for writes"; else "stop before create".
- 210 and `references/execute.md:247` second fresh approval for the predecessor comment before close.
- 219 closed issue: "On "Update in place", I ask whether to also reopen."
Headless implication: Phases 1-3 (intake, investigate, report) are fully autonomous when the issue number comes from the ticket. Everything from Phase 4 on is gated. A factory should run Phases 1-3 only and post the report itself, or replace Phase 4 with a fixed policy (e.g. "update in place"). The approval/ledger machinery would have to be rewritten, not just skipped.

**Tools / integrations**: `gh` (issue view/comment/edit/close/create, `gh auth token`), `git` (rev-parse, grep, show on tree IDs), `curl`, sub-agents (`general-purpose`, SKILL.md:76). It references skills not in the repo bundle or not captured: `unslop` (prerequisite per README), `file-issue`, `preflight-mutations`. These are mentioned at SKILL.md:134, 204, 208 and `execute.md:244`; the second and third were not located. Nothing for Linear (GitHub issues only).
**Claude-Code-specific**: `AskUserQuestion` (line 174), `${CLAUDE_SKILL_DIR}` (26, 192), `general-purpose` subagent type via Task tool, slash usage. Frontmatter is only name and description (no allowed-tools).
**License**: NONE. GitHub `licenseInfo` null and no LICENSE file at the repo root at that SHA. Default copyright. **Do not bundle in an MIT package without written permission from the author, or write a clean-room version.** The captured copy is for research only.
**Confidence**: low on "canonical" (unknown), medium that this is the only credible public skill by this name matching the tweet's usage. Not verified: Cory's actual source; whether bhagyamudgal copied from elsewhere; the other referenced skills (`file-issue`, `preflight-mutations`); licence status of other candidates.

---

## Not verified / caveats
- Cory House's own skills are not shown to be public. I did not verify that he runs these upstream versions.
- Star counts and "created" dates are from the GitHub API on 2026-10-28.
- Mattpocock history before the repo reorganisation was not fully traced (rename-aware).
- X post fetched through firecrawl (30 credits).
