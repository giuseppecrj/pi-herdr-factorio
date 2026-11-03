import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guide = readFileSync('docs/operations/human-review.md', 'utf8');
function subsection() {
  const matches = [...guide.matchAll(/^#{2,6} Refused before build\r?$/gm)];
  assert.equal(matches.length, 1, 'A1: exactly one Refused before build subsection');
  const match = matches[0];
  const tail = guide.slice(match.index + match[0].length);
  const next = /^#{1,6} .+$/m.exec(tail);
  assert.ok(next, 'A1: a following heading exists');
  assert.equal(next[0].trim(), '## Merge or close as the owner', 'A1: owner merge/close is the immediately following section');
  return tail.slice(0, next.index).replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
}

test('A1: refusal subsection immediately precedes owner merge/close', () => {
  assert.ok(subsection().length > 0, 'the subsection contains an explanation');
});

test('A2: unchanged-base private-check refusal fails before build without a PR', () => {
  const text = subsection();
  assert.match(text, /refus(?:al|e[ds]?|ing)/i, 'describes refusal');
  assert.match(text, /private acceptance checks/i, 'identifies the private acceptance checks');
  assert.match(text, /unchanged base/i, 'identifies the unchanged base');
  assert.match(text, /\bfailed\b/, 'names the terminal failed state');
  assert.match(text, /\brun\b/i, 'identifies the run whose state changes');
  assert.match(text, /(?:before\s+(?:any\s+|the\s+)?build(?:\s+(?:starts|begins))?|(?:no|without(?:\s+any)?)\s+build(?:\s+(?:starts|begins|starting))?)/i, 'failure precedes building');
  assert.match(text, /(?:\bno\s+(?:(?:new|factory)\s+)?(?:PR|pull request)\b|\b(?:does not|doesn't|will not|won't|never)\s+open\s+(?:a\s+|any\s+)?(?:PR|pull request)\b|\bwithout\s+(?:opening\s+)?(?:a\s+|any\s+)?(?:PR|pull request)\b)/i, 'no PR is opened');
});

test('A3: one keyed issue comment discloses only a fixed reason and scenario IDs', () => {
  const text = subsection();
  assert.match(text, /\bissue\b/i, 'comment destination is the issue');
  assert.match(text, /\b(?:one|single|exactly one)\b/i, 'one comment, not repeated comments');
  assert.match(text, /\bkeyed\b/i, 'comment is keyed');
  assert.match(text, /factory-base-refusal/, 'correct comment key');
  assert.match(text, /\bcomment\b/i);
  assert.match(text, /\bfixed reason\b/i);
  assert.match(text, /\bscenario IDs\b/i);
  assert.match(text, /\bonly\b/i, 'reason and scenario IDs are the only disclosed content');
});
// factory-holdout-cec13a9dd87602b658b6b4c2e29504a1647515e06d9ca0298671e40eb0fabe92
