# Restart recovery through bot-authored run markers

This prototype answers the restart questions in the F04c section of `docs/plans/factory-v1.md` and risk R5. After a restart, can the controller rebuild its claims from marker comments on the issue? Can it trust only the comments it wrote, and tell when someone edited one? And what does a write look like when the controller cannot tell whether it landed?

It can, with one rule the controller must follow: a POST that fails without a definite HTTP 4xx answer may still have created the comment, so the controller reads the comments back before it posts again.

Probed on 2026-10-29 from `pi-factorio` through `GH_HOST=github.int.exe.xyz`, with gh 2.103.0. The owner's actions ran from the owner's workstation `gh`, with no `GH_HOST`. The probe is `probe.sh` in this directory. Run it with `.pi/skills/verify-factory/scripts/vm.sh docs/prototypes/restart-recovery/probe.sh <mode> [args]`. `vm.sh` checks its first two arguments as lane IDs, so every argument is a word or a number and the script builds the request text itself.

## Fixtures

| Issue | Opened by | Used for | State |
| [#65](https://github.com/giuseppecrj/pi-herdr-factorio/issues/65) | the integration bot | every probe below | closed as not planned |

## Results

| Question | Answer |
| (a) Which call returns the controller's own identity? | GraphQL `viewer { login }`. REST `user` and `app` are refused by the proxy. |
| (b) Can the integration post a marker, and what does a REST read show? | Yes. `user.login` is `exe-dev-github-integration[bot]`, `user.type` is `Bot`, and `performed_via_github_app.slug` is `exe-dev-github-integration`. |
| (c) What changes only on a body edit? | GraphQL `lastEditedAt`. REST `updated_at` also changes when a comment is hidden. Neither changes on a reaction. |
| (d) What does a timed-out or failed POST look like? | A POST killed after 200 ms printed nothing and exited 137, and the comment was still created. A 404 or 422 exits 1 with `(HTTP <code>)` in stderr and creates nothing. |

### (a) Identity

```text
gh api graphql -f query='query{viewer{login __typename}}'
{"data":{"viewer":{"login":"exe-dev-github-integration[bot]","__typename":"User"}}}

gh api user
/user names no repository; only /repos/OWNER/REPO/... is proxied (trace: ...)
gh: HTTP 403

gh api app
/app names no repository; only /repos/OWNER/REPO/... is proxied (trace: ...)
gh: HTTP 403

gh api repos/giuseppecrj/pi-herdr-factorio/installation
gh: A JSON web token could not be decoded (HTTP 401)
```

The GraphQL `viewer` keeps the `[bot]` suffix, unlike a comment's GraphQL `author.login`. Without `GH_HOST`, the VM's `gh` has no credentials and exits 4 with `To get started with GitHub CLI, please run: gh auth login`. On the owner's workstation the same query returns `giuseppecrj`. So the controller's identity check must compare the login exactly. A missing `GH_HOST` then fails the check on the VM and on the workstation.

### (b) A marker posted by the integration

```text
gh api --method POST repos/giuseppecrj/pi-herdr-factorio/issues/65/comments -f body='<!-- factory:run {"v":1,"probe":"..."} -->'
```

The POST response and a later `GET repos/{owner}/{repo}/issues/65/comments?per_page=100&page=1` both show:

```json
{
  "id": 6487472894,
  "issue_url": "https://api.github.com/repos/giuseppecrj/pi-herdr-factorio/issues/65",
  "created_at": "2026-10-29T03:55:55Z",
  "updated_at": "2026-10-29T03:55:55Z",
  "user": { "login": "exe-dev-github-integration[bot]", "type": "Bot" },
  "performed_via_github_app": { "id": 3061187, "slug": "exe-dev-github-integration", "owner": "boldsoftware" },
  "author_association": "NONE"
}
```

`issue_url` names `api.github.com`, not the integration host, and it ends with the issue the comment belongs to. A comment the owner posted from the workstation with the same marker text shows `"user": {"login": "giuseppecrj", "type": "User"}` and `"performed_via_github_app": null`. So the author fields tell a forged marker from a real one, and the marker text alone does not.

### (c) Edits, reactions and hiding

Each row is a read through the integration after one action on a bot comment.

| Action | By | REST `updated_at` | GraphQL `lastEditedAt` | GraphQL `userContentEdits.totalCount` |
| Post | bot, 03:55:55 | `03:55:55` | `null` | 0 |
| Add an `eyes` reaction | owner, 03:56:04 | `03:55:55`, unchanged | `null` | 0 |
| Edit the body | owner, 03:56:12 | `03:56:12` | `03:56:12` | 2 |
| Post a second comment | bot, 03:56:27 | `03:56:27` | `null` | 0 |
| Hide it as outdated (`minimizeComment`) | owner, 03:56:30 | `03:56:30` | `null` | 0 |

The owner can edit the bot's comment, and the comment keeps the bot as its author. So the author fields alone do not prove the marker is the text the controller wrote. `lastEditedAt` does: it is `null` until the body changes, and hiding or reacting leaves it `null`. `updated_at` moves on hiding too, so it would call a hidden marker edited.

The controller reads `lastEditedAt` for the bot comments that look like markers, in one request:

```graphql
query($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on IssueComment { databaseId lastEditedAt issue { number repository { nameWithOwner } } }
  }
}
```

`ids` are the REST `node_id` values, passed as `-f ids[]=<node_id>` for each one. The response returns the nodes in the same order, each with its `databaseId`, issue number and repository, so the controller can check every node against the REST comment it came from.

### (d) Failed and timed-out POSTs

| Request | Exit | Output | Comment created |
| POST to issue 999999999 | 1 | `gh: Not Found (HTTP 404)` | no |
| POST with no `body` field | 1 | `gh: Invalid request. ... (HTTP 422)` | no |
| POST with a 70000-character body | 0 | the comment JSON | yes, all 70000 characters |
| POST killed with `SIGKILL` after 200 ms | 137 | nothing on stdout or stderr | yes |
| POST killed after 450 ms | 137 | nothing | yes |
| POST given 600 ms | 0 | the comment JSON, after 546 ms | yes |

A successful POST took 450 to 700 ms. The two killed requests had already reached GitHub, and the read three seconds later found both comments. So a write that ends without an answer has an unknown outcome. The controller treats any failed POST without an HTTP 4xx status as unknown. It reads the issue's comments back before it posts again, and the marker's `runId` and `seq` say whether the earlier POST landed. GitHub accepted a body longer than its documented 65536-character limit through the integration, so the controller enforces its own 4 KiB cap on a marker instead of relying on GitHub.

The probe deleted the 70000-character comment and the three timed-out comments through the integration. `DELETE repos/{owner}/{repo}/issues/comments/{id}` returned exit 0 with no output.

## The trust rule

From these results, a marker comment is controller state only when all of these hold:

1. It came from `GET repos/{owner}/{repo}/issues/{n}/comments`.
2. `user.login` is exactly `exe-dev-github-integration[bot]` and `user.type` is `Bot`.
3. `performed_via_github_app` is `null` or has `slug` `exe-dev-github-integration`.
4. `issue_url` ends with `/repos/{owner}/{repo}/issues/{n}`, the issue it was read from.
5. GraphQL `lastEditedAt` for its `node_id` is `null`, and that node names the same `databaseId`, issue and repository.
6. Its body parses as a version 1 marker whose `repo`, `issue`, `runId` and `eventId` agree with each other and with the issue.

A comment from any other author is ignored. A bot comment that starts with the marker prefix and fails any other rule is corrupt, and the controller stops dispatching that issue.

## What this does not prove

- That the integration's own identity is stable across exe.dev releases. The controller checks it at every start.
- Behavior when the issue has more than 100 bot markers in a single `nodes` request. The controller asks for at most 100 node IDs per request.
- What a POST looks like when the proxy itself times out rather than the client. The controller handles both the same way.
