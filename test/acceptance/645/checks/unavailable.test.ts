import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli, EXIT } from '../../../../server/cli.ts';

test('missing accounting stays unavailable without a numeric total or state creation', async () => {
 const parent = await mkdtemp(join(tmpdir(), 'accept-status-unavailable-'));
 try {
  let stdout = '';
  let stderr = '';
  const code = await runCli(['status', '--json', '--repo', 'giuseppecrj/pi-herdr-factorio', '--state-dir', join(parent, 'missing')], {
   exec: async () => ({ code: 0, stdout: '', stderr: '' }),
   env: () => '/nonexistent',
   stdout: (text) => { stdout += text; },
   stderr: (text) => { stderr += text; },
  });
  assert.equal(code, EXIT.ok, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.accounting.state, 'unavailable');
  assert.deepEqual(report.durableUsage, { kind: 'unavailable', reason: 'legacy_not_recorded' });
  assert.equal(Object.hasOwn(report.durableUsage, 'total'), false);
  assert.equal(report.ledger.state, 'unreadable');
  assert.equal(report.ledger.pending, null);
  assert.deepEqual(await readdir(parent), []);
 } finally {
  await rm(parent, { recursive: true, force: true });
 }
});
// factory-holdout-8a2cb5408e0025ccb764d3e9f9f503b5ccbe9a69f4431242802e1fb6b0f73de1
