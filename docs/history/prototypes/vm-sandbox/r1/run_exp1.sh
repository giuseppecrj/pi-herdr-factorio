#!/bin/bash
set -u
cd /home/exedev/f05-proto
NODE=/home/exedev/.local/share/mise/installs/node/26.12.1/bin/node
echo "# exp1 run at $(date -Is) on $(hostname)"
echo "## edge cert"
echo | openssl s_client -connect 169.254.169.254:443 -servername llm.int.exe.xyz -alpn h2,http/1.1 2>/dev/null | grep -E 'subject=|issuer=|ALPN|DNS:' ; echo | openssl s_client -connect 169.254.169.254:443 -servername llm.int.exe.xyz 2>/dev/null | openssl x509 -noout -ext subjectAltName 2>/dev/null
echo "## raw HTTP/1.1 probes (JSONL)"
python3 exp1_probe.py
echo "## HTTP/2 probes, node $($NODE --version) (JSONL)"
$NODE exp1_h2.mjs
echo "## curl probes"
bash exp1_curl.sh
