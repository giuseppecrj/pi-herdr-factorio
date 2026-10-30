#!/usr/bin/env bash
# Idempotent setup for the factory VM. Run it on the VM from a checkout of this repository:
#   bash server/provision.sh          host tools, Pi config and the stage sandbox bundle
#   bash server/provision.sh sandbox  the stage sandbox bundle only
set -euo pipefail

PI_VERSION=1.4.0
HERDR_VERSION=0.9.5
HERDR_SHA256=14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d
LLM=https://llm.int.exe.xyz
DEFAULT_PROVIDER=openai
DEFAULT_MODEL=gpt-6.1-sol
NODE_MIN=26.12.1
NODE_VERSION=26.12.1
NODE_SHA256=6170b2d474e1c626f43cff3adc118df9fe3b573258a4fc3d850c8dbc6b079bbd
SANDBOX_ROOT=/var/lib/factory-sandbox
FORWARDER=http://127.0.0.1:18080

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
mode=${1:-all}
case "$mode" in all|sandbox) ;; *) echo "usage: provision.sh [sandbox]" >&2; exit 2;; esac

version_at_least() {
  local IFS=. i a b
  read -r -a a <<<"${1#v}"
  read -r -a b <<<"$2"
  for i in 0 1 2; do
    [ "${a[i]:-0}" -gt "${b[i]:-0}" ] && return 0
    [ "${a[i]:-0}" -lt "${b[i]:-0}" ] && return 1
  done
  return 0
}

# fetch <url> <sha256> <dest>: download once into the cache, verified by checksum.
fetch() {
  if ! echo "$2  $3" | sha256sum --check --quiet --status 2>/dev/null; then
    curl -fsSL -o "$3.tmp" "$1"
    echo "$2  $3.tmp" | sha256sum --check --quiet
    mv "$3.tmp" "$3"
  fi
}

export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"

if [ "$mode" = all ]; then
  if ! command -v mise >/dev/null; then
    curl -fsSL https://mise.run | sh
  fi
  mise use -g node@26 >/dev/null
  mise reshim
  grep -q 'mise activate' ~/.bashrc || echo 'eval "$(~/.local/bin/mise activate bash)"' >>~/.bashrc

  if [ "$(pi --version 2>/dev/null)" != "$PI_VERSION" ]; then
    npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"
    mise reshim
  fi
fi

if ! version_at_least "$(node --version)" "$NODE_MIN"; then
  echo "provision: node $(node --version) is below required $NODE_MIN" >&2
  exit 1
fi

if [ "$(uname -m)" != x86_64 ]; then
  echo "provision: the herdr and node pins are for x86_64 only" >&2
  exit 1
fi

cache=${XDG_CACHE_HOME:-$HOME/.cache}/factory-sandbox
mkdir -p "$cache"
herdr_bin="$cache/herdr-$HERDR_VERSION-linux-x86_64"
fetch "https://github.com/herdrdev/herdr/releases/download/v$HERDR_VERSION/herdr-linux-x86_64" \
  "$HERDR_SHA256" "$herdr_bin"

if [ "$mode" = all ] && [ "$(herdr --version 2>/dev/null)" != "herdr $HERDR_VERSION" ]; then
  install -m 0755 "$herdr_bin" "$HOME/.local/bin/herdr"
fi

if [ "$mode" = all ]; then
  # exe.dev injects credentials at its edge; Pi only needs a placeholder key to list the models.
  mkdir -p ~/.pi/agent
  cat >~/.pi/agent/models.json <<JSON
{
  "providers": {
    "anthropic": { "baseUrl": "$LLM/anthropic", "apiKey": "exe-dev-integration" },
    "openai": { "baseUrl": "$LLM/openai/v1", "apiKey": "exe-dev-integration" }
  }
}
JSON

  settings=~/.pi/agent/settings.json
  [ -f "$settings" ] || echo '{}' >"$settings"
  jq --arg p "$DEFAULT_PROVIDER" --arg m "$DEFAULT_MODEL" \
    '.defaultProvider = $p | .defaultModel = $m' "$settings" >"$settings.tmp"
  mv "$settings.tmp" "$settings"

  for pkg in pi-herdr-agents pi-herdr-pstack; do
    pi list 2>/dev/null | grep -q "npm:$pkg" || pi install "npm:$pkg"
  done
fi

# The stage sandbox bundle. It is built in a scratch dir from pinned inputs only, named by the
# sha256 of its manifest (server/sandbox/manifest.ts), and installed root-owned and read-only
# at $SANDBOX_ROOT/assets-<sha256>. bwrap mounts it at /opt/factory. `current` names the one
# the controller uses.
node_tar="$cache/node-v$NODE_VERSION-linux-x64.tar.xz"
fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" \
  "$NODE_SHA256" "$node_tar"

