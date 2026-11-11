#!/usr/bin/env bash
# Run as exedev. --check makes only read-only probes; never provisions or starts a unit.
set -euo pipefail

refuse() {
  printf 'install-exe-dev: REFUSE %s\nfix: %s\n' "$1" "$2" >&2
  return 1
}

validate_commit() {
  [[ "$1" =~ ^[0-9a-f]{40}$ ]] || refuse commit_sha 'Pass a full lowercase 40-character commit SHA, not a branch, tag or short SHA.'
}

verify_head() {
  local actual
  actual=$(git -C "$1" rev-parse HEAD) || return 1
  [ "$actual" = "$2" ] || refuse checkout_sha 'Stop here; fetch the requested full commit and verify git rev-parse HEAD before retrying.'
}

preflight() {
  local tool package address state limit version available inodes
  for tool in sudo:sudo curl:curl git:git gh:gh jq:jq bwrap:bubblewrap unshare:util-linux systemctl:systemd loginctl:libpam-systemd systemd-notify:systemd getent:libc-bin df:coreutils awk:gawk timeout:coreutils flock:util-linux sysctl:procps tar:tar xz:xz-utils sha256sum:coreutils; do
    package=${tool#*:}; tool=${tool%%:*}
    command -v "$tool" >/dev/null || { refuse "package_$tool" "sudo apt-get update && sudo apt-get install -y $package"; return 1; }
  done
  [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { refuse architecture 'Use an x86_64 Linux exe.dev VM (boldsoftware/exeuntu).'; return 1; }
  for address in github.int.exe.xyz llm.int.exe.xyz; do
    getent ahostsv4 "$address" | awk '$1 == "169.254.169.254" { found=1 } END { exit !found }' || { refuse exe_dev_vm "Run on the exe.dev VM: ssh exedev@$vm.exe.xyz (integration DNS must resolve to 169.254.169.254)."; return 1; }
  done
  [ "$(id -u)" = 1000 ] && [ "$(id -un)" = exedev ] && [ "$HOME" = /home/exedev ] || { refuse user "Run as the normal VM user: ssh exedev@$vm.exe.xyz (not sudo bash)."; return 1; }
  sudo -n -l -- /usr/bin/loginctl enable-linger exedev >/dev/null 2>&1 || { refuse sudo 'Give exedev passwordless sudo through the VM administrator; then rerun as exedev.'; return 1; }
  [ "${FACTORY_PLATFORM:-exe-dev}" = exe-dev ] && [ ! -e /etc/factory/platform.json ] || { refuse platform 'Use a VM with FACTORY_PLATFORM unset and no /etc/factory/platform.json; do not overwrite another platform installation.'; return 1; }
  version=$(bwrap --version)
  [[ "$version" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] && (( BASH_REMATCH[1] > 0 || BASH_REMATCH[2] >= 9 )) || { refuse bwrap_version 'sudo apt-get update && sudo apt-get install -y bubblewrap (version >= 0.9.0 required).'; return 1; }
  limit=$(sysctl -n user.max_user_namespaces 2>/dev/null) || limit=0
  [[ "$limit" =~ ^[0-9]+$ ]] && [ "$limit" -gt 0 ] && unshare --user --map-root-user true >/dev/null 2>&1 || { refuse user_namespaces 'sudo sysctl -w user.max_user_namespaces=15000; if unshare still fails, have the VM administrator allow unprivileged user namespaces (including AppArmor policy).'; return 1; }
  bwrap --unshare-user --unshare-pid --unshare-net --die-with-parent --ro-bind / / --proc /proc --dev /dev true >/dev/null 2>&1 || { refuse bwrap_smoke 'sudo apt-get install --reinstall bubblewrap; have the VM administrator allow the bubblewrap AppArmor userns profile, then retry bwrap --unshare-user --ro-bind / / true.'; return 1; }
  state=$(systemctl show --property=SystemState --value 2>/dev/null) || state=unavailable
  case "$state" in running|degraded) ;; *) refuse systemd 'Boot boldsoftware/exeuntu with systemd as PID 1; sudo systemctl status.'; return 1;; esac
  loginctl list-users --no-legend >/dev/null 2>&1 || { refuse linger 'sudo apt-get install -y libpam-systemd; sudo systemctl start systemd-logind; sudo loginctl enable-linger exedev.'; return 1; }
  # Neither probe sends a credential or invokes a model; never echo a remote error body.
  curl --noproxy '*' --connect-timeout 10 --max-time 30 -fsS "https://github.int.exe.xyz/api/v3/repos/$repo" 2>/dev/null | jq -e --arg repo "$repo" '.full_name == $repo' >/dev/null 2>&1 || { refuse github_integration "On your computer: ssh exe.dev integrations add github --name nubl-factory-repo --repository $repo --attach vm:$vm"; return 1; }
  curl --noproxy '*' --connect-timeout 10 --max-time 30 -fsS https://llm.int.exe.xyz/openai/v1/models 2>/dev/null | jq -e '.data | type == "array" and length > 0' >/dev/null 2>&1 || { refuse model_route "On your computer: ssh exe.dev integrations attach llm vm:$vm (use the existing llm integration; no model request was sent)."; return 1; }
  for address in "$HOME" /var/lib /tmp; do
    available=$(df -Pk "$address" | awk 'NR == 2 { print $4 }')
    inodes=$(df -Pi "$address" | awk 'NR == 2 { print $4 }')
    [[ "$available" =~ ^[0-9]+$ && "$inodes" =~ ^[0-9]+$ ]] && [ "$available" -ge 4194304 ] && [ "$inodes" -ge 100000 ] || { refuse disk 'Free at least 4 GiB and 100000 inodes on the filesystems holding /home/exedev, /var/lib and /tmp, or enlarge the VM disk; then rerun.'; return 1; }
  done
  printf 'install-exe-dev: preflight=ok repo=%s vm=%s (no model calls, no configuration changes)\n' "$repo" "$vm"
  if [ -f "$HOME/factory-state/disabled" ]; then
    printf 'install-exe-dev: existing_hold=present (unchanged)\n'
  fi
}

render_unit() {
  local line
  while IFS= read -r line; do
    case "$line" in
      ExecStart=*) printf 'ExecStart=/home/exedev/.local/share/mise/shims/node server/cli.ts serve --repo %s --state-dir /home/exedev/factory-state\n' "$repo";;
      *) printf '%s\n' "$line";;
    esac
  done <"$1/server/factory.service"
}

