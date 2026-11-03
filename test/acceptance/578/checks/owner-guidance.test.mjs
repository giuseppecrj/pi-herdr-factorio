import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const expected = "## Merge or close as the owner\n\n1. Recheck the current head and required checks in GitHub. If you accept the patch, merge through your owner account. The factory has no merge command. A review approval is not itself a merge.\n2. If you reject the delivery, close the PR without merging. The controller records `cancelled`, not `landed`. A closed PR's non-null synthetic `merge_commit_sha` is not proof of a merge.\n3. After the next controller ticks, read status and the viewer again. A merge observation takes precedence over issue closure, label removal, switch holds, and working refresh state in every PR-backed phase, including restart. The controller stops captured work and reconciles known charges before terminal bookkeeping or workspace reuse. It records the actual merged head and merge SHA, with an unknown actor when GitHub supplies none, then closes the issue idempotently.\n\nCheck assurance separately from current readiness. A merged head with matching complete historical certification is `factory_verified`, even if another generation was refreshing. A merged head without a matching certificate is `owner_override`. Neither label proves the exact time at which GitHub changed relative to a later poll. F09b's durable ledger writer remains separate work.\n\nIf private candidate evidence is unavailable, preserve it as a gap. The narrow existing-PR observer can record a merge observation, but cannot reconstruct certification, accounts, terminal completion, or fresh budget from public markers.\n\n";

test('A5: the entire owner merge/close section is byte-for-byte preserved', () => {
  const bytes = readFileSync('docs/operations/human-review.md');
  const marker = Buffer.from('## Merge or close as the owner\n');
  const start = bytes.indexOf(marker);
  assert.ok(start >= 0, 'Keep the existing owner section');
  assert.equal(bytes.indexOf(marker, start + marker.length), -1, 'Do not duplicate the owner section');
  const next = bytes.indexOf(Buffer.from('\n## '), start + marker.length);
  assert.ok(next > start, 'Keep the following section boundary');
  const actual = bytes.subarray(start, next + 1);
  assert.deepEqual(actual, Buffer.from(expected), 'Do not alter any owner instructions, punctuation, whitespace, or section spacing');
});
// factory-holdout-81354c809058422c9340c45a07b75abd83d5602f1e607dddfcd3ad86a5126f08
