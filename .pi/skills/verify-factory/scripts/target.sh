# Sourced locally by vm.sh and lane-setup.sh. Selects the verification VM
# named explicitly by FACTORY_VM from ../targets.env and
# sets target_ssh and target_gh_host, or exits 2 before any ssh connection.
FACTORY_VM="${FACTORY_VM-}"
target_refuse() {
  printf '%s (see targets.env)\n' "$1" >&2
  exit 2
}
case "$FACTORY_VM" in
  '' | *[!A-Za-z0-9._-]*) target_refuse "$(printf 'invalid target name %q' "$FACTORY_VM")" ;;
esac
target_file="$(dirname "${BASH_SOURCE[0]}")/../targets.env"
[ -r "$target_file" ] || target_refuse "cannot read $target_file"
target_found=0
target_ssh=""
target_gh_host=""
while read -r name ssh gh_host extra; do
  case "$name" in '' | '#'*) continue ;; esac
  [ "$name" = "$FACTORY_VM" ] || continue
  target_found=$((target_found + 1))
  [ -z "$extra" ] || target_refuse "target $FACTORY_VM has extra fields"
  target_ssh="$ssh"
  target_gh_host="$gh_host"
done < "$target_file"
[ "$target_found" -ne 0 ] || target_refuse "unknown target $FACTORY_VM"
[ "$target_found" -eq 1 ] || target_refuse "target $FACTORY_VM is listed $target_found times"
if [ -z "$target_ssh" ] || [ -z "$target_gh_host" ]; then
  target_refuse "target $FACTORY_VM not configured"
fi
case "$target_ssh" in
  -* | *[!A-Za-z0-9@._-]*) target_refuse "target $FACTORY_VM has an invalid ssh destination" ;;
esac
case "$target_gh_host" in
  -* | *[!A-Za-z0-9._-]*) target_refuse "target $FACTORY_VM has an invalid GH_HOST" ;;
esac
