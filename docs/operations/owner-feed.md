# OwnerFeed v1 contract

OwnerFeed is the read-only projection of the factory's local state that an owner client reads. The Factory tab in Shep v3 is that client (Shep R25, decided on [#719](https://github.com/nublai/pi-herdr-factorio/issues/719)). The Shep bridge on the factory VM reads the feed locally and sends every push. The controller never calls `apns.int` and never talks to a phone.

This page is the contract for that bridge. It answers the five questions Shep asked on #719 and lists every field. The fields come from `src/views/feed.ts` and `src/views/attention.ts`. Where the code states no rule, the page says so and labels the rule a **proposal**.

| Shep's question on #719 | Section |
| --- | --- |
| 1. How stable is v1? | [Change rules](#change-rules) |
| 2. Which source, and how often? | [Read the feed](#read-the-feed) |
| 3. What identifies a run? | [Identify a run](#identify-a-run) |
| 4. Which actions exist? | [Actions](#actions) |
| 5. Which fields carry text? | [Text fields](#text-fields) |

The push rule is in [Push rule for the bridge](#push-rule-for-the-bridge).

## Read the feed

Two sources return the same projection. Both call `readOwnerFeed` (`host/cli/owner-feed.ts:76`), which reads the controller state and receipts and passes them to the projection in `src/views/feed.ts`. Neither makes a GitHub or model call.

```bash
node host/cli/index.ts owner-feed --json --state-dir "$STATE" [--repo <owner/name>]
curl http://127.0.0.1:<port>/owner-feed.json
```

| | CLI | Viewer route |
| --- | --- | --- |
| Code | `host/cli/owner-feed.ts:19` | `host/viewer/server.ts:243` |
| Needs a running process | No | Yes, `node host/cli/index.ts viewer` |
| Output | Indented JSON, exit 0 | Compact JSON, `Cache-Control: no-store` |
| Refusal | Exit 2 with usage on stderr, for bad arguments and for any thrown error | By default, 403 unless `Host` is `127.0.0.1:<port>` or `localhost:<port>` and any `Origin` matches. A viewer started with `--allowed-host` also accepts that one host, with a matching `https://` `Origin` (`host/viewer/server.ts:101` to `host/viewer/server.ts:112`) |
| Median of 10 reads, development machine, 2026-11-10 | 278 ms | 3.7 ms |
| Median of 10 reads, `pi-factorio` VM, 2026-11-10 | 621.5 ms | Not measured |

The development-machine figures ran with Node 26.13.0 on the seven-run state that `ownerState` builds in `test/fixtures/owner-feed/state.ts`. The ten CLI reads took 321, 277, 279, 280, 277, 278, 278, 280, 278 and 278 ms, timed as wall clock around the whole command. A bare `node -e 0` takes 13 ms, so nearly all of the 278 ms is loading the CLI's modules. The ten route reads were `curl` totals against a viewer already running.

The VM figure comes from the independent verifier's run of ten CLI reads on the `pi-factorio` VM on 2026-11-10. Three more sets of ten had medians of 694, 696.5 and 728 ms. **Plan against the VM figure, not the development-machine one.** The VM reads about 2.2 times slower. Production state has more runs than the fixture. The F09c performance probe in `docs/plans/factory-v1.md` found feed work under its 500 ms limit on a copy of production state, and it excluded Node start-up from that limit.

**Recommendation.** Read the CLI. It needs no second process. On exmach the viewer stays on loopback, so the route only helps when someone already runs a viewer.

**Allowed read rate (proposal).** The code enforces no rate. Read at most once every 5 seconds while the app is open and once every 60 seconds in the background. Keep one read in flight. On the VM, one CLI read takes about 620 ms of wall time, so one read every 5 seconds uses about 12% of each 5-second slot. One read every 60 seconds uses about 1%. The proposed rates still hold at that cost.

The bridge must run as the Unix user that owns the state directory. Most of the feed's file reads ignore a file that is a symlink, is owned by another user, or is readable by group or others. Those readers are `localJson` (`src/views/feed.ts:102`, which checks every path part below the state directory) and `privatePath` and `privateJson` (`src/views/attention.ts:131` and `src/views/attention.ts:145`, which check the state directory, `claims/` and each file they open). These readers do not check:

- `status.json` through `readStatus` (`host/controller/state.ts:65`), which supplies the thresholds, the unreadable list and `controller.lastTick`. It follows symlinks and ignores owner and mode.
- The admission snapshot that supplies `title` (`src/trust/admission.ts:490` to `src/trust/admission.ts:513`). It uses a plain `readFile`.
- The local switch (`src/trust/admission.ts:524`). It checks that the state directory belongs to the user and is not group or other writable, and it does not check the `disabled` file's owner.
- The controller lock, which sets `controller.state`. `readOwnerHeader` in `host/cli/owner-feed.ts` reads it through `readLock` (`host/controller/state.ts:84`).
- The stored verdict (`readStoredVerdict`, `host/controller/state.ts:74`, through `regularBytes`, `src/contract/artifacts.ts:232`). It rejects a symlink and a group- or other-accessible file, and does not check the owner.

A bridge running as another user usually gets an unavailable feed, not an error, because the state directory itself fails the check. This PR does not harden the unchecked readers.

### Detect an unavailable feed

An unreadable state directory is a successful read with no data. The CLI exits 0 and prints `entries: []` and `gaps: ["state_unavailable"]`. That happens when the directory is missing, is not private, has no `claims/` directory, or when no repository is known. The bridge must treat either gap as no information. It must not seed from it, and it must not treat the empty `entries` as "nothing needs the owner".

## Fields

`version` is the number `1` (`src/views/feed.ts:55`). The type is `OwnerFeed` at `src/views/feed.ts:54`. Every field below is always present. Nullable fields are `null`, never absent.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | The contract version. |
| `repo` | string or null | `owner/name` from `status.json` or `--repo`. |
| `at` | number | Read time, epoch milliseconds. `ageMs` counts from it. |
| `controller.state` | string | `running`, `stopped` or `unavailable`. |
| `controller.lastTick` | string or null | Timestamp of the last controller tick, from `status.json`. |
| `controller.localSwitch` | string | `enabled`, `disabled` (the hold is on) or `unavailable`. |
| `entries` | array | One entry per issue. Newest `since` first. Finished runs stay for 7 days. |
| `counts` | object | One number per attention kind, always all seven keys. |
| `workingRunCount` | number | Runs that are not finished and have no attention kind. |
| `durableUsage` | object | `kind` is `exact`, `lower_bound`, `uncertain` or `unavailable`. `total` is a number or null. |
| `unreadable` | array | `{issue, issueUrl, reason}` for issues whose run history is corrupt. These issues have no entry. |
| `gaps` | array of string | Codes for evidence the read could not use. |
| `metrics` | object | See the next table (`src/views/feed.ts:72`). |

`metrics` has these members. When `status` is `Pending`, `share`, `numerator`, `denominator` and `tokensPerCleanLanding` are `null`.

| Member | Type | Meaning |
| --- | --- | --- |
| `computedAt` | string or null | When the saved metrics report was computed. |
| `stale` | boolean | The saved report is marked stale. |
| `status` | string | `Complete` or `Pending`. |
| `share` | number or null | The primary share, from 0 to 1. |
| `numerator` | number or null | The share's numerator. |
| `denominator` | number or null | The share's denominator. |
| `tokensPerCleanLanding` | number or null | Tokens per clean landing. |

An entry (`FeedEntry`, `src/views/feed.ts:43`) has these fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `issue` | number | The GitHub issue number. |
| `runId` | string | 64 hexadecimal characters. Changes with every admission event. |
| `eventId` | string | The admission event, as a decimal string. It is `""` on a hold-only entry. |
| `stage` | string | `admit`, `specify`, `accept`, `build`, `validate`, `review` or `land`. |
| `status` | string | The run's claim status, such as `running`, `needs_info`, `waiting`, `failed` or `landed`. |
| `kind` | string or null | The attention kind, or null when the run needs nobody. |
| `group` | string | `needs_you`, `failed`, `working` or `done`. |
| `terminal` | boolean | The run has finished. |
| `since` | number or null | When the current state began, epoch milliseconds. |
| `ageMs` | number or null | `at - since`. Null when `since` is null or later than `at`. |
| `stale` | boolean | A `pr_review` entry older than 3 days or a `blocked` entry older than 6 hours. `status.json` can set other thresholds. |
| `title` | string | The issue title, sanitized. See [Text fields](#text-fields). |
| `issueUrl` | string | The issue on GitHub. |
| `prUrl` | string or null | The published pull request. |
| `reason` | string or null | A code for why the run is held. |
| `round` | number or null | The repair round, from 0. |
| `tokens` | number or null | Tokens spent. |
| `cap` | number or null | The run's token cap. Null when unknown. |
| `ci` | string | `Passed`, `Failed` or `Pending`. |
| `failure` | object or null | `{stage, class, reason}` from the ledger. |
| `notProven` | array of string | Fixed sentences about what checks and review did not prove. |
| `steps` | array | One `FeedStep` (`src/views/feed.ts:34`) per model stage that left a receipt. |

A `FeedStep` has these members.

| Member | Type | Meaning |
| --- | --- | --- |
| `stage` | string | The stage the receipt names. |
| `outcome` | string | The receipt's outcome kind, such as `passed`, `refused`, `failed` or `budget_exhausted`. |
| `wallMs` | number or null | Wall time of the stage, in milliseconds. |
| `tokens` | number or null | Tokens the stage used. |

### Attention kinds and groups

The kinds are `question_asked`, `question_answered`, `spec_review`, `pr_review`, `blocked`, `budget` and `failed` (`src/views/attention.ts:33`). `spec_review` is never emitted. `readAttention` reports it as `not_enabled_in_v1` (`src/views/attention.ts:672`), so its count is always 0 and no capture exists for it.

`group` is derived separately from `kind` (`src/views/feed.ts:407`). A finished run is `done`. A `failed` kind is `failed`. A run with no kind, a `question_answered` kind, or a published pull request being refreshed is `working`. Everything else is `needs_you`. `kind` and `group` differ in two places. `question_answered` has group `working`, because the factory continues on its own. A published pull request being refreshed keeps kind `blocked` and has group `working`, so `counts.blocked` can exceed the `needs_you` entries.

## Change rules

The code states no rule for evolving the feed. `version` is a literal `1` (`src/views/feed.ts:55`). The golden test compares the whole feed with `test/fixtures/owner-feed/feed-v1.json` using `deepEqual` (`test/src/views/feed.test.ts`, first test), so any added or removed field fails it until a person edits the fixture. That makes a change visible. It does not say which changes are allowed.

**Proposal.** This rule matches how the feed is built today.

Within v1, a change may:

- Add a field to any object.
- Add a key to `counts`, a new attention kind with it.
- Add a value to a field with an open vocabulary: `status`, `stage`, `reason`, `failure.*`, `steps[].outcome`, `gaps[]`, `controller.state`, `controller.localSwitch`, `durableUsage.kind`, `ci`, `group` and `kind`.

`version` becomes 2 when a change would break a reader written for v1. That means a change that:

- Removes or renames a field.
- Changes a field's type or unit.
- Makes a field that is never null nullable.
- Changes what an existing value means.
- Changes the entry key described in [Identify a run](#identify-a-run).

No option emits two versions. A v2 replaces v1 on the CLI and the route, unless a flag is added first.

**Reader rules.** The reader ignores fields it does not know. It refuses a feed whose `version` is not 1 and shows a visible notice. It shows an unknown value in an open vocabulary as plain text and sends no push for an unknown `kind` or `group`. This confirms Shep's plan. The field is named `version`, not `v`.

`test/fixtures/owner-feed/contract.ts` encodes the v1 field list. A test fails when a field is removed or `version` changes, and passes when a field is added.

## Identify a run

Key a run on `repo` and `issue`. Do not key on `runId`.

`runId` is a digest of the repository, the issue number and the admission event (`runIdOf`, `src/core/run.ts:58`, checked at `src/views/attention.ts:173`). A new admission event gives a new `runId` for the same issue. An owner's answer to a question starts one, and its `links/<runId>.json` file names the previous run (`src/views/attention.ts:556`). A later admission event also replaces a failed or budget-stopped run, as [Viewer](viewer.md) describes. `eventId` is that event as a decimal string.

The feed keeps one run per issue. When an issue has several claims, `readAttention` keeps the one with the greatest `eventId`, then the greatest sequence number (`src/views/attention.ts:493` to `src/views/attention.ts:525`). An older run disappears from `entries` when a newer one starts.

Use these keys:

- **Collapse key.** `repo` plus `issue`. One key per issue means a run that moves from `question_asked` to `question_answered`, or fails and restarts, replaces its earlier notification.
- **Change test.** Compare the decision fingerprint, the three fields `kind`, `runId` and `reason`, between two reads of the same key. `reason` carries the hold reason (`src/views/attention.ts:632`). Two holds on one run, such as `disabled` and then `run_tokens`, keep the same `kind`, `group` and `runId` and differ only in `reason`. `test/src/views/feed.test.ts` has a case that changes only the `claim_unverified` reason of one run between two reads.
- **Tap target.** `prUrl` when it is not null, otherwise `issueUrl`. The CLI's text report picks the same way (`src/views/attention.ts:693`).

An issue in `unreadable` has no entry. Its key is still `repo` plus `issue`.

### Known limit, one issue can appear twice

Reproduced on 2026-11-10. An older run of an issue can still be listed in `status.json` under `unverifiedClaims`. When the issue also has a newer run, the feed has two entries for the issue. The second has `kind: "blocked"`, `eventId: ""`, `title: "Title unavailable"` and `reason: "claim_unverified:issue"`. It also adds one to `counts.blocked` (`src/views/attention.ts:655`, `src/views/feed.ts:572` to `src/views/feed.ts:594`). The bridge must apply the collapse key to both entries. The empty-`eventId` entry can be the newer run. `test/src/views/attention.test.ts:623` builds that case, where the held run has `eventId` 2 and the listed claim is its predecessor. The feed discards the hold's event id (`src/views/feed.ts:572` to `src/views/feed.ts:581`), so v1 cannot tell which of the two entries is newer. Do not select the latest run. Keep the attention signal instead. If either entry for a key has `group: "needs_you"`, the key needs the owner. Take the fingerprint of a key with two entries as the set of fingerprints of its `needs_you` entries. This is a product defect, reported and not fixed.

## Actions

The app is read-only. Every action opens GitHub through `issueUrl` or `prUrl`. Shep R24 says the app never calls the factory, and this contract keeps that rule.

The factory has one non-GitHub owner action, the local hold.

- **The switch.** The file `$STATE/disabled` (`LOCAL_DISABLE_FILE`, `src/trust/policy.ts:66`). While it exists, the controller admits no new ticket. It does not cancel work, reset a budget or restart a finished run. The feed shows it as `controller.localSwitch: "disabled"` (`src/trust/admission.ts:524`).
- **The viewer's hold form.** `POST /hold` (`host/viewer/server.ts:118`) creates or removes that file. By default it needs the exact loopback `Host`, a matching `Origin`, a form content type, and a token that changes each time the viewer starts and appears only in the dashboard HTML. A viewer started with `--allowed-host` also accepts that one host, with a matching `https://` `Origin` (`host/viewer/server.ts:97` to `host/viewer/server.ts:108`). The form has two fields, `token` and `hold=on|off`.

The CLI has no hold command. A phone action that changes the hold, or does anything else besides opening GitHub, needs its own design first. [Viewer](viewer.md) has the hold form's guards.

## Text fields

Only `title` carries free text from outside the factory, and `plainTitle` is its only bound. No other field in the feed carries issue, pull request or model-written text today.

| Field | Where the text comes from | Bound today |
| --- | --- | --- |
| `entries[].title` | The saved admission snapshot of the issue, written by the issue author. | `plainTitle` (`src/views/attention.ts:18`) replaces control characters (code points below 32 and 127 to 159) and bidirectional marks with a space, then keeps the first 120 code points, which can be 480 UTF-8 bytes. It does not escape HTML, strip Markdown, or remove other invisible characters such as the zero-width space. It returns `Title unavailable` when the snapshot is missing. |
| `entries[].reason` | The controller. | A closed vocabulary. The `HandoffReason` values that `wireReason` checks (`src/candidate/codec.ts:653`), `candidate_book_unavailable`, `feedback_overflow`, `working_generation`, `claim_unverified:<why>[:<failure>]` and `feedback_unavailable:<reason>[:<failure>]`. Each part of the last two comes from a fixed list (`src/views/attention.ts:368`, `src/views/attention.ts:426`). |
| `entries[].failure` | The ledger row or terminal record. | `stage` and `class` are fixed lists. `reason` must match `^[a-z][a-z0-9_]{0,63}$` (`src/ledger/schema.ts:456`, `src/ledger/schema.ts:636`). |
| `entries[].notProven` | Fixed sentences from `renderLimitation` (`src/candidate/handoff.ts:2710`), and one fallback sentence (`src/views/feed.ts:393`). | Criterion and scenario IDs appear only when they match `A<n>` or `S<n>`. A judgment outcome appears only as a value of `JUDGMENT_OUTCOMES` (`src/candidate/review.ts:74`). Criterion text, scenario text and review reasons never appear. |
| `gaps[]` | The controller. | Fixed codes (`unrecognized_claim`, `state_unavailable`), or a code with an issue number or a 12-character run prefix (`invalid_claim:<12 characters>`, `ambiguous_issue:<n>`, `candidate_book_unavailable:<12 characters>`, `invalid_link:<12 characters>`). |
| `unreadable[].reason` | The controller. | One constant sentence (`src/views/feed.ts:539`). |
| `entries[].steps[].stage` | A stage receipt the controller wrote. | Any string. The receipt's directory name is checked, the `stage` field inside it is not (`src/views/feed.ts:220`). |
| `controller.lastTick`, `metrics.computedAt` | Files the controller wrote. | Any string. |

Render every string in the feed as plain text. A client that shows `title` as Markdown or HTML will show markup from the issue.

## Push rule for the bridge

The bridge builds pushes from changes between two feed reads. The controller sends nothing. There are two kinds of push, the needs-you alert and a quieter failed alert. The owner decided on 2026-11-10 that the Factory tab sends both, the way Shep's Chats sends a separate "finished" alert.

- The first successful read seeds the bridge's state and sends no push of either kind.
- A needs-you alert fires only for a new owner decision. The feed marks an entry that waits on the owner with `group: "needs_you"` (`src/views/feed.ts:407`). A finished run has group `done` and never pushes.
- A failed alert fires when a run newly fails. The feed marks a failed run with `group: "failed"` (`src/views/feed.ts:407`). Shep sends it at a lower interruption level than a needs-you alert.
- Nothing pushes for a run the owner is viewing in the app.
- There is one collapse key per [stable key](#identify-a-run).
- The title is at most 64 bytes and the body at most 256 bytes. Both count UTF-8 bytes and are trimmed on a character boundary.
- Pushes go through Shep's one push sender.

**Proposal.** A decision is new when the key had no `needs_you` entry in the previous read, or one of its `needs_you` entries has a decision fingerprint (`kind`, `runId` and `reason`) that was not among the key's `needs_you` fingerprints in the previous read.

**Proposal for the failed alert.** A failure is new when one of the key's `failed` entries has a failure fingerprint that was not among the key's `failed` fingerprints in the previous read. The failure fingerprint is `runId` plus `failure.stage`, `failure.class` and `failure.reason`, where a null `failure` counts as one value. A run that fails, is admitted again and fails again has a new `runId`, so it alerts again. The same failed run seen on later reads does not.

Both alerts share the collapse key, `repo` plus `issue`. A newer alert for the key replaces the older one on the phone, whichever kind each is. For example, a needs-you alert replaces a failed alert after the owner's next decision is needed on that issue, and a failed alert replaces a needs-you alert when the run then fails.

An unavailable read, per [Detect an unavailable feed](#detect-an-unavailable-feed), changes no state and sends no push of either kind. The next available read compares against the last available read, so a `state_unavailable` gap never makes existing failures or decisions look new.

## Captures

`test/fixtures/owner-feed/captures/` holds one feed for each attention kind that can occur, and one for a run that is working. Each is the real `owner-feed --json` process reading synthetic fixture state with the clock fixed, so the files hold no real issue text, no state path and no home path.

| File | What it shows |
| --- | --- |
| `question_asked.json` | `needs_info`, group `needs_you`. |
| `question_answered.json` | A run linked to an answered question, group `working`. |
| `pr_review.json` | A certified pull request waiting, `stale: true`, `ci: "Passed"`, and a `notProven` sentence. |
| `blocked.json` | A blocked run, `stale: true`. |
| `budget.json` | `budget_exhausted`. |
| `failed.json` | A failure with `failure.stage`, `class` and `reason`. |
| `working.json` | A running build with a step and a title that holds HTML and Markdown. |

There is no `spec_review` capture. `test/fixtures/owner-feed/feed-v1.json` is the older multi-run golden. Each capture holds one run, so a client sees one kind at a time.

To regenerate them, run the generator. It formats its own output with Biome, so a fresh run leaves `git diff --exit-code test/fixtures/owner-feed/captures` clean.

```bash
node --experimental-strip-types test/fixtures/owner-feed/capture.ts
```

`test/src/views/feed.test.ts` regenerates each capture in a temporary directory and fails when it differs from the file, when a capture is not a valid v1 feed, or when the set stops covering every kind except `spec_review`.
