# Sourced locally by vm.sh and lane-setup.sh. Selects the verification VM
# named by FACTORY_VM (default pi-factorio) from ../targets.env and sets
# target_ssh and target_gh_host, or exits 2 before any ssh connection.
FACTORY_VM="${FACTORY_VM:-pi-factorio}"
target_found=""
target_ssh=""
target_gh_host=""
while read -r name ssh gh_host _; do
  [ "$name" = "$FACTORY_VM" ] || continue
  target_found=1
  target_ssh="${ssh:-}"
  target_gh_host="${gh_host:-}"
done < "$(dirname "${BASH_SOURCE[0]}")/../targets.env"
if [ -z "$target_found" ]; then
  printf 'unknown target %q (see targets.env)\n' "$FACTORY_VM" >&2
  exit 2
fi
if [ -z "$target_ssh" ] || [ -z "$target_gh_host" ]; then
  printf 'target %q not configured (see targets.env)\n' "$FACTORY_VM" >&2
  exit 2
fi