build=$(mktemp -d)
trap 'chmod -R u+w "$build" 2>/dev/null; rm -rf "$build"' EXIT
b="$build/bundle"
mkdir -p "$b/node" "$b/bin" "$b/sandbox" "$b/etc" "$b/pkg" "$b/pi-agent" "$b/skills" "$build/home"

tar -xJf "$node_tar" -C "$b/node" --strip-components=1 --no-same-owner
rm -rf "$b/node/include" "$b/node/share"
install -m 0755 "$herdr_bin" "$b/bin/herdr"
install -m 0644 "$repo/server/sandbox/assets/package.json" \
  "$repo/server/sandbox/assets/package-lock.json" "$b/pkg/"
(cd "$b/pkg" && env -i PATH="$b/node/bin:/usr/bin:/bin" HOME="$build/home" \
  npm_config_cache="$build/npm-cache" npm_config_update_notifier=false \
  npm ci --ignore-scripts --no-audit --no-fund >/dev/null)
install -m 0644 "$repo/server/sandbox/assets/pi.ts" "$repo/server/sandbox/assets/stage-init.ts" \
  "$b/sandbox/"

for skill in "$repo"/skills/*/; do
  name=$(basename "$skill")
  install -d -m 0755 "$b/skills/$name"
  find "$skill" -maxdepth 1 -type f -exec install -m 0644 {} "$b/skills/$name/" \;
done

cat >"$b/bin/pi" <<'SH'
#!/bin/sh
exec /opt/factory/node/bin/node /opt/factory/sandbox/pi.ts "$@"
SH
chmod 0755 "$b/bin/pi"

printf 'root:x:0:0:root:/root:/usr/sbin/nologin\nagent:x:1000:1000:agent:/home/agent:/bin/bash\n' >"$b/etc/passwd"
printf 'root:x:0:\nagent:x:1000:\n' >"$b/etc/group"
printf '127.0.0.1 localhost\n::1 localhost\n' >"$b/etc/hosts"
printf '# factory sandbox: no nameservers\n' >"$b/etc/resolv.conf"

# Pi reaches the model only through the in-sandbox forwarder. The key is a placeholder:
# exe.dev's edge authorizes the model, and the gateway strips client credentials anyway.
cat >"$b/pi-agent/models.json" <<JSON
{
  "providers": {
    "openai": { "baseUrl": "$FORWARDER/openai/v1", "apiKey": "sandbox-placeholder-not-a-key" },
    "xai": { "baseUrl": "$FORWARDER/xai/v1", "apiKey": "sandbox-placeholder-not-a-key" }
  }
}
JSON
cat >"$b/pi-agent/settings.json" <<JSON
{
  "defaultProvider": "$DEFAULT_PROVIDER",
  "defaultModel": "$DEFAULT_MODEL"
}
JSON
chmod 0644 "$b/etc/"* "$b/pi-agent/"*

digest=$(node "$repo/server/sandbox/manifest.ts" "$b")
dest="$SANDBOX_ROOT/assets-$digest"

if [ ! -d "$dest" ]; then
  sudo install -d -m 0755 -o root -g root "$SANDBOX_ROOT"
  sudo rm -rf "$dest.tmp"
  sudo cp -a "$b" "$dest.tmp"
  sudo chown -R root:root "$dest.tmp"
  sudo chmod -R a-w "$dest.tmp"
  sudo mv -T "$dest.tmp" "$dest"
fi

installed=$(node "$repo/server/sandbox/manifest.ts" "$dest")
if [ "$installed" != "$digest" ]; then
  echo "provision: $dest does not match its name (got $installed)" >&2
  exit 1
fi

if [ "$(readlink "$SANDBOX_ROOT/current" 2>/dev/null)" != "assets-$digest" ]; then
  sudo ln -sfn "assets-$digest" "$SANDBOX_ROOT/current.tmp"
  sudo mv -T "$SANDBOX_ROOT/current.tmp" "$SANDBOX_ROOT/current"
fi

printf 'sandbox assets %s\n' "$dest"
if [ "$mode" = all ]; then
  printf 'node %s, pi %s, %s, gh %s, default %s/%s\n' "$(node --version)" "$(pi --version)" \
    "$(herdr --version)" "$(gh --version | head -1 | awk '{print $3}')" "$DEFAULT_PROVIDER" "$DEFAULT_MODEL"
fi
