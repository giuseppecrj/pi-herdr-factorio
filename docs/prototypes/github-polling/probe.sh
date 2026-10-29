#!/usr/bin/env bash
# Read-only. Run on the VM with:
#   .pi/skills/verify-factory/scripts/vm.sh docs/prototypes/github-polling/probe.sh
set -uo pipefail
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
export GH_HOST=github.int.exe.xyz
R=giuseppecrj/pi-herdr-factorio
probe() {
  echo "### gh $*"
  gh "$@" </dev/null >/tmp/f04b-probe.out 2>/tmp/f04b-probe.err
  local rc=$?
  head -c 2000 /tmp/f04b-probe.out
  echo
  echo "exit=$rc stderr=$(head -c 300 /tmp/f04b-probe.err | tr '\n' ' ')"
}
query='query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){createdAt lastEditedAt includesCreatedEdit userContentEdits(first:100){totalCount nodes{editedAt deletedAt}}}}}'
for n in 14 15 16 17; do
  probe api "repos/$R/issues/$n/timeline?per_page=100&page=1" \
    --jq '[.[] | {event, id, actor: .actor.login, created_at, label: .label.name}]'
  probe api graphql -f query="$query" -F owner=giuseppecrj -F name=pi-herdr-factorio -F number="$n"
done
for page in 1 2 3; do
  probe api "repos/$R/issues/14/timeline?per_page=4&page=$page" --jq '[.[] | .id]'
done
probe api "repos/$R/collaborators/giuseppecrj/permission" --jq '{permission, login: .user.login}'
probe api "repos/$R/collaborators/exe-dev-github-integration%5Bbot%5D/permission" --jq '{permission, login: .user.login}'
probe api "repos/$R/actions/variables/FACTORY_ENABLED" --jq .value
probe api "repos/$R/issues/14/comments?per_page=100" --jq '[.[] | {id, login: .user.login, type: .user.type}]'
probe api "repositories/1437592670/issues/14/timeline?per_page=2&page=2"
probe api user
