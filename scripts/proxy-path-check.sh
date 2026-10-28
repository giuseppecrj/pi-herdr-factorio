#!/usr/bin/env bash
# Logs from this public repo are public, so every tailnet name and address is masked.
set -uo pipefail

host=$(python3 -c 'import os, urllib.parse as u
print(u.urlparse(os.environ["CLIPROXYAPI_BASE_URL"]).hostname)')
short=${host%%.*}
echo "::add-mask::$host"
echo "::add-mask::$short"

st=$(tailscale status --json)
peer_match='[.Peer // {} | .[]
  | select(.HostName == $h or (.DNSName | startswith($h + ".")))] | length > 0'
echo "visible peers: $(jq '.Peer // {} | length' <<<"$st")"
echo "proxy among peers: $(jq --arg h "$short" "$peer_match" <<<"$st")"
echo "MagicDNS suffix set: $(jq '.MagicDNSSuffix != ""' <<<"$st")"

ip=$(getent hosts "$host" | awk '{print $1}' | head -1)
if [ -n "$ip" ]; then
  echo "::add-mask::$ip"
  echo "dns: resolved"
else
  echo "dns: FAILED"
fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -H "Authorization: Bearer $CLIPROXYAPI_API_KEY" \
  "${CLIPROXYAPI_BASE_URL%/}/v1/models" 2>/tmp/curl.err)
err=$(sed "s/$host/<host>/g" /tmp/curl.err | head -c 200)
echo "GET /v1/models: http=$code curl_error=$err"
