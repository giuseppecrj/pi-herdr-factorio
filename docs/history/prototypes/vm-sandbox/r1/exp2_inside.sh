#!/usr/bin/bash
# F05 R1 experiment 2: runs INSIDE bwrap --unshare-all. Every probe should fail.
set -u
echo "## sandbox identity"
id; echo "hostname=$(cat /proc/sys/kernel/hostname)"
echo "## interfaces / routes"
ip -br addr 2>&1; echo "routes v4:"; ip route 2>&1; echo "routes v6:"; ip -6 route 2>&1
echo "/proc/net/dev:"; tail -n +3 /proc/net/dev | awk '{print "  "$1}'
echo "resolv.conf: $(tr '\n' ' ' </etc/resolv.conf)"

FAILS=0; PASSES=0
t() { # name, command... ; PASS when the command fails
  local name=$1; shift
  local out rc
  out=$(timeout 10 "$@" 2>&1); rc=$?
  local last; last=$(printf '%s' "$out" | tr '\n' ' ' | tail -c 160)
  if [ $rc -eq 0 ]; then FAILS=$((FAILS+1)); echo "PROBE-FAIL(reached) rc=0 | $name | $last"
  else PASSES=$((PASSES+1)); echo "probe-pass rc=$rc | $name | $last"; fi
}
C="curl -sS -o /dev/null --connect-timeout 5 -m 8 -w %{http_code}"

TARGETS=(
  "https://169.254.169.254/zen"
  "https://2852039166/zen"
  "https://0xa9fea9fe/zen"
  "https://0251.0376.0251.0376/zen"
  "https://169.254.43518/zen"
  "https://[::ffff:169.254.169.254]/zen"
  "https://[::ffff:a9fe:a9fe]/zen"
  "http://169.254.169.254/zen"
  "http://2852039166/zen"
  "http://0xa9fea9fe/zen"
  "http://0251.0376.0251.0376/zen"
  "http://[::ffff:169.254.169.254]/zen"
  "https://api.github.com/zen"
  "https://140.82.114.5/zen"
  "https://github.int.exe.xyz/zen"
  "https://llm.int.exe.xyz/openai/v1/models"
  "https://registry.npmjs.org/"
  "https://104.16.0.34/"
  "https://[2606:4700::6810:122]/"
  "http://10.42.0.1/"
  "https://10.42.0.1/"
  "http://10.42.0.42/"
  "http://172.17.0.1/"
  "http://127.0.0.1:9999/"
  "http://127.0.0.1:32849/"
)

echo "## curl, no proxy env"
for u in "${TARGETS[@]}"; do t "curl -k $u" $C -k "$u"; done
echo "## curl --resolve name→IP (SNI/Host = name, dial IP)"
t "curl api.github.com via --resolve 140.82.114.5" $C --resolve api.github.com:443:140.82.114.5 https://api.github.com/zen
t "curl github.int via --resolve 169.254.169.254" $C --resolve github.int.exe.xyz:443:169.254.169.254 https://github.int.exe.xyz/zen
t "curl llm.int via --resolve 2852039166" $C -k --resolve llm.int.exe.xyz:443:169.254.169.254 https://llm.int.exe.xyz/openai/v1/models

for pv in "HTTPS_PROXY=http://169.254.169.254:80" "HTTPS_PROXY=http://10.42.0.1:3128" \
          "ALL_PROXY=socks5h://169.254.169.254:1080" "ALL_PROXY=http://10.42.0.1:3128" \
          "http_proxy=http://169.254.169.254:80" "http_proxy=http://127.0.0.1:9999"; do
  echo "## curl with $pv"
  for u in "${TARGETS[@]}"; do t "[$pv] curl -k $u" env "$pv" $C -k "$u"; done
done
echo "## curl with HTTPS_PROXY+ALL_PROXY+http_proxy+HTTP_PROXY all set to the edge"
for u in "${TARGETS[@]}"; do
  t "[all-proxies=edge] curl -k $u" env HTTPS_PROXY=http://169.254.169.254:80 ALL_PROXY=http://169.254.169.254:80 \
    http_proxy=http://169.254.169.254:80 HTTP_PROXY=http://169.254.169.254:80 $C -k "$u"
done

echo "## python raw TCP connects (getaddrinfo accepts inet_aton spellings)"
for hp in 169.254.169.254:443 2852039166:443 0xa9fea9fe:443 0251.0376.0251.0376:443 "::ffff:169.254.169.254:443" \
          140.82.114.5:443 api.github.com:443 github.int.exe.xyz:443 llm.int.exe.xyz:443 \
          10.42.0.1:53 10.42.0.1:443 104.16.0.34:443 127.0.0.1:9999; do
  t "py tcp $hp" python3 -c "import socket,sys; h,p=sys.argv[1].rsplit(':',1); socket.create_connection((h,int(p)),timeout=5); print('CONNECTED')" "$hp"
done
echo "## python UDP sendto DNS servers"
for ip in 169.254.169.254 10.42.0.1 8.8.8.8; do
  t "py udp sendto $ip:53" python3 -c "import socket,sys; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(3); s.sendto(b'\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x03api\x06github\x03com\x00\x00\x01\x00\x01',(sys.argv[1],53)); print(s.recv(512))" "$ip"
done
echo "## DNS lookups"
for n in api.github.com github.int.exe.xyz llm.int.exe.xyz registry.npmjs.org; do
  t "getent hosts $n" getent hosts "$n"
  t "python getaddrinfo $n" python3 -c "import socket,sys; print(socket.getaddrinfo(sys.argv[1],443))" "$n"
done
t "dig (resolv.conf) api.github.com" dig +time=2 +tries=1 +short api.github.com
for s in 169.254.169.254 10.42.0.1 8.8.8.8 1.1.1.1; do
  t "dig @$s api.github.com" dig +time=2 +tries=1 +short "@$s" api.github.com
  t "dig +tcp @$s api.github.com" dig +tcp +time=2 +tries=1 +short "@$s" api.github.com
done
echo "## ICMP"
t "ping 169.254.169.254" ping -c1 -W2 169.254.169.254
t "ping 10.42.0.1" ping -c1 -W2 10.42.0.1
echo "## summary: probes_failed_as_expected=$PASSES probes_that_reached=$FAILS"
