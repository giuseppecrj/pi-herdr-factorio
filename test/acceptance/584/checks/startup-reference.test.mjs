import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guide = readFileSync('docs/operations/viewer.md', 'utf8');

function reference() {
  const headings = [...guide.matchAll(/^(#{2,6})[ \t]+Startup quick reference[ \t]*\r?$/gm)];
  assert.equal(headings.length, 1, 'one Startup quick reference subsection is required');
  const heading = headings[0];
  const views = guide.indexOf('\n## Read the four views');
  const openingEnd = guide.indexOf('The viewer never creates the state directory.');
  assert.ok(openingEnd >= 0, 'existing opening instructions remain present');
  assert.ok(heading.index > openingEnd + 'The viewer never creates the state directory.'.length, 'reference follows the opening paragraphs');
  assert.ok(views > heading.index, 'reference precedes Read the four views');
  const body = guide.slice(heading.index + heading[0].length, views);
  assert.doesNotMatch(body, /^#{1,6}\s/m, 'reference is a single subsection');
  return body;
}

test('startup quick reference is placed between the opening and the four views', () => {
  reference();
});

test('three list items give the binding, default port, and both failure exit statuses', () => {
  const body = reference();
  const items = [];
  for (const line of body.split(/\r?\n/)) {
    const start = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/);
    if (start) items.push(start[1]);
    else if (line.trim() && items.length) items[items.length - 1] += ' ' + line.trim();
  }
  assert.equal(items.length, 3, 'the reference lists three facts');
  const plain = items.map(item => item.replace(/[`*_]/g, '').replace(/\s+/g, ' '));
  const binding = plain.filter(item => /127\.0\.0\.1/.test(item) && /8080/.test(item));
  assert.equal(binding.length, 1, 'one item names the loopback address and port 8080');
  assert.match(binding[0], /only|loopback[- ]only/i, 'binding is explicitly loopback-only');
  assert.match(binding[0], /default/i, '8080 is described as the default');
  const unavailable = plain.filter(item => /missing state directory/i.test(item) && /occupied port/i.test(item));
  assert.equal(unavailable.length, 1, 'one item covers both missing state and occupied port');
  assert.match(unavailable[0], /\bexit(?:s|ing)?(?:\s+(?:with|code|status|of|an?))*\s*[:=]?\s*1\b/i, 'these startup failures exit 1');
  const invalid = plain.filter(item => /invalid (?:arguments|args)\b/i.test(item));
  assert.equal(invalid.length, 1, 'one item covers invalid arguments');
  assert.match(invalid[0], /\bexit(?:s|ing)?(?:\s+(?:with|code|status|of|an?))*\s*[:=]?\s*2\b/i, 'invalid arguments exit 2, not the operational-failure status');
  assert.notEqual(plain.indexOf(binding[0]), plain.indexOf(unavailable[0]));
  assert.notEqual(plain.indexOf(unavailable[0]), plain.indexOf(invalid[0]));
  assert.notEqual(plain.indexOf(binding[0]), plain.indexOf(invalid[0]));
});
// factory-holdout-81a0ac5e67324d0e2a3a394e69ac1dfe9f9bd0018ba60ba678d5c74c3a2b1110
