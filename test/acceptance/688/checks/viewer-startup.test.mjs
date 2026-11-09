import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const paragraph = 'The viewer binds only to `127.0.0.1`. Its default port is 8080.';
const heading = '# Factory owner dashboard\n\n';
const originalDigest = 'e7b5a59ef00e2f1fdb3701774658a4014019b8c9d1de45d567787484e480d744';

function guide() {
  return readFileSync(resolve(process.cwd(), 'docs/operations/viewer.md'), 'utf8');
}

test('the exact quick reference is the first paragraph, with normal Markdown spacing', () => {
  const text = guide();
  const expectedStart = `${heading}${paragraph}\n\nStart the viewer from a repository checkout on Node 26.12.1 or later:\n\n\u0060\u0060\u0060bash\nnode server/cli.ts viewer --state-dir "$STATE" --port 8080\n\u0060\u0060\u0060\n`;
  assert.equal(text.slice(0, expectedStart.length), expectedStart,
    'Place the exact paragraph between the original heading and startup instructions, before the command block');
  assert.equal(text.split(paragraph).length - 1, 1,
    'Add the quick-reference paragraph exactly once');
});

test('the complete existing guide survives the insertion byte for byte', () => {
  const text = guide();
  const insertedPrefix = `${heading}${paragraph}\n\n`;
  const original = text.startsWith(insertedPrefix)
    ? heading + text.slice(insertedPrefix.length)
    : text;
  assert.equal(createHash('sha256').update(original, 'utf8').digest('hex'), originalDigest,
    'Removing only the requested insertion must recover the immutable original guide, including its startup, port, privacy and remaining sections');
});
// factory-holdout-1939dcfedc0321ccb8fed104cc55e528d30432e795fbfa1740fe235417070de7
