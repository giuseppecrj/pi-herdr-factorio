import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { readTerminalEvidence } = await import(pathToFileURL(join(process.cwd(), 'server/controller.ts')).href);
const { unknownEfficiency } = await import(pathToFileURL(join(process.cwd(), 'server/sandbox/result.ts')).href);
const runId = 'a'.repeat(64);
async function receipt(root, stage, attempt, total) {
  const dir = join(root, 'stages', runId, `${stage}-${attempt}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'receipt.json'), JSON.stringify({ version: 1, runId, stage, attempt, outcome: { kind: 'passed' }, turns: 1, wallMs: 10, usage: { total, parent: total, children: 0, gateway: total, unreadChildren: 0, byModel: {} }, efficiency: unknownEfficiency() }));
}
test('complete validated receipts make every stage and run token total exact without changing totals', async () => {
  const root = await mkdtemp(join(tmpdir(), 'held-ledger-exact-'));
  try {
    await receipt(root, 'specify', 1, 11);
    await receipt(root, 'accept', 1, 12);
    await receipt(root, 'accept', 2, 7);
    for (const floor of [0, 30]) {
      const evidence = await readTerminalEvidence(root, runId, floor, null);
      assert.deepEqual(evidence.usage.tokens, { kind: 'exact', unit: 'tokens', total: 30 });
      assert.equal(evidence.stages.kind, 'known');
      const stages = new Map(evidence.stages.value.map(s => [s.stage, s]));
      assert.equal(stages.size, 2);
      for (const [stage, total, wall] of [['specify', 11, 10], ['accept', 19, 20]]) {
        assert.deepEqual(stages.get(stage).tokens, { kind: 'exact', unit: 'tokens', total });
        assert.deepEqual(stages.get(stage).wallMs, { kind: 'exact', unit: 'milliseconds', total: wall });
      }
      assert.deepEqual(evidence.usage.parentTokens, { kind: 'known', value: 30 });
      assert.deepEqual(evidence.usage.childTokens, { kind: 'known', value: 0 });
      assert.deepEqual(evidence.usage.money, { kind: 'unavailable', reason: 'provider_not_reported' });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
// factory-holdout-7120eed3548cc0d61704c6e850774bbe2f79231cdcba57d898e68ed27839abc5
