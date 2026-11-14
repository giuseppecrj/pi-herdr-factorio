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

Two sources return the same projection. Both call `readOwnerFeed` in `host/cli/owner-feed.ts`, which reads the controller state and receipts and passes them to the projection in `src/views/feed.ts`. Neither makes a GitHub or model call.

```bash
node host/cli/index.ts owner-feed --json --state-dir "$STATE" [--repo <owner/name>]
curl http://127.0.0.1:<port>/owner-feed.json
```

| | CLI | Viewer route |
| --- | --- | --- |
| Code | `runOwnerFeedCli` in `host/cli/owner-feed.ts` | `host/viewer/server.ts:243` |
| Needs a running process | No | Yes, `node host/cli/index.ts viewer` |
| Output | Indented JSON, exit 0 | Compact JSON, `Cache-Control: no-store` |
| Refusal | Exit 2 with usage on stderr, for bad arguments and for any thrown error | By default, 403 unless `Host` is `127.0.0.1:<port>` or `localhost:<port>` and any `Origin` matches. A viewer started with `--allowed-host` also accepts that one host, with a matching `https://` `Origin` (`host/viewer/server.ts:101` to `host/viewer/server.ts:112`) |
| Median of 10 reads, development machine, 2026-11-10 | 278 ms | 3.7 ms |
| Median of 10 reads, `pi-factorio` VM, 2026-11-10 | 621.5 ms | Not measured |

The development-machine figures ran with Node 26.13.0 on the seven-run state that `ownerState` builds in `test/fixtures/owner-feed/state.ts`. The ten CLI reads took 321, 277, 279, 280, 277, 278, 278, 280, 278 and 278 ms, timed as wall clock around the whole command. A bare `node -e 0` takes 13 ms, so nearly all of the 278 ms is loading the CLI's modules. The ten route reads were `curl` totals against a viewer already running.

The VM figure comes from the independent verifier's run of ten CLI reads on the `pi-factorio` VM on 2026-11-10. Three more sets of ten had medians of 694, 696.5 and 728 ms. **Plan against the VM figure, not the development-machine one.** The VM reads about 2.2 times slower. Production state has more runs than the fixture. The F09c performance probe in `docs/plans/active/factory-v1.md` found feed work under its 500 ms limit on a copy of production state, and it excluded Node start-up from that limit.

