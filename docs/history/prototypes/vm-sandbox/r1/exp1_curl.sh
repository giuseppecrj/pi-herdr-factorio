#!/bin/bash
# F05 R1 experiment 1, curl part: --http2 with -H Host:, and --request-target.
# All requests are unauthenticated GETs.
set -u
L=llm.int.exe.xyz; G=github.int.exe.xyz
fp() { # name, curl args...
  local name=$1; shift
  local hdr body
  hdr=$(mktemp); body=$(mktemp)
  local meta
  meta=$(curl -sS -m 15 -o "$body" -D "$hdr" -w '%{http_code} http_version=%{http_version}' "$@" 2>&1)
  local traces server gh sha snip
  traces=$(grep -ci '^x-trace-id:' "$hdr")
  server=$(grep -i '^server:' "$hdr" | head -1 | tr -d '\r' | cut -d' ' -f2-)
  gh=$(grep -ci '^x-github-request-id:' "$hdr")
  sha=$(sha256sum "$body" | cut -c1-16)
  snip=$(head -c 70 "$body" | tr '\n' ' ')
  printf '%s | %s | x-trace-id=%s server=%s x-github-request-id=%s body_sha=%s | %s\n' "$name" "$meta" "$traces" "${server:-none}" "$gh" "$sha" "$snip"
  rm -f "$hdr" "$body"
}
for P in /openai/v1/models /xai/v1/models /zen; do
  echo "--- path $P"
  fp "curl-h1 base L"                 --http1.1 "https://$L$P"
  fp "curl-h1 base G"                 --http1.1 "https://$G$P"
  fp "curl-h2 base L"                 --http2 "https://$L$P"
  fp "curl-h2 base G"                 --http2 "https://$G$P"
  fp "curl-h2 sni=L -H Host:G"        --http2 -H "Host: $G" "https://$L$P"
  fp "curl-h2 sni=G -H Host:L"        --http2 -H "Host: $L" "https://$G$P"
  fp "curl-h1 sni=L -H Host:G"        --http1.1 -H "Host: $G" "https://$L$P"
  fp "curl-h1 req-target=https://G sni=L host=L" --http1.1 --request-target "https://$G$P" "https://$L/"
  fp "curl-h1 req-target=https://L sni=G host=G" --http1.1 --request-target "https://$L$P" "https://$G/"
  fp "curl-h2 req-target=https://G sni=L"         --http2 --request-target "https://$G$P" "https://$L/"
  fp "curl-h1 -x none, XFH=G sni=L"   --http1.1 -H "X-Forwarded-Host: $G" "https://$L$P"
  fp "curl-h2 XFH=G sni=L"            --http2 -H "X-Forwarded-Host: $G" "https://$L$P"
  fp "curl-h2 Forwarded host=G sni=L" --http2 -H "Forwarded: host=$G" "https://$L$P"
done
echo "--- plain HTTP port 80 (for completeness)"
fp "curl-http80 L /openai/v1/models" --http1.1 "http://$L/openai/v1/models"
fp "curl-http80 Host:G /zen via L"   --http1.1 -H "Host: $G" "http://$L/zen"
