#!/bin/bash
# F05 R1 experiment 2: network-namespace bypass suite.
set -u
cd /home/exedev/f05-proto
echo "# exp2 run at $(date -Is) on $(hostname), bwrap $(bwrap --version)"
echo "## CONTROL (host, outside sandbox): proves the probes would succeed without the netns"
for hp in 169.254.169.254:443 2852039166:443 0xa9fea9fe:443 140.82.114.5:443 10.42.0.1:53; do
  printf 'control tcp %-24s ' "$hp"; timeout 8 python3 -c "import socket,sys; h,p=sys.argv[1].rsplit(':',1); socket.create_connection((h,int(p)),timeout=5); print('CONNECTED')" "$hp" 2>&1 | tail -1
done
printf 'control getent api.github.com: '; getent hosts api.github.com | head -1
printf 'control curl https://github.int.exe.xyz/zen: '; curl -s -o /dev/null -m 8 -w '%{http_code}\n' https://github.int.exe.xyz/zen
printf 'control curl https://api.github.com/zen: '; curl -s -o /dev/null -m 8 -w '%{http_code}\n' https://api.github.com/zen
printf 'control curl https://llm.int.exe.xyz/openai/v1/models: '; curl -s -o /dev/null -m 8 -w '%{http_code}\n' https://llm.int.exe.xyz/openai/v1/models
printf 'control curl http://127.0.0.1:9999/ (host loopback listener): '; curl -s -o /dev/null -m 5 -w '%{http_code}\n' http://127.0.0.1:9999/ 2>&1

echo "## SANDBOX: bwrap --unshare-all"
BW=(bwrap --unshare-all --die-with-parent --new-session
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/sbin /sbin
  --symlink usr/lib /lib --symlink usr/lib64 /lib64
  --proc /proc --dev /dev --tmpfs /tmp
  --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /etc/hosts /etc/hosts
  --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind /etc/ssl /etc/ssl
  --ro-bind /home/exedev/f05-proto/exp2_inside.sh /probe.sh
  --clearenv --setenv PATH /usr/bin:/usr/sbin --setenv HOME /tmp)
echo "argv: ${BW[*]} /usr/bin/bash /probe.sh"
"${BW[@]}" /usr/bin/bash /probe.sh
echo "bwrap exit=$?"
