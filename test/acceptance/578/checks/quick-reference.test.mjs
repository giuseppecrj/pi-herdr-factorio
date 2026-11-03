import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const guide = readFileSync('docs/operations/human-review.md', 'utf8');
const intro = "# Review and merge a factory PR\n\nUse this guide to inspect a factory handoff, decide whether to merge, and confirm the controller recorded your action. The factory never merges or arms auto-merge. Approval alone does not resume an automatic merge path.\n\nF09a implements this protocol locally. Main-backed reporter/P4 proof, production protection, real owner-action lanes, and live/performance qualification remain pending. A source check, scratch GitHub experiment, or saved-state test is not a certified factory run. See the [plan's F09a gates](../plans/factory-v1.md#hand-off-verified-prs-and-require-human-merge-f09a) and [formal proof limits](../statecharts/README.md).\n\n";
const heading = /^## Quick reference$/gm;
const matches = [...guide.matchAll(heading)];
const start = matches[0]?.index ?? -1;
const after = start < 0 ? '' : guide.slice(start + '## Quick reference'.length);
const nextHeading = after.search(/^## /m);
const section = start < 0 ? '' : (nextHeading < 0 ? after : after.slice(0, nextHeading));
const plain = section.replace(/`/g, '').replace(/\s+/g, ' ').trim();
const items = section.split(/^\s*[-*+]\s+|^\s*\d+[.)]\s+/m).slice(1).map(s => s.trim());

 test('A1: Quick reference follows both unchanged introductory paragraphs and precedes the handoff', () => {
  assert.equal(matches.length, 1, 'There must be exactly one level-two Quick reference heading');
  assert.ok(guide.startsWith(intro), 'Preserve the two introductory paragraphs');
  assert.ok(start >= intro.length, 'Place the quick reference after the introductory paragraphs');
  const inspect = guide.indexOf('\n## Inspect the handoff\n');
  assert.ok(inspect > start, 'Place the quick reference before Inspect the handoff');
  assert.match(after.slice(nextHeading < 0 ? after.length : nextHeading), /^## Inspect the handoff\n/, 'The next section must be the existing handoff guide');
  assert.equal(items.length, 3, 'The short reference must contain three factual list items');
  assert.equal(section.split(/^\s*[-*+]\s+|^\s*\d+[.)]\s+/m)[0].trim(), '', 'Use list items rather than an extra prose introduction');
});

 test('A2: the quick reference identifies factory PR branches and their review label', () => {
  assert.ok(section.includes('factory/pr/<issue>-<runId12>'), 'Include the exact branch pattern');
  assert.ok(section.includes('factory:review'), 'Include the exact review label');
  assert.match(plain, /\bPRs?\b/i);
  assert.match(plain, /\bbranch(?:es)?\b/i);
  assert.match(plain, /\blabel(?:ed|led|s)?\b/i);
});

 test('A3: the quick reference requires both checks on the exact PR head before merge', () => {
  const item = items.find(s => /`?check`?/.test(s) && s.includes('factory-gates')) ?? '';
  const text = item.replace(/`/g, '').replace(/\s+/g, ' ');
  assert.match(text, /\bcheck\b/, 'Name the ordinary check');
  assert.match(text, /\bfactory-gates\b/, 'Name the factory gate');
  assert.match(text, /\bpass(?:ed|ing)?\b/i, 'Require passing checks, not merely their presence');
  assert.match(text, /\b(?:must|required|require|requires|only)\b/i, 'Make passing mandatory');
  assert.match(text, /\bexact\s+(?:current\s+)?PR\s+head\b/i, 'Bind both checks to the exact PR head');
  assert.match(text, /\b(?:both|and)\b/i, 'Require both checks');
  assert.match(text, /\b(?:before\s+(?:you\s+)?(?:merge|merging)|merge\s+only|only\s+merge|merging\s+requires)\b/i, 'Make the checks a precondition of merging');
});

 test('A4: the quick reference reserves merging for humans and distinguishes cancellation from landing', () => {
  assert.match(plain, /\bfactory\s+never\s+merges\b/i);
  assert.match(plain, /\bclos(?:e|es|ed|ing)\b[^.!?]*\bwithout\s+merging\b/i);
  assert.match(plain, /\brecord(?:s|ed)?\b[^.!?]*\bcancelled\b[^.!?]*\bnot\s+landed\b/i);
});
// factory-holdout-81354c809058422c9340c45a07b75abd83d5602f1e607dddfcd3ad86a5126f08
