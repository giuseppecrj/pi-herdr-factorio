#!/usr/bin/env bash
# Disposable, headless Herdr + Pi RPC experiment. Never print raw model/server logs.
set -euo pipefail
umask 077

if [[ ${1:-} != --isolated ]]; then
  : "${CLIPROXYAPI_BASE_URL:?required}" "${CLIPROXYAPI_API_KEY:?required}"
  root=$(mktemp -d /tmp/herdr-probe.XXXXXXXX)
  # In particular, do not inherit HERDR_SOCKET_PATH or PI_SUBAGENT_* from a caller.
  set +e
  env -i PATH="$PATH" HOME="$root/home" SHELL=/bin/bash TERM=xterm-256color \
    XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" \
    XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state" \
    XDG_RUNTIME_DIR="$root/runtime" PI_CODING_AGENT_DIR="$root/pi-agent" \
    HERDR_SESSION=factory-probe HERDR_ENV=1 PROBE_ROOT="$root" \
    CLIPROXYAPI_BASE_URL="$CLIPROXYAPI_BASE_URL" \
    CLIPROXYAPI_API_KEY="$CLIPROXYAPI_API_KEY" \
    bash "$(realpath "$0")" --isolated
  status=$?
  if [[ ${PROBE_KEEP:-0} == 1 ]]; then
    printf 'Private diagnostic directory retained: %s\n' "$root"
  else
    rm -rf -- "$root"
  fi
  exit "$status"
fi

: "${PROBE_ROOT:?internal invocation only}"
cd "$PROBE_ROOT"
mkdir -p "$HOME" "$XDG_CONFIG_HOME/herdr" "$XDG_RUNTIME_DIR" work
stage=install
started=$SECONDS
server_pid=
cleanup() {
  local result=$?
  trap - EXIT
  if [[ -n $server_pid ]]; then
    # The explicit named session AND isolated config keep this away from live Herdr.
    timeout 10s herdr --session factory-probe server stop >/dev/null 2>&1 || true
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if (( result != 0 )); then printf 'probe failed at stage=%s\n' "$stage"; fi
  printf 'probe total_seconds=%s\n' "$((SECONDS - started))"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ $(herdr --version) == 'herdr 0.9.5' ]]
# Use the npm distribution on both machines. The standalone Pi binary cannot
# locate the provider's physical pi-ai source after HOME is isolated.
npm install --prefix "$PROBE_ROOT/runtime-pi" --ignore-scripts \
  @earendil-works/pi-coding-agent@1.4.0 >install.log 2>&1
export PATH="$PROBE_ROOT/runtime-pi/node_modules/.bin:$PATH"
[[ $(pi --version) == 1.4.0 ]]
# Everything installed here is scoped to the disposable PI_CODING_AGENT_DIR.
pi install npm:@router-for-me/pi-cliproxyapi-provider@1.4.24 >>install.log 2>&1
pi install npm:pi-herdr-agents@3.3.1 >>install.log 2>&1
printf 'versions: pi=1.4.0 herdr=0.9.5 pi-herdr-agents=3.3.1 provider=1.4.24\n'

stage=server-start
printf '[terminal]\ndefault_shell = "/bin/bash"\nshell_mode = "non_login"\n' >"$XDG_CONFIG_HOME/herdr/config.toml"
herdr --session factory-probe server >server.log 2>&1 &
server_pid=$!
# Wait only for server readiness, not for agents. Child completion uses RPC events.
python3 - <<'PY'
import os, socket, time
from pathlib import Path
root = Path(os.environ['XDG_CONFIG_HOME']) / 'herdr' / 'sessions' / 'factory-probe'
deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    try:
        with socket.socket(socket.AF_UNIX) as s:
            s.connect(str(root / 'herdr.sock'))
        break
    except OSError:
        time.sleep(0.1)
else:
    raise SystemExit('isolated server socket not ready within 20s')
PY
herdr --session factory-probe workspace create --cwd "$PROBE_ROOT/work" \
  --label probe --no-focus >workspace.json 2>workspace.err
pane=$(python3 -c 'import json; print(json.load(open("workspace.json"))["result"]["root_pane"]["pane_id"])')
printf 'headless server ready; setup_seconds=%s\n' "$((SECONDS - started))"

# This client runs INSIDE the Herdr pane. RPC keeps the parent alive after the
# launch acknowledgement, so its extension can deliver the asynchronous result.
cat >parent.py <<'PY'
import json
import os
import selectors
import subprocess
import time
from pathlib import Path

root = Path(os.environ['PROBE_ROOT'])
model = 'cliproxyapi/claude-haiku-5-5'
args = dict(name='herdr-test', model=model, thinking='low', fork=False,
            tools='read', cwd=str(root / 'work'),
            task='Reply with exactly herdr-child-ok and nothing else. Do not call tools, spawn agents, edit files, or commit.')