**Recommendation.** Read the CLI when the private [feed-changed signal](#feed-changed-signal) changes, with periodic full reads as a safety net. It needs no second process. The viewer route helps when someone already runs a viewer.

**Allowed read rate (proposal).** The code enforces no rate. Read at most once every 5 seconds while the app is open and once every 60 seconds in the background. Keep one read in flight. On the VM, one CLI read takes about 620 ms of wall time, so one read every 5 seconds uses about 12% of each 5-second slot. One read every 60 seconds uses about 1%. The proposed rates still hold at that cost.

The bridge must run as the Unix user that owns the state directory. The feed checks private status files, admission snapshots, stage receipts and validation verdicts before reading them. It rejects symlinks, foreign owners and group or other permissions, including each directory below the state root. Admission snapshots still require a matching receipt and snapshot digest.

Two host probes deliberately keep different rules:

- The local switch checks that the state directory belongs to the user and is not group or other writable. Any `disabled` entry, including a dangling symlink or an entry owned by another user, disables admission. Its contents are never read.
- The controller lock uses `readLock` in `host/controller/state.ts`. It probes the controller socket and reads the holder file without the feed's private-file checks. It supplies only `running`, `stopped` or `unavailable`, never holder text.

A bridge running as another user usually gets an unavailable feed, not an error, because the state directory itself fails the check. These checks apply to feed reads, not a change to the admission or status CLI's storage policy.

### Feed-changed signal

`$STATE/feed-generation` is a separate private file, not an OwnerFeed field. OwnerFeed stays v1 and returns identical bytes whether this file exists or not. Production needs an upgrade approved by Giuseppe before the signal exists on `nubl-factory`. This change does not deploy it or update the Shep bridge.

The file contains 64 lowercase SHA-256 hexadecimal characters and one LF, exactly 65 bytes. Treat the value as opaque, not as a counter or a timestamp. The controller hashes its own `readOwnerFeed` projection, so feed-visible status, claims, admissions, intake markers, questions, ledger rows and terminal records all use the feed's existing readers. Metrics, stage receipts, validation, links, accounting, the local switch and controller state are covered too.

The hash excludes `at`, `entries[].ageMs` and `controller.lastTick`. These clock and heartbeat fields would otherwise change on every idle tick. Stale-threshold crossings and seven-day terminal expiry still change the hash. A routine `status.json` rewrite changes neither the value nor the file when the remaining projection is unchanged. No OwnerFeed fields or timestamp semantics change.

`serve` republishes the signal after every tick, status write and ledger pump, leaving the file unchanged when the digest matches. Time-driven changes, including the stale flag and seven-day retention, appear within about one poll interval, normally 30 seconds. `tick`, `run` and `cadence --once` refresh it on completion after releasing the controller lock, as does graceful shutdown. When no serve loop runs, only the bridge's required 60-second full read catches time-driven changes. A crash cannot publish its own stopped state. Slow ticks, out-of-band writes and background metric updates can delay publication. Worst-case bridge staleness is about 30 to 60 seconds instead of about 5 seconds with full polling.

The state directory and file must belong to the effective Unix user, with no group or other permissions. Neither may be a symlink. The writer creates a mode-0600 temporary file, syncs it and renames it atomically. It refuses an existing unsafe or malformed signal instead of replacing it and logs `feed_generation_unwritable`. The feed remains readable if publication fails. To recover from a refused unsafe or malformed signal, remove `$STATE/feed-generation`; the next tick rewrites it. Correct an unsafe state directory's ownership or permissions before retrying.

A resident bridge can import `readFeedGeneration` from `host/controller/feed-generation.ts` and call it with the state directory. It returns the digest without LF, or null when missing, unsafe or malformed. An independent reader must lstat the private state directory, open the file with `O_NOFOLLOW | O_NONBLOCK`, fstat that descriptor for a regular, owner-only 65-byte file, and validate `^[a-f0-9]{64}\n$`. It must read from that descriptor, not reopen the path after checking it. No CLI process is needed for this read.

The Shep bridge must:

1. Read the signal every few seconds, for example every 5 seconds, with one feed read in flight per state-directory and repository pair.
2. Run `owner-feed --json` on the first read and whenever the signal differs from the value accepted with the last successful feed read. Use the repository served by that state directory. The signal covers its default feed, not arbitrary `--repo` overrides.
3. Accept the signal sampled before that feed read only after the feed succeeds and is available. Keep the existing seed and push rules. A signal change alone never sends a push.
4. Run a full feed read at least every 60 seconds even if the signal stays unchanged. Continue full polling when the signal is missing, invalid or unreadable. Do not interpret those cases as unchanged or erase cached entries.

The periodic read catches crashes and missed publications and refreshes ages and heartbeat timestamps. It remains required after the bridge adopts the signal. Between full reads, the bridge must add elapsed time since the cached feed's `at` to each known `ageMs` for display. Keep unknown ages null.

On the development machine with Node 26.13.0 on 2026-11-14, the seven-run fixture measured a 0.047 ms median validated signal read over 1,000 reads, versus 317.4 ms for 10 full CLI reads. Unchanged signal publication took 4.04 ms median. Signal reads ran in a resident process; CLI reads included process and module startup. `node test/fixtures/owner-feed/measure-generation.ts` reproduces the measurement. These are local fixture results, not a measured production improvement or a replacement for the historical VM baseline.

### Read several repositories

The bridge runs `owner-feed --json --state-dir <dir> --repo <owner/name>` once per configured state-directory and repository pair. It merges entries using `repo` plus `issue`, not the issue number alone. Keep availability and notification history separate for each pair. An unavailable read must not erase another repository's entries.

`repositories` is the selected platform profile's admission allowlist. It is present even when `entries` is empty, so the bridge can distinguish an idle repository from one outside that allowlist. It is not a list of repositories whose state this read contains. `repo` still identifies the one repository projected by this invocation.

One controller still runs with one `serve --repo` and one state directory. A platform profile with several repositories allows choosing any one of them, but does not make that controller poll all of them. A single controller serving several repositories would need repository-scoped state and dispatch. That change is out of scope. Do not run competing controllers for the same repository.

### Detect an unavailable feed

An unreadable state directory is a successful read with no data. The CLI exits 0 and prints `entries: []` and `gaps: ["state_unavailable"]`. That happens when the directory is missing, is not private, has no `claims/` directory, or when no repository is known. The bridge must treat either gap as no information. It must not seed from it, and it must not treat the empty `entries` as "nothing needs the owner".

## Fields

`version` is the number `1`. The type is `OwnerFeed` in `src/views/feed.ts`. Every field below is always present. Nullable fields are `null`, never absent.

| Field | Type | Meaning |
| --- | --- | --- |
| `version` | `1` | The contract version. |
| `repo` | string or null | `owner/name` from `status.json` or `--repo`. |
| `repositories` | array of string | Admission allowlist from the selected platform profile, not the current issue or status text. |
| `at` | number | Read time, epoch milliseconds. `ageMs` counts from it. |
| `controller.state` | string | `running`, `stopped` or `unavailable`. |
| `controller.lastTick` | string or null | Timestamp of the last controller tick, from `status.json`. |
| `controller.localSwitch` | string | `enabled`, `disabled` (the hold is on) or `unavailable`. |
| `entries` | array | One entry per issue. Newest `since` first. Finished runs stay for 7 days. |
| `counts` | object | One number per attention kind, always all seven keys. |
| `workingRunCount` | number | Runs that are not finished and have no attention kind or have kind `question_answered`. Published refresh holds remain counted as `blocked`. |
| `durableUsage` | object | `kind` is `exact`, `lower_bound`, `uncertain` or `unavailable`. `total` is a number or null. |
| `unreadable` | array | `{issue, issueUrl, reason}` for issues whose run history is corrupt. These issues have no entry. |
| `gaps` | array of string | Codes for evidence the read could not use. |
| `metrics` | object | See the next table. |

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

An entry of type `FeedEntry` in `src/views/feed.ts` has these fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `issue` | number | The GitHub issue number. |
| `runId` | string | 64 hexadecimal characters. Changes with every admission event. |
| `eventId` | string | The admission event, as a decimal string, including unverified discoveries that have no claim file yet. |
| `intakeRef` | string or null | The strict intake marker from the digest-verified admission snapshot. |
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
| `questionsUrl` | string or null | The trusted controller questions comment when kind is `question_asked` and status is `needs_info`. Otherwise null. |
| `reason` | string or null | A code for why the run is held. |
| `round` | number or null | The repair round, from 0. |
| `tokens` | number or null | Tokens spent. |
| `cap` | number or null | The run's token cap. Null when unknown. |
| `ci` | string | `Passed`, `Failed` or `Pending`. |
| `failure` | object or null | `{stage, class, reason}` from the ledger. |
| `notProven` | array of string | Fixed sentences about what checks and review did not prove. |
| `steps` | array | One `FeedStep` per model stage that left a receipt. |

A `FeedStep` has these members.

| Member | Type | Meaning |
| --- | --- | --- |
| `stage` | string | `specify`, `accept`, `build` or `review`, matching the receipt directory's stage. Invalid or mismatched receipts are skipped. |
| `outcome` | string | The receipt's outcome kind, such as `passed`, `refused`, `failed` or `budget_exhausted`. |
| `wallMs` | number or null | Wall time of the stage, in milliseconds. |
| `tokens` | number or null | Tokens the stage used. |

### Intake marker

Shep writes `<!-- factory-intake: <id> -->` in the issue body. The ID has 8 to 64 ASCII letters, digits or hyphens. The marker must occupy its entire line, with exactly those spaces and delimiters. The parser accepts LF and CRLF line endings. Missing, malformed, inline or duplicate markers give `intakeRef: null`. Two marker openings, including a malformed second marker, also add `duplicate_intake_marker:<12-character run prefix>` to `gaps`.

The feed reads the body saved at admission and verifies its receipt and digest. It never reads the current GitHub body. An edit after the label cannot change the run's saved intake ID. An unverified discovery has `intakeRef: null`, even if an admission snapshot exists.

`intakeRef` is neither authenticated nor unique. Any issue author can copy a marker. Only the owner's label gates admission, not the marker. The parser matches lines, not Markdown structure, so a lone marker inside a code fence or a multi-line HTML comment is accepted.

Shep's bridge must retain `repositories` and `entries[].intakeRef`, correlate chats by the exact intake ID, and perform the per-pair reads above. It must handle the same `intakeRef` on several entries and keep their separate `repo` plus `issue` keys. These are additive v1 fields. Older readers may ignore them.

### Questions comment link

The controller records the questions comment reference from the authenticated POST response's comment ID. When recovering an existing keyed comment, it checks the controller login, bot type, app identity when present, repository and issue, exact run and questions digest key, and the matching unedited GraphQL comment record. Multiple matching comments or unavailable edit evidence produce no reference. The private `contracts/<runId>/questions-comment.json` receipt contains only the run, repository, issue, questions digest and comment ID.

The feed checks that receipt's private paths and bindings against `questions.json`, then constructs `https://github.com/<repo>/issues/<issue>#issuecomment-<id>`. It never uses a URL from issue text, comment text or a model reply. Reading the feed still makes no GitHub call. Old runs without this receipt, or runs whose reference could not be saved, have `questionsUrl: null`. This read-only change does not backfill historical comments or block clarification reporting when link evidence is unavailable.

Shep's bridge must retain `questionsUrl` and use it as the tap target for an entry waiting for an answer. Fall back to `issueUrl` when it is null. Other entries keep the existing `prUrl` then `issueUrl` target. `version` stays 1.

### Attention kinds and groups

The kinds are `question_asked`, `question_answered`, `spec_review`, `pr_review`, `blocked`, `budget` and `failed` in `ATTENTION_KINDS` in `src/views/attention.ts`. `spec_review` is never emitted. `readAttention` reports it as `not_enabled_in_v1` in `src/views/attention.ts`, so its count is always 0 and no capture exists for it.

`detail` in `src/views/feed.ts` derives `group` separately from `kind`. A finished run is `done`. A `failed` kind is `failed`. A run with no kind, a `question_answered` kind, or a published pull request being refreshed is `working`. Everything else is `needs_you`. `kind` and `group` differ in two places. `question_answered` has group `working`, because the factory continues on its own. A published pull request being refreshed keeps kind `blocked` and has group `working`, so `counts.blocked` can exceed the `needs_you` entries.

## Change rules

The adopted stability rule below governs feed changes. `version` is a literal `1` in `src/views/feed.ts`. The golden test compares the whole feed with `test/fixtures/owner-feed/feed-v1.json` using `deepEqual` (`test/src/views/feed.test.ts`, first test), so any added or removed field fails it until a person edits the fixture. That makes a change visible. The rule below says which changes are allowed.

The v1 stability rule is:

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

### v1 corrections (#731)

These corrections change existing values:

- `workingRunCount` includes `question_answered` runs.
- `counts.blocked` excludes stale holds superseded by a newer admission.
- Unverified hold entries retain their decimal `eventId` instead of `""`.
- `controller.lastTick` and `metrics.computedAt` can be null when their saved timestamps are invalid.
- `steps` can drop invalid entries, including receipts with a stage that does not match their directory.

They stay v1 as a pre-release correction because no released bridge reads the feed yet. The Shep bridge in shep#140 is unbuilt. Future changes follow the stability rule above.

## Identify a run

Key a run on `repo` and `issue`. Do not key on `runId`.

`runId` is a digest of the repository, the issue number and the admission event (`runIdOf`, `src/core/run.ts:58`, checked by `parseClaim` in `src/views/attention.ts`). A new admission event gives a new `runId` for the same issue. An owner's answer to a question starts one, and its `links/<runId>.json` file names the previous run. A later admission event also replaces a failed or budget-stopped run, as [Viewer](viewer.md) describes. `eventId` is that event as a decimal string.

The feed keeps one run per issue. When an issue has several claims, `readAttention` keeps the one with the greatest `eventId`, then the greatest sequence number in `src/views/attention.ts`. An older run disappears from `entries` when a newer one starts.

Use these keys:

- **Collapse key.** `repo` plus `issue`. One key per issue means a run that moves from `question_asked` to `question_answered`, or fails and restarts, replaces its earlier notification.
- **Change test.** Compare the decision fingerprint, the three fields `kind`, `runId` and `reason`, between two reads of the same key. `reason` carries the hold reason in `readAttention` in `src/views/attention.ts`. Two holds on one run, such as `disabled` and then `run_tokens`, keep the same `kind`, `group` and `runId` and differ only in `reason`. `test/src/views/feed.test.ts` has a case that changes only the `claim_unverified` reason of one run between two reads.
- **Tap target.** For `question_asked` with `status: "needs_info"`, use `questionsUrl` when present and fall back to `issueUrl`. For other entries, use `prUrl` when present and otherwise `issueUrl`. The attention CLI's text report still opens the issue for questions.

An issue in `unreadable` has no entry. Its key is still `repo` plus `issue`.

### Unverified discoveries

The feed compares admission event IDs numerically across claims and unverified discoveries, then emits only the newest entry for an issue. A stale `unverifiedClaims` record does not add another entry or increase `counts.blocked`. A newer unverified discovery replaces the earlier claim with a blocked entry and retains its decimal `eventId`.

Existing v1 clients need no change for #731. The bridge may remove its duplicate-entry workaround after every configured controller has this fix. Keep the stable key and decision fingerprint.

## Actions

The app is read-only. Every action opens GitHub through `issueUrl`, `prUrl` or `questionsUrl`. Shep R24 says the app never calls the factory, and this contract keeps that rule.

The factory has one non-GitHub owner action, the local hold.

- **The switch.** The file `$STATE/disabled` (`LOCAL_DISABLE_FILE`, `src/trust/policy.ts:66`). While it exists, the controller admits no new ticket. It does not cancel work, reset a budget or restart a finished run. The feed shows it as `controller.localSwitch: "disabled"` (`src/trust/admission.ts:524`).
- **The viewer's hold form.** `POST /hold` (`host/viewer/server.ts:118`) creates or removes that file. By default it needs the exact loopback `Host`, a matching `Origin`, a form content type, and a token that changes each time the viewer starts and appears only in the dashboard HTML. A viewer started with `--allowed-host` also accepts that one host, with a matching `https://` `Origin` (`host/viewer/server.ts:97` to `host/viewer/server.ts:108`). The form has two fields, `token` and `hold=on|off`.

The CLI has no hold command. A phone action that changes the hold, or does anything else besides opening GitHub, needs its own design first. [Viewer](viewer.md) has the hold form's guards.

## Text fields

`title` carries free text from outside the factory, bounded by `plainTitle`. `intakeRef` also comes from the issue body, but accepts only the strict ASCII identifier described above. No issue body or model-written prose appears in the feed.

| Field | Where the text comes from | Bound today |
| --- | --- | --- |
| `entries[].title` | The saved admission snapshot of the issue, written by the issue author. | `plainTitle` in `src/views/attention.ts` replaces control characters (code points below 32 and 127 to 159) and bidirectional marks with a space, then keeps the first 120 code points, which can be 480 UTF-8 bytes. It does not escape HTML, strip Markdown, or remove other invisible characters such as the zero-width space. It returns `Title unavailable` when the snapshot is missing. |
| `entries[].intakeRef` | The saved admission snapshot body. | 8 to 64 ASCII letters, digits or hyphens, or null. |
| `entries[].reason` | The controller. | A closed vocabulary. The `HandoffReason` values that `wireReason` checks (`src/candidate/codec.ts:653`), `candidate_book_unavailable`, `feedback_overflow`, `working_generation`, `claim_unverified:<why>[:<failure>]` and `feedback_unavailable:<reason>[:<failure>]`. Each part of the last two comes from a fixed list in `unverifiedHolds` and `feedbackHolds` in `src/views/attention.ts`. |
| `entries[].failure` | The ledger row or terminal record. | `stage` and `class` are fixed lists. `reason` must match `^[a-z][a-z0-9_]{0,63}$` (`src/ledger/schema.ts:456`, `src/ledger/schema.ts:636`). |
| `entries[].notProven` | Fixed sentences from `renderLimitation` (`src/candidate/handoff.ts:2710`), and one fallback sentence in `src/views/feed.ts`. | Criterion and scenario IDs appear only when they match `A<n>` or `S<n>`. A judgment outcome appears only as a value of `JUDGMENT_OUTCOMES` (`src/candidate/review.ts:74`). Criterion text, scenario text and review reasons never appear. |
| `gaps[]` | The controller. | Fixed codes (`unrecognized_claim`, `state_unavailable`), or a code with an issue number or a 12-character run prefix (`invalid_claim:<12 characters>`, `ambiguous_issue:<n>`, `candidate_book_unavailable:<12 characters>`, `invalid_link:<12 characters>`, `duplicate_intake_marker:<12 characters>`). |
| `unreadable[].reason` | The controller. | One constant sentence in `src/views/feed.ts`. |
| `entries[].steps[].stage` | A stage receipt the controller wrote. | A model stage name matching its directory. |
| `controller.lastTick`, `metrics.computedAt` | Files the controller wrote. | A UTC timestamp with seconds and optional three-digit milliseconds. Invalid text becomes null. |

Render every string in the feed as plain text. A client that shows `title` as Markdown or HTML will show markup from the issue.

## Push rule for the bridge

The bridge builds pushes from changes between two feed reads. The controller sends nothing. There are two kinds of push, the needs-you alert and a quieter failed alert. The owner decided on 2026-11-10 that the Factory tab sends both, the way Shep's Chats sends a separate "finished" alert.

- The first successful read seeds the bridge's state and sends no push of either kind.
- A needs-you alert fires only for a new owner decision. The feed marks an entry that waits on the owner with `group: "needs_you"` in `src/views/feed.ts`. A finished run has group `done` and never pushes.
- A failed alert fires when a run newly fails. The feed marks a failed run with `group: "failed"` in `src/views/feed.ts`. Shep sends it at a lower interruption level than a needs-you alert.
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
| `question_asked.json` | `needs_info`, group `needs_you`, and the questions-comment URL from a synthetic controller reference receipt. |
| `question_answered.json` | A run linked to an answered question, group `working`. |
| `pr_review.json` | A certified pull request waiting, `stale: true`, `ci: "Passed"`, and a `notProven` sentence. |
| `blocked.json` | A blocked run, `stale: true`. |
| `budget.json` | `budget_exhausted`. |
| `failed.json` | A failure with `failure.stage`, `class` and `reason`. |
| `working.json` | A running build with a step, a valid intake ID and a title that holds HTML and Markdown. |

There is no `spec_review` capture. `test/fixtures/owner-feed/feed-v1.json` is the older multi-run golden. Each capture holds one run, so a client sees one kind at a time.

To regenerate them, run the generator. It formats its own output with Biome, so a fresh run leaves `git diff --exit-code test/fixtures/owner-feed/captures` clean.

```bash
node --experimental-strip-types test/fixtures/owner-feed/capture.ts
```

`test/src/views/feed.test.ts` regenerates each capture in a temporary directory and fails when it differs from the file, when a capture is not a valid v1 feed, or when the set stops covering every kind except `spec_review`.
