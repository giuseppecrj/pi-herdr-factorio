# GitHub polling through the exe.dev integration

This prototype answers risk R2 in `docs/plans/factory-v1.md`: can the controller bind a `factory:ready` label event to its actor and to the issue body as it was at label time, using only repository-scoped `gh` through `GH_HOST=github.int.exe.xyz`?

It can. Label events carry their actor, ID and time. GraphQL reports when the body was last edited and returns every earlier body version. One endpoint the admission needs, the repository variable, is not readable through the integration, so admission on the VM fails closed until the owner changes that.

Probed on 2026-10-29 from `pi-factorio` as `exe-dev-github-integration[bot]`, with gh 2.103.0. The read-only probe is `probe.sh` in this directory. Run it with `.pi/skills/verify-factory/scripts/vm.sh docs/prototypes/github-polling/probe.sh`.

## Fixtures

All four were created by the integration bot, so their author has no write access.

| Issue | Setup | Used for |
| --- | --- | --- |
| [#14](https://github.com/giuseppecrj/pi-herdr-factorio/issues/14) | `giuseppecrj` added `factory:ready`. The bot then commented twice and added and removed `documentation` three times. | Unedited body, actor versus author, bot comments, pagination |
| [#15](https://github.com/giuseppecrj/pi-herdr-factorio/issues/15) | `giuseppecrj` added `factory:ready`. The bot then edited the body twice. | Edit after the label |
| [#16](https://github.com/giuseppecrj/pi-herdr-factorio/issues/16) | The bot edited the body, then `giuseppecrj` added `factory:ready`. | Edit before the label |
| [#17](https://github.com/giuseppecrj/pi-herdr-factorio/issues/17) | The bot added `factory:ready`. | Label actor without write access |

`giuseppecrj` applied labels from a workstation `gh`. Every read below went through the integration on the VM. The fixtures are closed at the end of the PR.

## Results

| Question | Endpoint | Result |
| --- | --- | --- |
| Label events with actor, ID and time | `GET repos/{owner}/{repo}/issues/{n}/timeline?per_page=100&page={p}` | Supported |
| Pagination | same, with explicit `page` | Supported. `gh api --paginate` must not be used. |
| Permission of the label actor | `GET repos/{owner}/{repo}/collaborators/{login}/permission` | Supported |
| Body edit time and history | `gh api graphql`, `Issue.lastEditedAt` and `Issue.userContentEdits` | Supported. REST has no body edit history. |
| Repository variable `FACTORY_ENABLED` | `GET repos/{owner}/{repo}/actions/variables/FACTORY_ENABLED` | Not supported: HTTP 403 |
| Repository label `factory:enabled` | `GET repos/{owner}/{repo}/labels/factory%3Aenabled` | Supported. HTTP 404 when absent. |
| Bot-authored comments | `GET repos/{owner}/{repo}/issues/{n}/comments` | Supported |
| Global endpoints | `GET user` | Not supported: HTTP 403 from the proxy |

### Label events

The timeline returns one entry per event, oldest first. A label event looks like this, trimmed to the fields the adapter reads:

```json
{
  "id": 34537521383,
  "event": "labeled",
  "actor": { "login": "giuseppecrj", "type": "User" },
  "created_at": "2026-10-29T01:21:37Z",
  "label": { "name": "factory:ready" }
}
```

`id` is a number below 2^53. `created_at` has one-second precision. Removing a label gives an `unlabeled` entry of the same shape. A comment entry has `event: "commented"` and carries the comment's `id`, which comes from a different numbering. The adapter keys a label event by its `id` and reads only `labeled` entries.

`repos/{owner}/{repo}/issues/{n}/events` returns the same label events without comments.

### Pagination

`Link` headers name `https://api.github.com/repositories/<repo-id>/...`, not the integration host:

```text
Link: <https://api.github.com/repositories/1437592670/issues/14/timeline?per_page=2&page=2>; rel="next", ...
```

`gh api --paginate` follows that URL as written. With `GH_DEBUG=api`, the second and later requests go to `https://api.github.com/` and leave the integration. They succeeded only because this repository is public. Asking the integration for a `/repositories/<id>/...` path fails:

```text
/repositories/1437592670/issues/14/timeline names no repository; only /repos/OWNER/REPO/... is proxied (trace: ...)
gh: HTTP 403
```

So the adapter never passes `--paginate`. It requests `page=1`, `page=2` and so on under `repos/{owner}/{repo}/...` and stops at the first page with fewer than `per_page` entries. A page past the end returns `[]`. With `per_page=4`, issue 14's nine events came back as 4, 4 and 1, the same nine IDs `--paginate` returned.

### Permission

```json
{ "permission": "admin", "role_name": "admin", "user": { "login": "giuseppecrj" } }
```

`permission` is one of `admin`, `write`, `read` and `none`. GitHub folds `maintain` into `write` and `triage` into `read` in this field. A user with no access gets `read` on this public repository, as `octocat` did. The integration bot, which applied the label on #17, gets `none`:

```json
{ "permission": "none", "role_name": "", "user": { "login": "exe-dev-github-integration[bot]", "type": "Bot" } }
```

The bot's login must be URL-encoded in the path, as `exe-dev-github-integration%5Bbot%5D`. A login that is not a user returns HTTP 404 with `<login> is not a user`.

### Body edits

This query returns the current body and its history in one response:

```graphql
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      title body createdAt lastEditedAt includesCreatedEdit
      userContentEdits(first: 100) {
        totalCount
        nodes { editedAt deletedAt diff }
      }
    }
  }
}
```

Pass the values as `-F owner=... -F name=... -F number=...`. Never put them in the query text.

For #14, never edited, `lastEditedAt` is `null`, `includesCreatedEdit` is `false` and `userContentEdits` is empty.

For #15, edited twice after the label at `01:21:38Z`:

```json
{
  "createdAt": "2026-10-29T01:21:21Z",
  "lastEditedAt": "2026-10-29T01:21:47Z",
  "includesCreatedEdit": true,
  "body": "<version 3>",
  "userContentEdits": {
    "totalCount": 3,
    "nodes": [
      { "editedAt": "2026-10-29T01:21:47Z", "deletedAt": null, "diff": "<version 3>" },
      { "editedAt": "2026-10-29T01:21:44Z", "deletedAt": null, "diff": "<version 2>" },
      { "editedAt": "2026-10-29T01:21:21Z", "deletedAt": null, "diff": "<version 1>" }
    ]
  }
}
```

Nodes come newest first. Despite its name, `diff` holds the full body of that version, and the newest `diff` equals `body`. The oldest node is the body at creation, with `editedAt` equal to `createdAt`. History appears only after the first edit, which is when GitHub records the original.

For #16, edited before the label at `01:21:39Z`, `lastEditedAt` is `01:21:31Z`. The current body is the label-time body.

Title changes are not in `userContentEdits`. They appear on the timeline as `renamed` events with `rename.from` and `rename.to`.

The adapter reads title renames in the same GraphQL response as the title and body, so a rename between two reads cannot pass unseen. It adds this field to the issue in the query above:

```graphql
renames: timelineItems(itemTypes: [RENAMED_TITLE_EVENT], last: 100) {
  totalCount
  nodes { ... on RenamedTitleEvent { createdAt previousTitle currentTitle } }
}
```

Re-probed on 2026-10-29 through the integration with the extended query. #14 and #15 return `renames` with `totalCount: 0` and no nodes. #26, renamed once, returns:

```json
{
  "totalCount": 1,
  "nodes": [
    { "createdAt": "2026-10-29T02:14:58Z", "previousTitle": "<24 characters>", "currentTitle": "<32 characters>" }
  ]
}
```

`currentTitle` is the title after that rename. `createdAt` has one-second precision.

### Repository variable

```text
GET repos/giuseppecrj/pi-herdr-factorio/actions/variables/FACTORY_ENABLED
HTTP/2.0 403 Forbidden
X-Accepted-Github-Permissions: actions_variables=read
{"message":"Resource not accessible by integration", ...}
```

The list endpoint and `gh variable get` fail the same way. The integration's GitHub App lacks the `actions_variables=read` permission. `gh variable list` from the owner's workstation also shows that the variable is not set. A re-probe on 2026-10-29 still returned 403.

### Repository label

Because the variable is unreadable, the owner made the repository switch the existence of a label named exactly `factory:enabled` on 2026-10-29. The integration can read labels:

```text
GET repos/giuseppecrj/pi-herdr-factorio/labels/factory%3Aenabled
{"message":"Not Found","documentation_url":"https://docs.github.com/rest/issues/labels#get-a-label","status":"404"}
gh: Not Found (HTTP 404)
```

That is the shape when the label is absent. A raw `:` in the path works the same as `%3A`. When the label exists, the call returns the label object with `id`, `name`, `color`, `default` and `description`.

The lookup is case-insensitive. `GET repos/giuseppecrj/pi-herdr-factorio/labels/FACTORY:READY` returns `"name":"factory:ready"`, the stored name. So the adapter compares the returned `name` with `factory:enabled` exactly, and a label stored with another case counts as off.

### Comments

```json
{
  "id": 6485238589,
  "user": { "login": "exe-dev-github-integration[bot]", "type": "Bot" },
  "performed_via_github_app": { "slug": "exe-dev-github-integration" },
  "author_association": "NONE",
  "created_at": "2026-10-29T01:21:48Z"
}
```

`user.login` and `performed_via_github_app.slug` identify the integration. The GraphQL `editor.login` drops the `[bot]` suffix, so compare logins only within one API.

### Errors

| Request | Result |
| --- | --- |
| A missing issue, REST | HTTP 404, `gh: Not Found (HTTP 404)` |
| A missing issue, GraphQL | Exit 1, `errors[0].type` is `NOT_FOUND`, and `data.repository.issue` is `null`. No HTTP status in stderr. |
| An issue that is a PR | `GET repos/{owner}/{repo}/issues/4` succeeds with a `pull_request` key. |
| `gh api user` | `/user names no repository; only /repos/OWNER/REPO/... is proxied`, then `gh: HTTP 403` |
| GraphQL `viewer { login }` | `exe-dev-github-integration[bot]` |

## The snapshot rule

From these results, admission binds a `factory:ready` label event at time `L` to a body as follows:

1. If `lastEditedAt` is `null` or earlier than `L`, the current body is the label-time body, unless `userContentEdits` contradicts it: a node with `editedAt` at or after `L` or after `lastEditedAt`, or, with `lastEditedAt` `null`, any node other than the original.
2. Otherwise, use `userContentEdits` only when all of these hold. `totalCount` equals the number of nodes returned, `includesCreatedEdit` is `true`, the newest node's `diff` equals the current body and its `editedAt` equals `lastEditedAt`, no node has `editedAt` equal to `L`, and exactly one node has the latest `editedAt` earlier than `L`, with a `diff` and no `deletedAt`. That node's `diff` is the label-time body.
3. Any other case is `ambiguous_snapshot`, and admission refuses.

Timestamps have one-second precision, so an edit in the same second as the label is ambiguous. The title is part of the snapshot. A `renamed` event at or after `L`, on the timeline or in the GraphQL `renames`, also gives `ambiguous_snapshot`, as does a GraphQL title that differs from the REST title or a `renames.totalCount` above the returned nodes.

## What this does not prove

- That the integration can read `FACTORY_ENABLED`. It cannot, so the repository switch is the `factory:enabled` label instead.
- Behavior for a label actor with triage but no write access. No such identity was available. Plan lane 2 stays blocked until one is granted.
- Behavior on a private repository, where `--paginate` would fail rather than leave the integration.
- GraphQL behavior for repositories outside the installation. `issue(number: 1)` on `octocat/Hello-World` returned `NOT_FOUND`.
