import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const document = readFileSync('docs/operations/viewer.md', 'utf8');
const plain = (text) => text.replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

function troubleshooting() {
  const lines = document.split('\n');
  const start = lines.findIndex((line) => /^#{2,6}\s+Troubleshooting startup\s*#*\s*$/.test(line));
  assert.notEqual(start, -1, 'Add a subsection titled Troubleshooting startup');
  const level = lines[start].match(/^#+/)[0].length;
  let end = start + 1;
  while (end < lines.length) {
    const heading = lines[end].match(/^(#{1,6})\s/);
    if (heading && heading[1].length <= level) break;
    end++;
  }
  const body = lines.slice(start + 1, end).join('\n');
  assert.ok(body.trim(), 'The troubleshooting subsection must contain guidance');
  return body;
}

const missingState = /(?:missing|nonexistent|non-existent|absent|does not exist|doesn't exist|not found)/i;
const occupiedPort = /(?:occupied|already in use|in use|unavailable|EADDRINUSE)/i;
const exitOne = /(?:exit(?:s|ed)?(?:\s+(?:with|status|code|an?|exit))*\s*[:=]?\s*1\b|exit(?:\s+status|\s+code)\s*(?:is|of|:)\s*1\b)/i;

test('troubleshooting explains both startup failures and exit status 1', () => {
  const text = plain(troubleshooting());
  assert.match(text, missingState, 'Explain the missing state failure in this subsection');
  assert.match(text, /state\s+director(?:y|ies)/i);
  assert.match(text, occupiedPort, 'Explain an occupied port in this subsection');
  assert.match(text, /port/i);
  assert.match(text, exitOne, 'Explicitly document exit status 1');
  // Each failure must either have its own exit-status explanation or be
  // included in a shared explanation (for example: both cases exit 1).
  const units = text.split(/(?<=[.!?;])\s+|\s*\|\s*/);
  const stateHasStatus = units.some((unit) => missingState.test(unit) && /state/i.test(unit) && exitOne.test(unit));
  const portHasStatus = units.some((unit) => occupiedPort.test(unit) && /port/i.test(unit) && exitOne.test(unit));
  const sharedStatus = /(?:both|either|these (?:cases|failures|errors)|each).*?exit(?:s)?(?:\s+(?:with|status|code))*\s*1\b/i.test(text);
  assert.ok((stateHasStatus && portHasStatus) || sharedStatus,
    'Associate exit 1 with both failures, not just one');
});

test('state recovery points to existing controller state without creating it', () => {
  const text = plain(troubleshooting());
  assert.match(text, /--state-dir/);
  assert.match(text, /(?:existing|already exists|already-existing)/i,
    'The remedy must use state that already exists');
  assert.match(text, /controller(?:['’]s)?\s+(?:state|.*?state\s+director)/i,
    'Identify the existing state as controller state');
  assert.match(text, /(?:point|set|use|specify|pass|select|supply|refer|provide|direct|locat)/i);
  assert.match(text, /(?:viewer.{0,100}(?:does not|doesn't|never|will not|won't).{0,40}creat|(?:does not|doesn't|never|will not|won't).{0,40}creat.{0,100}viewer)/i,
    'Explicitly explain that the viewer does not create the state directory');
});

test('port recovery includes a runnable alternate-port viewer command', () => {
  const body = troubleshooting();
  const text = plain(body);
  assert.match(text, /--port/);
  assert.match(text, /(?:another|different|alternate|alternative|unused|free|available)\s+(?:\w+\s+){0,3}port|port.{0,40}(?:another|different|alternate|unused|free|available)/i,
    'Tell the reader to select another port');
  const commands = body.replace(/\\\r?\n\s*/g, ' ').match(/node\s+server\/cli\.ts\s+viewer[^\n`]*/g) ?? [];
  assert.ok(commands.some((command) => {
    const port = command.match(/--port(?:\s+|=)(\d+)\b/);
    return /--state-dir\s+["']?\$\{?STATE\}?["']?(?:\s|$)/.test(command)
      && /--run\s+["']?\$\{?RUN_ID\}?["']?(?:\s|$)/.test(command)
      && port && Number(port[1]) > 0 && Number(port[1]) <= 65535 && Number(port[1]) !== 8080;
  }), 'Include a concrete alternate-port command with $STATE and $RUN_ID, such as port 8081');
});

test('existing startup and privacy guidance remains available', () => {
  const text = plain(document);
  assert.match(text, /Node\s+26\.12\.1\s+or later/i);
  assert.match(document, /node server\/cli\.ts viewer --state-dir "\$STATE" --run "\$RUN_ID" --port 8080/);
  assert.match(text, /viewer_ready bind=127\.0\.0\.1 port=8080/);
  assert.match(text, /(?:omit|without|optional).{0,35}--run.{0,100}(?:index|select)/i);
  assert.match(text, /64-character run digest/i);
  assert.match(text, /default port.{0,15}8080/i);
  assert.match(text, /invalid arguments exit 2/i);
  assert.match(text, /Ctrl\+C or SIGTERM/i);
  assert.match(text, /binds only to 127\.0\.0\.1/i);
  assert.match(text, /accepts GET only/i);
  assert.match(text, /same-origin Origin/i);
  assert.match(text, /no CORS headers/i);
  assert.match(text, /strict Content-Security-Policy/i);
  assert.match(text, /no action route, model call, GitHub call, or ledger writer/i);
  assert.match(text, /owner['’]s explicit approval/i);
  assert.match(text, /Do not forward the port merely because the viewer is read-only/i);
  assert.match(text, /private issue and session metadata/i);
  assert.match(text, /--allowed-host <machine>\.<tailnet>\.ts\.net/);
  assert.match(text, /tailscale serve/i);
  assert.match(text, /Verify the HTTPS Tailscale URL before sharing/i);
  assert.match(text, /never changes the loopback bind/i);
  assert.match(text, /no Tailscale dependency/i);
  assert.match(text, /viewer does not invoke Tailscale/i);
});
// factory-holdout-c88c3537575ceda3d1badb253fd26abee3dc9847b240060de74861fcf2e56ef7
