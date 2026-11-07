import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { readRunCharges } = await import(pathToFileURL(join(process.cwd(), 'server/controller.ts')).href);
const { unknownEfficiency } = await import(pathToFileURL(join(process.cwd(), 'server/sandbox/result.ts')).href);
const runId = 'b'.repeat(64);
test('status accounting exposes exact JSON token totals for complete coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'held-status-exact-'));
  try {
    for (const [stage, attempt, total] of [['specify', 1, 11], ['accept', 1, 12], ['accept', 2, 7]]) {
      const dir = join(root, 'stages', runId, `${stage}-${attempt}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'receipt.json'), JSON.stringify({ version: 1, runId, stage, attempt, outcome: { kind: 'passed' }, turns: 1, wallMs: 10, usage: { total, parent: total, children: 0, gateway: total, unreadChildren: 0, byModel: {} }, efficiency: unknownEfficiency() }));
    }
    for (const floor of [0, 30]) {
      const status = JSON.parse(JSON.stringify(await readRunCharges(root, runId, floor)));
      assert.deepEqual(status.tokens, { kind: 'exact', unit: 'tokens', total: 30 });
      assert.equal(status.runId, runId);
      assert.equal(status.executions, 3);
      assert.equal(status.readable, true);
      assert.equal(status.uncertainRequests, 0);
      assert.ok(Object.hasOwn(status, 'attempts'));
      assert.ok(Object.hasOwn(status, 'terminal'));
      assert.deepEqual(status.money, { kind: 'unavailable', reason: 'provider_not_reported' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
// factory-holdout-7120eed3548cc0d61704c6e850774bbe2f79231cdcba57d898e68ed27839abc5
