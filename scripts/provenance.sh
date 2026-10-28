#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
{
  echo "# Upstream provenance"
  echo
  echo "Concatenated \`SOURCE.md\` files from the local-only \`research/upstream/\` captures. Regenerate with \`scripts/provenance.sh\`."
  find research/upstream -name SOURCE.md | sort | while read -r f; do
    echo
    echo "## \`${f#research/upstream/}\`"
    echo
    sed 's/^#/###/' "$f"
  done
} > research/PROVENANCE.md
