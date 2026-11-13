#!/usr/bin/bash
# F05 R1 experiment 3: runs INSIDE bwrap --unshare-all. The only egress is /run/gw.sock.
set -u
P=18080; B=http://127.0.0.1:$P
echo "## sandbox: interfaces=$(ip -br addr | cut -d' ' -f1 | tr '\n' ' ') routes=[$(ip route | tr '\n' ';')] gw.sock=$(ls -l /run/gw.sock | cut -d' ' -f1)"
socat -lp fwd TCP-LISTEN:$P,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/gw.sock &
FWD=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do (exec 3<>/dev/tcp/127.0.0.1/$P) 2>/dev/null && break; sleep 0.2; done
echo "## forwarder: socat pid $FWD, 127.0.0.1:$P -> /run/gw.sock"
OK=0; BAD=0
g() { # name, expected status, curl args...
  local name=$1 want=$2; shift 2
  local out code body
  body=$(mktemp)
  local err; err=$(mktemp)
  out=$(curl -sS -m 30 -o "$body" -w '%{http_code}|connect=%{http_connect}|redirect=%{redirect_url}|followed=%{num_redirects}' "$@" 2>"$err")
  code=${out%%|*}
  local conn; conn=${out#*connect=}; conn=${conn%%|*}
  local snip; snip=$(head -c 110 "$body" | tr '\n' ' ')
  local cerr; cerr=$(tr '\n' ' ' <"$err")
  if [ "$code" = "$want" ] || [ "$conn" = "$want" ]; then OK=$((OK+1)); v=PASS; else BAD=$((BAD+1)); v=FAIL; fi
  echo "$v want=$want got=$out | $name | ${cerr:+curl-stderr: $cerr | }$snip"
  rm -f "$body" "$err"
}
echo "## allowed"
g "GET /openai/v1/models" 200 $B/openai/v1/models
g "GET /xai/v1/models" 200 $B/xai/v1/models
g "GET /npm/is-number/7.0.0 (packument version)" 200 $B/npm/is-number/7.0.0
g "HEAD /npm/is-number" 200 -I $B/npm/is-number
g "GET /npm/<missing pkg> (upstream 404 passed through)" 404 $B/npm/f05-r1-this-package-does-not-exist-zz
echo "## tarball integrity through the gateway"
INTEG=$(curl -s $B/npm/is-number/7.0.0 | python3 -c 'import json,sys; d=json.load(sys.stdin)["dist"]; print(d["integrity"]); print(d["tarball"])')
echo "packument dist: $(echo "$INTEG" | tr '\n' ' ')"
GOT="sha512-$(curl -s $B/npm/is-number/-/is-number-7.0.0.tgz | openssl dgst -sha512 -binary | base64 -w0)"
WANT=$(echo "$INTEG" | head -1)
if [ "$GOT" = "$WANT" ]; then OK=$((OK+1)); echo "PASS tarball sha512 matches packument integrity ($GOT)"; else BAD=$((BAD+1)); echo "FAIL tarball sha512 $GOT != $WANT"; fi
echo "## denied paths (expect 403, no upstream)"
g "/anthropic/v1/models" 403 $B/anthropic/v1/models
g "POST /anthropic/v1/messages" 403 -X POST -H 'content-type: application/json' -d '{}' $B/anthropic/v1/messages
g "/zen" 403 $B/zen
g "/" 403 $B/
g "/github/zen" 403 $B/github/zen
g "/openai/v2/models" 403 $B/openai/v2/models
g "/openai/models (no v1)" 403 $B/openai/models
g "/openai/v1/../../zen (path-as-is)" 403 --path-as-is $B/openai/v1/../../zen
g "/openai/v1/%2e%2e/%2e%2e/zen" 403 --path-as-is "$B/openai/v1/%2e%2e/%2e%2e/zen"
g "/openai/v1/%2E%2E%2F%2E%2E%2Fzen" 403 --path-as-is "$B/openai/v1/%2E%2E%2F%2E%2E%2Fzen"
g "/npm/../zen (path-as-is)" 403 --path-as-is $B/npm/../zen
g "/npm/%252e%252e/zen (double-encoded)" 403 --path-as-is "$B/npm/%252e%252e/zen"
g "//github.int.exe.xyz/zen (network-path)" 403 --path-as-is $B//github.int.exe.xyz/zen
g "/openai/v1//github.int.exe.xyz/zen" 403 --path-as-is $B/openai/v1//github.int.exe.xyz/zen
g "/openai/v1/models\\..\\zen backslash" 403 --path-as-is "$B/openai/v1/models%5c..%5czen"
echo "## forged Host / forwarding headers (expect 403)"
g "Host: github.int.exe.xyz on /openai/v1/models" 403 -H 'Host: github.int.exe.xyz' $B/openai/v1/models
g "Host: github.int.exe.xyz on /zen" 403 -H 'Host: github.int.exe.xyz' $B/zen
g "Host: llm.int.exe.xyz on /openai/v1/models" 403 -H 'Host: llm.int.exe.xyz' $B/openai/v1/models
g "X-Forwarded-Host: github.int.exe.xyz" 403 -H 'X-Forwarded-Host: github.int.exe.xyz' $B/openai/v1/models
g "Forwarded: host=github.int.exe.xyz" 403 -H 'Forwarded: host=github.int.exe.xyz' $B/openai/v1/models
g "X-Original-URL: https://github.int.exe.xyz/zen" 403 -H 'X-Original-URL: https://github.int.exe.xyz/zen' $B/openai/v1/models
echo "## absolute URL / proxy use (expect 403)"
g "request-target https://github.int.exe.xyz/zen" 403 --request-target https://github.int.exe.xyz/zen $B/
g "request-target https://github.int.exe.xyz/openai/v1/models" 403 --request-target https://github.int.exe.xyz/openai/v1/models $B/
g "proxy GET http://github.int.exe.xyz/zen (absolute-form)" 403 -x $B http://github.int.exe.xyz/zen
g "proxy CONNECT github.int.exe.xyz:443" 403 -x $B https://github.int.exe.xyz/zen
g "HTTPS_PROXY env CONNECT api.github.com" 403 --proxy "" -x $B https://api.github.com/zen
echo "## methods (expect 403)"
g "POST /npm/is-number" 403 -X POST -d x $B/npm/is-number
g "DELETE /openai/v1/models" 403 -X DELETE $B/openai/v1/models
echo "## upstream 3xx (fixture)"
g "302 to github.int passed back, not followed" 302 $B/__fixture/redir-github
g "302 to api.github.com passed back, not followed" 302 $B/__fixture/redir-api
g "client -L follows 302 to github.int: fails in sandbox (no DNS/route)" 000 -L $B/__fixture/redir-github
g "client -L follows relative 302 back through gateway" 200 -L $B/__fixture/redir-local
echo "## direct egress still impossible"
g "direct https://github.int.exe.xyz/zen" 000 https://github.int.exe.xyz/zen
g "direct https://169.254.169.254/zen" 000 -k https://169.254.169.254/zen
echo "## tiny completion: openai/gpt-6.1-sol, max 16 tokens"
REQ='{"model":"openai/gpt-6.1-sol","messages":[{"role":"user","content":"Reply with exactly: OK"}],"max_completion_tokens":16}'
RESP=$(curl -sS -m 90 -w '\n%{http_code}' -H 'content-type: application/json' -d "$REQ" $B/openai/v1/chat/completions)
CODE=$(echo "$RESP" | tail -1)
echo "completion http=$CODE"
echo "$RESP" | sed '$d' | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    j=json.loads(raw)
except Exception:
    print("non-json:", raw[:300]); sys.exit()
if "choices" in j:
    c=j["choices"][0]
    print("model:", j.get("model"), "| finish_reason:", c.get("finish_reason"), "| content:", repr((c.get("message") or {}).get("content")), "| usage:", json.dumps(j.get("usage")))
else:
    print("error body:", json.dumps(j)[:400])'
if [ "$CODE" = 200 ]; then OK=$((OK+1)); echo "PASS completion via gateway"; else BAD=$((BAD+1)); echo "FAIL completion via gateway"; fi
kill $FWD 2>/dev/null
echo "## inside summary: pass=$OK fail=$BAD"
