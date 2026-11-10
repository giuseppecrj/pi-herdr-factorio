---
name: "project-status"
description: "Produce a read-only, evidence-based project snapshot of the goal, completed outcomes, current work, next steps and owner decisions. Use for project status, where are we, or a done/now/next summary across sessions. Not a chat-only catch-up or permission to resume work."
version: 1
created: "2026-10-31"
updated: "2026-10-31"
---
## When to use

Use when the user wants to understand where a project stands. Cover the project, not just the last few chat messages. Default to the current repository unless the user names another scope.

This is an on-demand report. Keep the existing delivery method and coordinator. Do not start another planning system, dashboard, task register or background monitor.

For a chat-only catch-up, use an installed chat catch-up skill instead. For a period such as yesterday or last week, use the project's existing daily-log procedure when available, then summarize the current position.

## Management principles

| Principle | Reporting rule |
|---|---|
| Management by objectives | Start with the intended user outcome. Report completed outcomes, not tool calls or effort spent. |
| Theory of constraints | Identify the main constraint on the next milestone and what it prevents. Do not turn every open item into a blocker. |
| Rolling-wave planning | Separate Done, Now and Next. Show only the next few justified steps, not a speculative full backlog. |
| Management by exception | Surface unresolved decisions, material risks and deviations. An accepted exception remains a disclosed limit, not a passed check or a new request to decide it again. |
| Single-point accountability | Name one accountable person or role for each next action and decision. If ownership is unknown, say unassigned. |
| Evidence-based reporting | Timestamp the snapshot. Distinguish observed facts, reported claims, proposals and unknowns. |

These principles shape the report. They do not replace the project's engineering or orchestration methodology.

## Gather the evidence

1. Read project instructions and their required entry points. Find the existing plan, decision trail, latest handoff and relevant recent logs. Follow the project's source order and privacy rules. Do not invent another status database.
2. Establish the approved goal, current milestone and latest grants. Current explicit owner decisions override older pending questions. A proposal is not an approval.
3. Read the newest relevant progress records. Use conversation or current-project session search only when needed to recover missing context. Do not scan unrelated projects or all session directories.
4. Check the actual delivery state of the relevant work through scoped read-only sources, such as local Git and current repository PR, CI or release reads. Read the service's state only when deployment is part of the question and access is already authorized. Do not infer deployment from a merge.
5. Keep collection proportional. Reuse valid evidence for unchanged revisions and query only changes since the latest reliable checkpoint. Do not rebuild, run tests, dispatch CI or wait for pending checks just to make a status report fresher. A pending check stays pending.
6. For ongoing agents or runs, use known launches, delivered results and an available authorized read-only status surface. Do not ask workers for updates, poll them, launch replacements or infer liveness from a file's modification time. Without current confirmation, say last recorded or unknown rather than running or stuck.
7. Resolve conflicting records before reporting. Delivery facts come from the actual artifact; intent and permission come from the owner and decision trail. A plan is not proof of completion, and a fresh narrative is not stronger than a verified artifact. State any disagreement you cannot resolve.

Use configured project sources only. Do not search email, chat, other repositories or issue trackers merely because an integration exists. If an expected source is unavailable, name the source and the resulting limit. Do not install tools, change accounts or request access that is unnecessary for the snapshot.

## Classify before summarizing

Keep execution state, evidence quality and authorization separate:

- Planned is not started. A report returned is not a design accepted. Code implemented is not verified. Verified is not merged. Merged does not prove deployed.
- An empty deployment list does not prove the code is undeployed; manual deployments may exist. Without authorized runtime evidence, say deployment unverified.
- A test passing does not prove an unrun live scenario. Owner acceptance of a verification exception permits the scoped action; it does not turn missing proof into a pass.
- A known future permission gate is not necessarily today's bottleneck. If the coordinator must first review a design, show that as the next action rather than asking the owner to approve an unfinished recommendation.
- A delivered worker report awaiting review is not an active worker. A phase awaiting owner approval is not a stalled coding task.
- Keep settled decisions settled. Show unresolved risks with their concrete effect, not a list of theoretical problems.

Use the project's actual milestone states. Do not invent a completion percentage, green health label, deadline or forecast. Counts are useful only when their scope is clear; completed milestone counts do not measure remaining effort.

## Write the snapshot

Default to 150 to 250 words. Use plain language and familiar milestone names. Each fact appears once. This is a brief, not a transcript of gathering it. Leave worker IDs, command transcripts and long hashes out unless needed to act. Do not fill sections with method commentary or empty reassurances.

Use this shape, omitting empty sections:

# <Project> snapshot

As of <date, time and timezone>. Scope <repository or named project>.

**Goal.** The outcome the project is meant to deliver.

**Position.** Current milestone and its confirmed state. Name the main constraint and its effect if there is one.

## Done

Up to two meaningful, verified outcomes. Fold accepted limits into the relevant outcome or Position, not a separate Done achievement. Preserve the distinction between merged code and verified deployment.

## Now

One or two bullets for actual work or an artifact awaiting review. If activity is unconfirmed, give its last recorded state and source age. Do not repeat the Position summary.

## Next

Up to three ordered actions with accountable roles. Separate approved next work from steps that first need a decision or permission. Mark proposals as proposals.

## Needs you

Only decision-ready calls that the user owns. Give the recommendation and its material tradeoff in enough detail to decide. If a question is not ready, say what the coordinator still needs to establish. If nothing is ready for the user, say so. Do not ask whether to keep going.

## Evidence and limits

One compact evidence line and any material unknown or unavailable source. Cite a few inspected links or paths, not the complete source inventory. Name delivery evidence limits that matter, not generic lists of tests this report did not rerun. Do not paste raw logs or private artifacts.

If there are many ready owner decisions, shorten history rather than hiding a decision to meet the word target. Expand milestone detail only when requested.

## Boundaries

Remain read-only. Do not edit project files or logs, update the plan, create tasks or PRs, post messages, merge, deploy, change settings, schedule work, launch agents or resume implementation. Do not treat a snapshot request as a new grant. Report the next action; do not perform it.

Do not expose secrets, raw sessions or unpublished test material. Link only sources actually inspected. For a local service, follow the project's approved remote-access link policy rather than inventing a localhost or public URL.

## Final check

Before replying, verify that Done contains outcomes rather than activity, Now does not contain finished workers, Next respects dependencies and grants, and Needs you contains no invented or already-settled decision. Check each completion claim against its source. Keep accepted limitations visible without calling them either passed or newly blocking. State material unverified claims and stale or unavailable evidence honestly. Do not confuse checks not rerun for this snapshot with checks that never passed.