held_status() {
  local status
  status=$(timeout 120 node "$checkout/server/cli.ts" status --json --repo "$repo" --state-dir "$state_dir") || { refuse status 'Keep the hold. Inspect sudo journalctl -u factory.service -n 100 --no-pager and rerun the installer.'; return 1; }
  printf '%s\n' "$status" | jq -e '.controller.state == "running" and .controller.lastTick.dispatch.enabled == false and (.controller.lastTick.dispatch.reasons | index("locally_disabled") != null)' >/dev/null || { refuse hold_unconfirmed 'Keep factory-state/disabled in place; inspect the journal and wait for a fresh controller status before retrying.'; return 1; }
  printf '%s\n' "$status" | jq '{dispatch: .controller.lastTick.dispatch}'
}

ensure_hold() {
  local state_dir=$1
  [ ! -L "$state_dir" ] && { [ ! -e "$state_dir" ] || { [ -d "$state_dir" ] && [ "$(stat -c %u "$state_dir")" = "$(id -u)" ]; }; } || { refuse state_directory 'Use a real, exedev-owned /home/exedev/factory-state directory, not a symlink.'; return 1; }
  if [ ! -d "$state_dir" ]; then install -d -m 0700 "$state_dir"; fi
  [ "$(stat -c %a "$state_dir")" = 700 ] || { refuse state_permissions 'chmod 0700 /home/exedev/factory-state, then retry.'; return 1; }
  # Any entry named disabled holds dispatch, including a directory or dangling symlink.
  [ -e "$state_dir/disabled" ] || [ -L "$state_dir/disabled" ] || (umask 077; touch "$state_dir/disabled")
}

