---
name: daily-log-pi-herdr-factorio
description: "Read pi-herdr-factorio daily logs first for start-of-day catch-ups, yesterday's work, or weekly summaries. Append verified outcomes, decisions, blockers, and next steps after substantive work."
---

# Repo daily log

## Scope

This skill owns the checkout containing this file. Resolve the repo root from this skill's location, not from the shell's current directory. Store personal logs at `<repo-root>/.pi/daily-log/YYYY-MM-DD.md`. Use the machine's local date unless repo instructions specify a timezone.

Logs are personal and untracked. This skill and the repo's logging instructions are shareable. Never commit logs, copy them into tracked documentation, or include secrets, tokens, environment dumps, or unnecessary personal information.

## Catch up

1. Read repo instructions, then the newest dated logs covering the requested period. Read older entries only for unresolved carry-over or an explicit historical question. If logs are missing or empty, say so and continue with available repo evidence.
2. Summarize completed work, decisions, blockers, and next steps from those entries. Cite log paths and headings. A plan is not a completed outcome. A recorded ticket state is historical until checked again.
3. For current status, inspect local Git state and query only the relevant configured external sources. Follow repo-specific tool preferences. Otherwise try `gh` first for GitHub and use an available integration if the CLI cannot access it. Do not install or authenticate tools as part of a catch-up.
4. Fetch changes since each source's last successful coverage timestamp, with a small overlap to avoid timestamp-boundary gaps. Deduplicate by stable IDs. A log's date or modification time does not prove external coverage. Without a checkpoint, use the requested period or the latest log's calendar day as a bounded starting window and report that limitation.
5. Scope forge queries to this repo. Add sibling repos only when the user requests a cross-repo summary. Query configured issue projects and chat channels only when relevant. Follow pagination and read relevant thread replies. A failed, truncated, or partial fetch is incomplete coverage, not an empty result.
6. Keep source output bounded. Select relevant fields and summarize large responses before returning them. Do not dump raw payloads or unrelated conversations.
7. Return a concise rundown of completed work, decisions, blockers, and next actions. Cite live sources for new facts. Name unavailable sources and the period actually checked. Skip empty sections.

## Record work

1. After substantive work, read today's existing log before appending. Create the directory and dated file only when there is something factual to record. Verify that the log path is ignored and untracked before writing. If it is not, stop the write and report the privacy blocker.
2. Append a short timestamped section using the layout below. Record verified outcomes and decisions with evidence. Include test commands and results, commit IDs, PR links, or transaction hashes when relevant. Never infer a merge, deployment, or successful execution from a plan or an unverified message.
3. Separate pending work and blockers from completed work. State the next concrete action. Keep carry-over in today's entry rather than creating future-dated logs.
4. Do not rewrite other sessions' entries or duplicate outcomes already recorded. Append corrections that identify what changed. Re-read just before writing if another session may have appended.
5. Record successful external coverage per source with an explicit timestamp and timezone. Note partial or failed coverage separately. Do not advance a checkpoint for a source you did not fully check.
6. Read back the appended entry. Confirm that existing entries remain, evidence supports the claims, and no secrets were included. Do not stage, commit, or publish the log.

Use this layout and omit empty headings:

```markdown
# YYYY-MM-DD

## HH:MM timezone | Task

### Completed
- Verified outcome. Evidence.

### Decisions
- Decision and reason.

### Blockers
- Unresolved issue and what is needed.

### Next
- Concrete pending action.

### Source coverage
- Source and scope. Successfully checked through ISO-8601 timestamp.
- Unavailable or partial source. Reason and remaining gap.
```

Add the date heading only once. Omit `Source coverage` when no external sources were checked. For a read-only catch-up, do not append unless asked.

## Optional sources

No external sources are required. Known scopes for this repo:

- **Forge.** GitHub repository `giuseppecrj/pi-herdr-factorio`, through local `gh`: pull requests, issues, and Actions runs on `main`.
- **Decision trail.** `docs/decisions.tsv` in this checkout. It is the program's authoritative history, often with uncommitted rows. Read its newest rows for the requested period.

No issue-project or chat-channel scope is configured. If neither source is reachable, report local-only coverage. Do not borrow account names, channel IDs, addresses, or deployment assumptions from another repo.

## Verification

- Earlier facts cite logs. New facts cite inspected files, command results, or live sources.
- Missing access and incomplete pagination remain visible in the rundown.
- Logs are ignored and absent from `git ls-files -- .pi/daily-log`.
- Planned, attempted, completed, and verified work remain distinct.
- Reading or recording work never authorizes external mutations.
