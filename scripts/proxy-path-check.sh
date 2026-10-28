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
lock=$(tailscale lock status 2>&1)
case $lock in
  *"LOCKED OUT"*) echo "tailnet lock: this node is LOCKED OUT" ;;
  *"is accessible"*) echo "tailnet lock: this node is signed" ;;
  *DISABLED*) echo "tailnet lock: disabled" ;;
  *) echo "tailnet lock: unknown ($(head -1 <<<"$lock" | head -c 80))" ;;
esac

ip=$(getent hosts "$host" | awk '{print $1}' | head -1)
if [ -n "$ip" ]; then
  echo "::add-mask::$ip"
  case $ip in
    100.*) echo "dns: resolved to a tailnet address" ;;
    *) echo "dns: resolved to a NON-tailnet address" ;;
  esac
  ping_out=$(tailscale ping -c 3 --timeout 5s "$ip" 2>&1 | tail -1)
  case $ping_out in
    *"via DERP"*) echo "tailscale ping: pong via relay" ;;
    *pong*) echo "tailscale ping: pong direct" ;;
    *) echo "tailscale ping: no pong" ;;
  esac
  if nc -z -w 5 "$ip" 443 2>/dev/null; then
    echo "tcp 443: open"
  else
    echo "tcp 443: no answer"
  fi
else
  echo "dns: FAILED"
fi

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -H "Authorization: Bearer $CLIPROXYAPI_API_KEY" \
  "${CLIPROXYAPI_BASE_URL%/}/v1/models" 2>/tmp/curl.err)
err=$(sed "s/$host/<host>/g" /tmp/curl.err | head -c 200)
echo "GET /v1/models: http=$code curl_error=$err"
[ "$code" = 200 ]
