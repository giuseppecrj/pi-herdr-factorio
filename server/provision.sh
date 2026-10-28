#!/usr/bin/env bash
# Idempotent setup for the factory VM. Run on the VM: bash -s < server/provision.sh
set -euo pipefail

PI_VERSION=1.4.0
HERDR_VERSION=0.9.5
HERDR_SHA256=14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d
LLM=https://llm.int.exe.xyz
DEFAULT_PROVIDER=openai
DEFAULT_MODEL=gpt-6.1-sol

if ! command -v mise >/dev/null; then
  curl -fsSL https://mise.run | sh
fi
export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
mise use -g node@22 >/dev/null
grep -q 'mise activate' ~/.bashrc || echo 'eval "$(~/.local/bin/mise activate bash)"' >>~/.bashrc

if [ "$(pi --version 2>/dev/null)" != "$PI_VERSION" ]; then
  npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$PI_VERSION"
  mise reshim
fi

if [ "$(herdr --version 2>/dev/null)" != "herdr $HERDR_VERSION" ]; then
  tmp=$(mktemp)
  curl -fsSL -o "$tmp" \
    "https://github.com/herdrdev/herdr/releases/download/v$HERDR_VERSION/herdr-linux-x86_64"
  echo "$HERDR_SHA256  $tmp" | sha256sum --check --quiet
  install -m 0755 "$tmp" "$HOME/.local/bin/herdr"
  rm -f "$tmp"
fi

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

printf 'node %s, pi %s, %s, gh %s, default %s/%s\n' "$(node --version)" "$(pi --version)" \
  "$(herdr --version)" "$(gh --version | head -1 | awk '{print $3}')" "$DEFAULT_PROVIDER" "$DEFAULT_MODEL"
