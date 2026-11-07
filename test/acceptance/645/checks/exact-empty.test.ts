import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli, EXIT } from '../../../../server/cli.ts';

test('available accounting with no runs has the exact zero sum and status is read-only', async () => {
 const state = await mkdtemp(join(tmpdir(), 'accept-status-exact-'));
 try {
  const before = await readdir(state);
  let stdout = '';
  let stderr = '';
  const code = await runCli(['status', '--json', '--repo', 'giuseppecrj/pi-herdr-factorio', '--state-dir', state], {
   exec: async () => ({ code: 0, stdout: '', stderr: '' }),
   env: () => '/nonexistent',
   stdout: (text) => { stdout += text; },
   stderr: (text) => { stderr += text; },
  });
  assert.equal(code, EXIT.ok, stderr);
  const report = JSON.parse(stdout);
  assert.notEqual(report.accounting.state, 'unavailable');
  assert.deepEqual(report.accounting.runs, []);
  assert.deepEqual(report.durableUsage, { kind: 'exact', unit: 'tokens', total: 0 });
  assert.equal(Object.hasOwn(report.durableUsage, 'reason'), false);
  assert.deepEqual(await readdir(state), before);
 } finally {
  await rm(state, { recursive: true, force: true });
 }
});
// factory-holdout-8a2cb5408e0025ccb764d3e9f9f503b5ccbe9a69f4431242802e1fb6b0f73de1
