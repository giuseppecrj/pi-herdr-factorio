#!/bin/bash
# F05 runtime prototype setup on pi-factorio (host side, scratch dir only).
# Installs npm Pi 1.4.0 into $D/rt and pi-herdr-agents@3.3.1 into a clean agent dir,
# directly from the host to registry.npmjs.org (allowed by the task). Never touches ~/.pi or ~/.npm.
source ./common.sh
set -e
echo "# setup at $(date -Is)"
mkdir -p $D/etc $D/setup-home $D/npm-cache $D/scripts
printf 'root:x:0:0:root:/root:/usr/sbin/nologin\nsandbox:x:1000:1000:sandbox:/tmp/home:/bin/bash\n' > $D/etc/passwd
printf 'root:x:0:\nsandbox:x:1000:\n' > $D/etc/group
printf '127.0.0.1 localhost\n::1 localhost\n' > $D/etc/hosts
printf '# f05 sandbox: no nameservers\n' > $D/etc/resolv.conf
cp sbx-entry.sh exp5_inside.sh exp5_parent.py exp9_inside.sh exp10_inside.sh $D/scripts/
chmod 755 $D/scripts/*.sh

E=(env -i PATH=$NODE_DIR/bin:/usr/bin:/bin HOME=$D/setup-home npm_config_cache=$D/npm-cache
   npm_config_update_notifier=false PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1)
t0=$(now)
"${E[@]}" npm install --prefix $D/rt --ignore-scripts --no-audit --no-fund @earendil-works/pi-coding-agent@1.4.0 2>&1 | tail -3
t1=$(now)
echo "npm Pi install seconds: $(python3 -c "print(round($t1-$t0,1))")"
echo "npm pi --version: $("${E[@]}" $D/rt/node_modules/.bin/pi --version 2>&1)"
echo "npm pi package: $(python3 -c 'import json;d=json.load(open("'$D'/rt/node_modules/@earendil-works/pi-coding-agent/package.json"));print(d["name"],d["version"])')"

# Clean agent dirs. Placeholder apiKey; baseUrl is the in-sandbox forwarder over plain http.
mkdir -p $D/agent-bare
cat > $D/agent-bare/models.json <<EOF
{"providers": {"openai": {"baseUrl": "http://127.0.0.1:$P/openai/v1", "apiKey": "sandbox-placeholder-not-a-key"}}}
EOF
echo '{"defaultProvider": "openai", "defaultModel": "gpt-6.1-sol"}' > $D/agent-bare/settings.json
rm -rf $D/agent-herdr; cp -a $D/agent-bare $D/agent-herdr
t0=$(now)
"${E[@]}" PI_CODING_AGENT_DIR=$D/agent-herdr $D/rt/node_modules/.bin/pi install npm:pi-herdr-agents@3.3.1 2>&1 | tail -5
t1=$(now)
echo "pi install pi-herdr-agents seconds: $(python3 -c "print(round($t1-$t0,1))")"
echo "## agent-herdr settings.json"; cat $D/agent-herdr/settings.json; echo
echo "## agent-herdr installed versions"
for p in pi-herdr-agents @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui @sinclair/typebox; do
  f=$(find $D/agent-herdr -path "*node_modules/$p/package.json" 2>/dev/null | head -1)
  [ -n "$f" ] && echo "$p $(python3 -c "import json;print(json.load(open('$f'))['version'])")  ($f)" || echo "$p: not installed in agent dir"
done
echo "agent-herdr size: $(du -sh $D/agent-herdr | cut -f1); rt size: $(du -sh $D/rt | cut -f1)"
echo "herdr: $($HERDR --version)  sha256 $(sha256sum $HERDR | cut -c1-16)…"
echo "standalone pi: $($PISA_DIR/pi --version)"
echo "node: $($NODE_DIR/bin/node --version) npm: $(PATH=$NODE_DIR/bin:$PATH npm --version)"
echo "bwrap: $(bwrap --version)"
