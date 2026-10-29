#!/bin/bash
# F05 R1 experiment 3: path-routed gateway on a unix socket, reached from a bwrap sandbox.
set -u
INSIDE=${1:-exp3_inside.sh}
D=/home/exedev/f05-proto
cd $D
rm -rf gw && mkdir -p gw && chmod 700 gw   # fresh dir: a stale gw.sock would be bind-mounted before the gateway re-binds
: > gw/gw.log
FIXPORT=18999
echo "# exp3 run at $(date -Is) on $(hostname)"
python3 fixture.py $FIXPORT 2> gw/fixture.err &
FIXPID=$!
python3 gateway.py --socket $D/gw/gw.sock --log $D/gw/gw.log \
  --client-host 127.0.0.1:18080 --client-host localhost:18080 --fixture-port $FIXPORT 2> gw/gateway.err &
GWPID=$!
cleanup() { kill $GWPID $FIXPID 2>/dev/null; wait $GWPID $FIXPID 2>/dev/null; }
trap cleanup EXIT
for _ in $(seq 1 50); do grep -q listening gw/gateway.err 2>/dev/null && break; sleep 0.2; done
ls -l gw/gw.sock
echo "gateway pid=$GWPID (host side, outside sandbox), fixture pid=$FIXPID on 127.0.0.1:$FIXPORT"

BW=(bwrap --unshare-all --die-with-parent --new-session
  --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/sbin /sbin
  --symlink usr/lib /lib --symlink usr/lib64 /lib64
  --proc /proc --dev /dev --tmpfs /tmp
  --ro-bind /etc/resolv.conf /etc/resolv.conf --ro-bind /etc/hosts /etc/hosts
  --ro-bind /etc/nsswitch.conf /etc/nsswitch.conf --ro-bind /etc/ssl /etc/ssl
  --ro-bind /etc/alternatives /etc/alternatives
  --bind $D/gw/gw.sock /run/gw.sock
  --ro-bind $D/${INSIDE:-exp3_inside.sh} /probe.sh
  --clearenv --setenv PATH /usr/bin:/usr/sbin --setenv HOME /tmp)
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
UNIT=f05-proto-exp3-$$
echo "## sandbox launch: systemd-run --user --scope --unit=$UNIT -p MemoryMax=512M -p TasksMax=64 -- ${BW[*]} /usr/bin/bash /probe.sh"
if systemd-run --user --scope --quiet --unit=$UNIT -p MemoryMax=512M -p TasksMax=64 -- true 2>/dev/null; then
  systemd-run --user --scope --quiet --unit=$UNIT-run -p MemoryMax=512M -p TasksMax=64 -- "${BW[@]}" /usr/bin/bash /probe.sh
  echo "sandbox exit=$? (inside a user scope)"
else
  echo "user scope unavailable; running bwrap without a scope"
  "${BW[@]}" /usr/bin/bash /probe.sh
  echo "sandbox exit=$?"
fi
sleep 0.5
echo "## gateway stderr"; cat gw/gateway.err
echo "## fixture stderr"; cat gw/fixture.err
echo "## gateway log (JSONL, one line per request)"
cat gw/gw.log
echo "## gateway log analysis"
python3 - gw/gw.log <<'PY'
import json, sys, collections
recs = [json.loads(l) for l in open(sys.argv[1])]
fw = [r for r in recs if r.get("decision") == "forward"]
dn = [r for r in recs if r.get("decision") == "deny"]
err = [r for r in recs if "error" in r]
print(f"requests={len(recs)} forwarded={len(fw)} denied={len(dn)} errors={len(err)}")
pairs = collections.Counter((r["upstream"]["host_header_sent"], r["upstream"]["sni_sent"], r["upstream"]["peer"]) for r in fw)
for (h, s, p), n in sorted(pairs.items(), key=str):
    print(f"  upstream Host={h} SNI={s} peer={p}: {n}")
print("  every forwarded record has host_header_sent and sni_sent fields:", all("host_header_sent" in r["upstream"] and "sni_sent" in r["upstream"] for r in fw))
print("  any upstream Host/SNI naming github:", any("github" in str(r["upstream"].get("host_header_sent")) + str(r["upstream"].get("sni_sent")) for r in fw))
print("  denied records with an upstream:", sum(1 for r in dn if r.get("upstream")))
print("  3xx forwarded (status, Location, follow-up upstream requests from gateway):",
      [(r["status"], r["upstream"]["location"]) for r in fw if 300 <= r["status"] < 400])
for r in dn:
    print(f"  deny #{r['id']} {r['method']} {r['client_target'][:60]} host={r['client_host']} -> {r['reason']}")
PY
cleanup; trap - EXIT
echo "## leftover processes from this run:"; pgrep -af 'gateway.py|fixture.py|socat TCP-LISTEN:18080|bwrap' || echo none
systemctl --user list-units --all 'f05-proto*' --no-legend 2>/dev/null || true
