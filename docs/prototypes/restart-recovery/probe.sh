#!/usr/bin/env bash
# Restart-recovery probe. Runs on pi-factorio through the GitHub integration.
# vm.sh checks its first two arguments as lane IDs, so every argument here is
# a word or a number and the script builds the request text itself.
# Usage: vm.sh probe.sh identity|create|post <issue>|read <issue>|nodes <issue>|fail <issue>|timeout <issue> <seconds>|close <issue>
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
R=giuseppecrj/pi-herdr-factorio
out=/tmp/f04c-probe.out
err=/tmp/f04c-probe.err
probe() {
  echo "### gh $*"
  local t0 rc
  t0=$(date +%s%N)
  gh "$@" </dev/null >"$out" 2>"$err"
  rc=$?
  head -c 3000 "$out"
  echo
  echo "exit=$rc ms=$(( ($(date +%s%N) - t0) / 1000000 )) stderr=$(head -c 400 "$err" | tr '\n' ' ')"
}
case "${1:-}" in
  identity)
    probe api graphql -f query='query{viewer{login __typename}}'
    probe api user
    probe api "repos/$R" --jq '{full_name, permissions}'
    probe api "repos/$R/installation"
    probe api app
    ;;
  identity-nohost)
    unset GH_HOST
    probe api graphql -f query='query{viewer{login}}'
    ;;
  create)
    probe api --method POST "repos/$R/issues" -f title="[F04c-proto] restart recovery markers" -f body="Fixture for F04c restart-recovery probes. Closed when the probe ends." --jq '{number, html_url, user: .user.login}'
    ;;
  post)
    probe api --method POST "repos/$R/issues/$2/comments" -f body="<!-- factory:run {\"v\":1,\"probe\":\"$(date -u +%FT%TZ)\"} -->" \
      --jq '{id, html_url, issue_url, created_at, updated_at, user: {login: .user.login, type: .user.type}, performed_via_github_app: (.performed_via_github_app | if . == null then null else {slug, id, owner: .owner.login} end), author_association}'
    ;;
  read)
    probe api "repos/$R/issues/$2/comments?per_page=100&page=1" \
      --jq '[.[] | {id, issue_url, created_at, updated_at, user: {login: .user.login, type: .user.type}, performed_via_github_app: (.performed_via_github_app | if . == null then null else {slug, id} end), reactions: .reactions.total_count, body_len: (.body | length)}]'
    probe api graphql -F owner=giuseppecrj -F name=pi-herdr-factorio -F number="$2" -f query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){comments(first:100){totalCount nodes{databaseId createdAt updatedAt lastEditedAt includesCreatedEdit author{login __typename} viaApp: viewerDidAuthor userContentEdits(first:10){totalCount nodes{editedAt}}}}}}}'
    ;;
  nodes)
    ids=$(gh api "repos/$R/issues/$2/comments?per_page=100&page=1" --jq '.[].node_id' </dev/null)
    args=()
    for id in $ids; do args+=(-f "ids[]=$id"); done
    probe api graphql "${args[@]}" -f query='query($ids:[ID!]!){nodes(ids:$ids){__typename ... on IssueComment{databaseId lastEditedAt url issue{number repository{nameWithOwner}}}}}'
    ;;
  fail)
    probe api --method POST "repos/$R/issues/999999999/comments" -f body="probe"
    probe api --method POST "repos/$R/issues/$2/comments" -f body="$(head -c 70000 /dev/zero | tr '\0' x)"
    probe api --method POST "repos/$R/issues/$2/comments"
    ;;
  timeout)
    echo "### timeout $3 gh api --method POST repos/$R/issues/$2/comments"
    t0=$(date +%s%N)
    timeout --signal=KILL "$3" gh api --method POST "repos/$R/issues/$2/comments" -f body="<!-- factory:probe timeout $(date -u +%FT%TZ) -->" </dev/null >"$out" 2>"$err"
    rc=$?
    echo "exit=$rc ms=$(( ($(date +%s%N) - t0) / 1000000 )) stdout_len=$(wc -c <"$out") stderr=$(head -c 400 "$err" | tr '\n' ' ')"
    sleep 3
    probe api "repos/$R/issues/$2/comments?per_page=100&page=1" --jq '[.[] | select(.body | startswith("<!-- factory:probe timeout")) | {id, created_at}]'
    ;;
  length)
    probe api "repos/$R/issues/comments/$2" --jq '.body | length'
    ;;
  delete)
    probe api --method DELETE "repos/$R/issues/comments/$2"
    ;;
  close)
    probe api --method PATCH "repos/$R/issues/$2" -f state=closed -f state_reason=not_planned --jq '{number, state}'
    ;;
  *)
    echo "usage: probe.sh identity|identity-nohost|create|post <issue>|read <issue>|nodes <issue>|fail <issue>|timeout <issue> <seconds>|length <comment>|delete <comment>|close <issue>" >&2
    exit 2
    ;;
esac