prompt = ('Call subagent exactly ONCE with these arguments: ' + json.dumps(args) +
          '. Do not call any other tool. After the launch acknowledgement end your turn. '
          'The child result will arrive automatically; do not poll. Only after receiving '
          'the subagent_result message, reply exactly: herdr-parent-received')
launches = 0
received = False
acknowledged = False
failure = 'rpc-timeout'
proc = None
try:
    assert os.environ['HERDR_ENV'] == '1'
    assert os.environ['HERDR_SOCKET_PATH'].startswith(str(root))
    assert os.environ['HERDR_PANE_ID']
    with (root / 'parent.stderr').open('wb') as err, (root / 'events.jsonl').open('wb') as log:
        proc = subprocess.Popen([
            'pi', '--mode', 'rpc', '--no-approve', '--no-mcp', '--no-skills',
            '--no-context-files', '--tools', 'subagent', '--model', model,
            '--thinking', 'low', '--session-dir', str(root / 'parent-sessions'),
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)
        proc.stdin.write(json.dumps(dict(type='prompt', id='probe', message=prompt)).encode() + b'\n')
        proc.stdin.flush()
        selector = selectors.DefaultSelector()
        selector.register(proc.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + 180
        buffer = b''
        while not acknowledged:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not selector.select(remaining):
                break
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                failure = 'parent-exited'
                break
            log.write(chunk)
            log.flush()
            buffer += chunk
            while b'\n' in buffer:
                line, buffer = buffer.split(b'\n', 1)
                event = json.loads(line)
                if event.get('type') == 'tool_execution_start':
                    launches += 1
                    assert launches == 1 and event['toolName'] == 'subagent', 'unexpected-tool-call'
                    assert event['args'] == args, 'unexpected-child-arguments'
                if event.get('type') == 'tool_execution_end':
                    assert not event.get('isError'), 'subagent-launch-error'
                if event.get('type') != 'message_end':
                    continue
                message = event['message']
                if message.get('customType') == 'subagent_result':
                    details = message['details']
                    assert details.get('name') == 'herdr-test', 'unexpected-child-name'
                    assert not details.get('error'), 'child-failed'
                    assert details.get('exitCode') == 0, 'child-exit-code'
                    # Inspect the completed child once. Never poll its session file.
                    child_path = Path(details['sessionFile']).resolve()
                    assert child_path.is_relative_to(root), 'child-outside-isolation'
                    entries = [json.loads(x) for x in child_path.read_text().splitlines() if x]
                    messages = [x['message'] for x in entries if x.get('type') == 'message']
                    assistants = [m for m in messages if m.get('role') == 'assistant']
                    child = assistants[-1]
                    text = ''.join(b.get('text', '') for b in child['content'] if b['type'] == 'text')
                    assert text.strip() == 'herdr-child-ok', 'child-token-mismatch'
                    assert child['provider'] + '/' + child['model'] == model, 'child-model-mismatch'
                    assert not any(b['type'] == 'toolCall' for m in assistants for b in m['content']), 'child-called-tools'
                    assert 'herdr-child-ok' in details['resultContent'], 'delivery-token-mismatch'
                    received = True
                if message.get('role') == 'assistant':
                    assert message.get('stopReason') not in ('error', 'aborted'), 'parent-model-error'
                    text = ''.join(b.get('text', '') for b in message['content'] if b['type'] == 'text')
                    if received and text.strip() == 'herdr-parent-received':
                        acknowledged = True
        if acknowledged and received and launches == 1:
            (root / 'verified').write_text('verified\n')
        else:
            (root / 'failure').write_text(failure + '\n')
except Exception as exc:
    # Only fixed assertion labels leave the private directory, not provider errors.
    label = str(exc) if isinstance(exc, AssertionError) else type(exc).__name__
    (root / 'failure').write_text(label + '\n')
finally:
    if proc is not None:
        proc.stdin.close()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
    print('herdr-probe-finished', flush=True)
PY
stage=parent-child
herdr --session factory-probe pane run "$pane" "python3 '$PROBE_ROOT/parent.py'" >run.json 2>run.err
# No model text is printed by this wait; raw pane snapshots stay private.
herdr --session factory-probe pane wait-output "$pane" --match herdr-probe-finished \
  --timeout 210000 >wait.json 2>wait.err
if [[ -f verified ]]; then
  printf 'VERIFIED: parent received subagent_result containing herdr-child-ok\n'
  printf 'checks: one bare child; requested model; exit=0; child session token; parent acknowledgement\n'
else
  # failure contains only a driver-owned label; all raw logs are deleted on exit.
  if [[ -f failure ]]; then printf 'driver failure: %s\n' "$(<failure)"; fi
  exit 1
fi
