import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { readTerminalEvidence, readRunCharges } = await import(pathToFileURL(join(process.cwd(), 'server/controller.ts')).href);
const { unknownEfficiency } = await import(pathToFileURL(join(process.cwd(), 'server/sandbox/result.ts')).href);
const runId = 'c'.repeat(64);
const usage = total => ({ total, parent: total, children: 0, gateway: total, unreadChildren: 0, byModel: {} });
const receipt = (stage, total) => ({ version: 1, runId, stage, attempt: 1, outcome: { kind: 'passed' }, turns: 1, wallMs: 10, usage: usage(total), efficiency: unknownEfficiency() });
async function save(root, name, file, value) {
  const dir = join(root, 'stages', runId, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, file), typeof value === 'string' ? value : JSON.stringify(value));
}
async function fixture(body) {
  const root = await mkdtemp(join(tmpdir(), 'held-conservative-'));
  try {
    await save(root, 'specify-1', 'receipt.json', receipt('specify', 11));
    await body(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function both(root, floor, expected) {
  const evidence = await readTerminalEvidence(root, runId, floor, null);
  const status = JSON.parse(JSON.stringify(await readRunCharges(root, runId, floor)));
  assert.deepEqual(evidence.usage.tokens, expected);
  assert.deepEqual(status.tokens, expected);
  return evidence;
}
test('missing receipt retains known usage and lower-bound classification in ledger and status', async () => {
  await fixture(async root => {
    await save(root, 'accept-1', 'usage.json', { version: 1, runId, stage: 'accept', attempt: 1, startedAt: 200, deadline: 1000, turns: 1, usage: usage(3), efficiency: unknownEfficiency() });
    await save(root, 'accept-1', 'egress.requests.jsonl', [{ kind: 'dispatch', req: 1 }, { kind: 'result', req: 1, inputTokens: 2, outputTokens: 1 }].map(JSON.stringify).join('\n') + '\n');
    const evidence = await both(root, 0, { kind: 'lower_bound', unit: 'tokens', total: 14, reason: 'receipt_missing' });
    const stage = evidence.stages.value.find(s => s.stage === 'accept');
    assert.deepEqual(stage.tokens, { kind: 'lower_bound', unit: 'tokens', total: 3, reason: 'receipt_missing' });
    assert.deepEqual(stage.wallMs, { kind: 'lower_bound', unit: 'milliseconds', total: 0, reason: 'receipt_missing' });
  });
});
test('unsettled requests take precedence over missing receipt coverage', async () => {
  await fixture(async root => {
    await save(root, 'accept-1', 'usage.json', { version: 1, runId, stage: 'accept', attempt: 1, startedAt: 200, deadline: 1000, turns: 1, usage: usage(3), efficiency: unknownEfficiency() });
    await save(root, 'accept-1', 'egress.requests.jsonl', [{ kind: 'dispatch', req: 1 }, { kind: 'result', req: 1, inputTokens: 2, outputTokens: 1 }, { kind: 'dispatch', req: 2, inputTokenEstimate: 4, maxOutputTokens: 5 }].map(JSON.stringify).join('\n') + '\n');
    const evidence = await both(root, 0, { kind: 'uncertain', unit: 'tokens', total: 23, reason: 'request_unsettled' });
    assert.deepEqual(evidence.stages.value.find(s => s.stage === 'accept').tokens, { kind: 'uncertain', unit: 'tokens', total: 12, reason: 'request_unsettled' });
    await both(root, 40, { kind: 'uncertain', unit: 'tokens', total: 40, reason: 'request_unsettled' });
  });
});
test('recorded floor above fully covered receipt totals is retained and not exact', async () => {
  await fixture(async root => {
    await both(root, 50, { kind: 'lower_bound', unit: 'tokens', total: 50, reason: 'receipt_missing' });
  });
});
for (const [label, invalid] of [
  ['malformed JSON', '{'],
  ['invalid shape', '{}'],
  ['wrong run', JSON.stringify({ ...receipt('accept', 0), runId: 'd'.repeat(64) })],
  ['wrong stage', JSON.stringify(receipt('build', 0))],
  ['wrong version', JSON.stringify({ ...receipt('accept', 0), version: 2 })]
]) {
  test(`invalid receipt remains conservative: ${label}`, async () => {
    await fixture(async root => {
      await save(root, 'accept-1', 'receipt.json', invalid);
      const evidence = await both(root, 11, { kind: 'lower_bound', unit: 'tokens', total: 11, reason: 'receipt_missing' });
      assert.deepEqual(evidence.stages.value.find(s => s.stage === 'accept').tokens, { kind: 'lower_bound', unit: 'tokens', total: 0, reason: 'receipt_missing' });
    });
  });
}
// factory-holdout-7120eed3548cc0d61704c6e850774bbe2f79231cdcba57d898e68ed27839abc5
