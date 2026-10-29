#!/bin/bash
# Runs INSIDE the bwrap sandbox: start the forwarder 127.0.0.1:18080 -> /run/gw.sock, then exec "$@".
# stdin/stdout are the RPC pipes, so socat gets /dev/null for both.
socat TCP-LISTEN:18080,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/gw.sock </dev/null >/dev/null 2>/tmp/socat.err &
for _ in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/18080) 2>/dev/null && break; sleep 0.1; done
exec "$@"