install_controller() {
  local checkout="$HOME/pi-herdr-factorio" state_dir="$HOME/factory-state" receipt unit_file invocation
  if [ -e "$checkout" ] || [ -L "$checkout" ]; then
    [ ! -L "$checkout" ] || { refuse checkout_symlink 'Use a real /home/exedev/pi-herdr-factorio checkout, not a symlink.'; return 1; }
    [ -d "$checkout/.git" ] && [ -z "$(git -C "$checkout" status --porcelain)" ] || { refuse checkout_dirty 'Preserve local work, then provide a clean /home/exedev/pi-herdr-factorio checkout; the installer never resets local edits.'; return 1; }
    [ "$(git -C "$checkout" remote get-url origin)" = "https://github.int.exe.xyz/$repo.git" ] || { refuse checkout_origin 'Use a separate clean VM or correct the checkout origin to the selected repository through github.int.exe.xyz after preserving existing work.'; return 1; }
  fi
  # Hold before any stop, checkout change, provisioning, enable or restart. Never remove it.
  ensure_hold "$state_dir"
  exec 9>>"$state_dir/install-exe-dev.lock"
  flock -n 9 || { refuse install_busy 'Wait for the other installer to finish before retrying.'; return 1; }
  receipt="$state_dir/install-exe-dev.commit"
  if [ -f "$receipt" ] && [ "$(<"$receipt")" = "$commit $repo" ] && verify_head "$checkout" "$commit" && sudo systemctl is-active --quiet factory.service && render_unit "$checkout" | cmp -s - /etc/systemd/system/factory.service; then
    printf 'install-exe-dev: already_installed=%s (hold retained)\n' "$commit"
    held_status
    return
  fi
  sudo systemctl stop factory.service >/dev/null 2>&1 || { [ "$(systemctl show factory.service -p LoadState --value)" = not-found ] || { refuse service_stop 'sudo systemctl stop factory.service; resolve the stop failure before upgrading.'; return 1; }; }
  if [ ! -d "$checkout/.git" ]; then
    git -c credential.helper= -c http.extraHeader= clone --quiet --no-checkout --depth 1 "https://github.int.exe.xyz/$repo.git" "$checkout" >/dev/null 2>&1 || { refuse clone 'Confirm the GitHub integration attachment and repository access, then retry.'; return 1; }
  fi
  git -C "$checkout" -c credential.helper= -c http.extraHeader= fetch --quiet --depth 1 origin "$commit" >/dev/null 2>&1 || { refuse fetch_commit 'Publish the requested full commit in the selected repository, then retry with that SHA.'; return 1; }
  [ "$(git -C "$checkout" rev-parse FETCH_HEAD)" = "$commit" ] || { refuse fetched_sha 'Do not continue: the integration did not return the requested commit.'; return 1; }
  git -C "$checkout" checkout --quiet --detach "$commit"
  verify_head "$checkout" "$commit"
  # provision.sh installs Node and missing dependencies on a fresh VM. Drop only the
  # generated dependency tree on upgrades so it cannot retain the previous lockfile.
  if [ -d "$checkout/node_modules" ]; then rm -rf "$checkout/node_modules"; fi
  bash "$checkout/server/provision.sh"
  # Refuse a revision that has not incorporated the repository rename/profile allowlist.
  node "$checkout/server/cli.ts" status --json --repo "$repo" --state-dir "$state_dir" | jq -e --arg repo "$repo" '.platform.repositories | index($repo) != null' >/dev/null || { refuse repository_profile 'Use a commit whose platform repository allowlist includes the selected repository; keep the hold and do not start this controller.'; return 1; }
  unit_file=$(mktemp)
  render_unit "$checkout" >"$unit_file"
  sudo install -m 0644 "$unit_file" /etc/systemd/system/factory.service
  rm "$unit_file"
  sudo systemctl daemon-reload
  sudo systemctl enable factory.service
  # Type=notify waits for READY=1. Bind the journal check to this start, not an old log.
  sudo systemctl restart factory.service
  invocation=$(systemctl show factory.service -p InvocationID --value)
  [ -n "$invocation" ] && sudo journalctl -u factory.service "_SYSTEMD_INVOCATION_ID=$invocation" --no-pager -o cat | grep -q 'event=controller_ready' || { refuse controller_ready 'Keep the hold; inspect sudo journalctl -u factory.service -n 100 --no-pager and retry.'; return 1; }
  # The first status write follows READY and can take a remote-read timeout; bound the wait.
  local _attempt
  for _attempt in {1..24}; do
    if [ -f "$state_dir/status.json" ] && jq -e '.dispatch.enabled == false and (.dispatch.reasons | index("locally_disabled") != null)' "$state_dir/status.json" >/dev/null 2>&1; then break; fi
    sleep 5
  done
  held_status
  printf '%s %s\n' "$commit" "$repo" >"$receipt"
  printf 'install-exe-dev: installed=%s held=yes; only Giuseppe may lift factory-state/disabled\n' "$commit"
}

main() {
  local check=false commit='' repo=nublai/pi-herdr-factorio vm=nubl-factory
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --check) check=true; shift;;
      --repo) [ "$#" -ge 2 ] || { refuse arguments 'Use [--check] [--repo owner/name] [--vm name] <40-character-commit>.'; return 1; }; repo=$2; shift 2;;
      --vm) [ "$#" -ge 2 ] || { refuse arguments 'Pass --vm <exe.dev VM name>.'; return 1; }; vm=$2; shift 2;;
      *) [ -z "$commit" ] || { refuse arguments 'Pass only one full commit SHA.'; return 1; }; commit=$1; shift;;
    esac
  done
  [[ "$repo" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] && [[ "$vm" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { refuse arguments 'Use --repo owner/name and a lowercase exe.dev --vm name.'; return 1; }
  if [ "$check" = false ] || [ -n "$commit" ]; then validate_commit "$commit" || return 1; fi
  export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
  preflight || return 1
  [ "$check" = false ] || return 0
  export FACTORY_PLATFORM=exe-dev GH_HOST=github.int.exe.xyz
  unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
  install_controller
}

if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then main "$@"; fi
