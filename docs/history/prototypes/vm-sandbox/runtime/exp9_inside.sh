#!/bin/bash
# F05 exp 9: runs INSIDE bwrap. npm install through the gateway's /npm/ prefix only.
set -u
socat TCP-LISTEN:18080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/gw.sock </dev/null >/dev/null 2>/tmp/socat.err &
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.1; done
echo "## sandbox: ifaces=$(ip -br addr | cut -d' ' -f1 | tr '\n' ' ') routes=[$(ip route | tr '\n' ';')]"
echo "node $(node --version) npm $(npm --version)"
mkdir -p /work/proj && cd /work/proj
printf 'registry=http://127.0.0.1:18080/npm/\n' > .npmrc
echo '{"name":"exp9","version":"1.0.0","private":true}' > package.json
echo "## npm config (effective): registry=$(npm config get registry) replace-registry-host=$(npm config get replace-registry-host)"
t0=$(date +%s.%N)
npm install --ignore-scripts --no-audit --no-fund --loglevel http --cache /tmp/npm-cache is-number@7.0.0 > /work/npm.out 2>&1
rc=$?
echo "npm install rc=$rc seconds=$(python3 -c "print(round($(date +%s.%N)-$t0,2))")"
echo "## npm output"; cat /work/npm.out
echo "## URLs npm fetched (from its http log lines)"
grep -oE 'https?://[^ ]+' /work/npm.out | sort | uniq -c
echo "## lockfile resolved/integrity"
python3 -c 'import json;d=json.load(open("package-lock.json"));p=d["packages"]["node_modules/is-number"];print(p["version"],p["resolved"],p["integrity"])'
echo "## npm debug logs (all URLs mentioned)"
grep -hoE 'https?://[^ "]+' /tmp/home/.npm/_logs/*.log /tmp/npm-cache/_logs/*.log 2>/dev/null | sort | uniq -c
echo "## installed: $(ls node_modules) $(node -e 'console.log(require("is-number")(5))')"
