import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const original = [
  '# Skills',
  '',
  "These are the factory's stage skills. The specify stage runs `audit-ticket`, `grill-me` and `deep-research`, in that order. Accept runs `acceptance` in a fresh sandbox session with the immutable contract and trusted base only. Build runs `build` with the applicable Feature or Bug fix playbook excerpt read from the pinned pstack dependency in that same bundle. It receives no suite or previous session. Review runs fresh sequential code-review, security-review and simplify seats, plus ultrareview for deterministic risk paths. The security seat alone has a refusal fallback.",
  '',
  '`server/provision.sh` copies every skill directory into the sandbox bundle at `skills/`, so the bundle digest in each stage receipt names the exact skill text that ran. The stage executor reads each `SKILL.md` from the bundle on the host and appends it to the stage prompt. The stage Pi runs with `--no-skills`, so it loads no other skill.',
  '',
  'Each skill sets `disable-model-invocation`, because it is a stage prompt and not a skill for an interactive session.',
  '',
  '| Skill | Upstream | License | `SOURCE.md` |',
  '| --- | --- | --- | --- |',
  "| `audit-ticket` | none, a clean-room rewrite | this repository's MIT | `audit-ticket/SOURCE.md` |",
  "| `acceptance` | none, clean-room scenario-holdout skill | this repository's MIT | `acceptance/SOURCE.md` |",
  "| `build` | factory protocol plus bundled pstack playbook | repository MIT and pstack's bundled license | `build/SOURCE.md` |",
  '| `grill-me` | `mattpocock/skills` `grilling` at `59db609` | MIT, Matt Pocock, `grill-me/LICENSE` | `grill-me/SOURCE.md` |',
  '| `code-review` | `anthropics/claude-plugins-official` at `f8c5e7a` | Apache-2.0, `code-review/LICENSE` | `code-review/SOURCE.md` |',
  '| `security-review` | `anthropics/claude-code-security-review` at `0c6a49f` | MIT, `security-review/LICENSE` | `security-review/SOURCE.md` |',
  '| `simplify` | none, written fresh | repository MIT | `simplify/SOURCE.md` |',
  '| `ultrareview` | none, written fresh | repository MIT | `ultrareview/SOURCE.md` |',
  '| `deep-research` | `mattpocock/skills` `research` at `59db609` | MIT, Matt Pocock, `deep-research/LICENSE` | `deep-research/SOURCE.md` |'
].join('\n');

function document() {
  return readFileSync('skills/README.md', 'utf8').replace(/\r\n/g, '\n');
}

function section() {
  const text = document();
  const headings = [...text.matchAll(/^(#{1,6})[ \t]+Human review[ \t]*#*[ \t]*$/gmi)];
  assert.equal(headings.length, 1, 'Provide one Markdown Human review section');
  const heading = headings[0];
  const start = heading.index;
  const bodyStart = start + heading[0].length;
  const rest = text.slice(bodyStart);
  const next = new RegExp('^#{1,' + heading[1].length + '}[ \\t]+', 'm').exec(rest);
  const end = next ? bodyStart + next.index : text.length;
  return { text, start, end, body: text.slice(bodyStart, end) };
}

function prose() {
  return section().body.replace(/[`*_]/g, '').replace(/[\u2010-\u2014]/g, '-').replace(/\s+/g, ' ').trim();
}

function sentences() {
  return prose().split(/(?<=[.!?;])\s+/);
}

function someSentence(patterns, message) {
  assert.ok(sentences().some(s => patterns.every(pattern => pattern.test(s))), message);
}

test('S1: a short Human review section is added', () => {
  const body = prose();
  assert.ok(body.length > 0, 'The heading must have explanatory prose');
  assert.ok(body.split(/\s+/).length <= 350, 'Keep the addition a short documentation section, not a new manual');
});

test('S2: sandboxed models lack GitHub writes; the trusted controller owns publication and progress', () => {
  someSentence([
    /sandbox(?:ed)?/i,
    /model|stages?/i,
    /github/i,
    /(?:no|without|lack\w*|not|cannot|can't|never|neither)\b/i,
    /writ(?:e|es|ing)|write authority|write access|write permissions?/i
  ], 'Explicitly deny GitHub write authority to sandboxed model stages');
  someSentence([
    /trusted controller/i,
    /publish|publication|publishing/i,
    /progress/i,
    /report|updat|summar/i
  ], 'Assign publication and progress reporting to the trusted controller');
  assert.doesNotMatch(prose(), /sandboxed model stages (?:have|retain|receive) (?:full |direct )?github write (?:authority|access)/i);
});

test('S3: exact-head CI and review precede the controller ready PR handoff', () => {
  const body = prose();
  assert.match(body, /exact[ -]head/i, 'Name the exact-head requirement, not just generic CI');
  assert.match(body, /\bCI\b/);
  assert.match(body, /\breview\b/i);
  assert.match(body, /\bpass(?:es|ed|ing)?\b|\bsucceed\w*\b|\bsuccessful\b|\bgreen\b/i);
  assert.match(body, /\bbefore\b|\bonly after\b|\bonce\b|\buntil\b|\bafter\b/i, 'State prerequisite ordering');
  assert.match(body, /\bcontroller\b/i);
  assert.match(body, /\bopen\w*\b|\bcreat\w*\b/i);
  assert.match(body, /\bPR\b|pull request/i);
  assert.match(body, /\bready\b/i);
  assert.match(body, /non[ -]draft|not (?:a )?draft/i);
  assert.match(body, /\bfactory:review\b/);
  assert.match(body, /label\w*/i, 'factory:review is the PR label');
  assert.doesNotMatch(body, /(?:open|create)\w*[^.!?]{0,60}\bPR\b[^.!?]{0,40}before[^.!?]{0,40}(?:CI|review) (?:passes|pass)/i, 'Do not reverse the required ordering');
});

test('S4: the factory waits for its owner and cannot merge or arm auto-merge', () => {
  const body = prose();
  assert.match(body, /\bfactory\b/i);
  assert.match(body, /\bwait\w*\b[^.!?]*\bowner\b|\bowner\b[^.!?]*\bwait\w*\b/i);
  someSentence([
    /never|does not|must not|will not|cannot|can't|neither/i,
    /\bmerge(?:s)?\b/i,
    /\barm\w*\b|\benabl\w*\b/i,
    /auto[ -]merge/i
  ], 'Explicitly prohibit both merging and arming auto-merge');
  assert.doesNotMatch(body, /factory (?:automatically merges|will merge|merges (?:the|a) PR|arms auto-merge)/i);
});

test('S5: an actual Markdown owner-guide link uses the required relative target', () => {
  const body = section().body;
  const links = [...body.matchAll(/\[([^\]\n]+)\]\(\s*(?:<\.\.\/docs\/operations\/human-review\.md>|\.\.\/docs\/operations\/human-review\.md)(?:\s+["'][^\n]*?["'])?\s*\)/g)];
  assert.ok(links.length > 0, 'Include a Markdown link to ../docs/operations/human-review.md');
  assert.ok(links.some(link => /owner/i.test(link[1]) || /owner/i.test(body.slice(Math.max(0, link.index - 160), link.index + link[0].length + 160))), 'Identify the linked document as the owner guide');
});

test('S7: existing descriptions, provenance table, licenses and links remain unchanged', () => {
  const { text, start, end } = section();
  const remainder = (text.slice(0, start) + text.slice(end)).trim();
  assert.equal(remainder, original, 'Only add the Human review section; preserve the original README content');
  const expectedTable = original.slice(original.indexOf('| Skill |'));
  const actualTable = text.split('\n').filter(line => line.startsWith('|')).join('\n');
  assert.equal(actualTable, expectedTable, 'Preserve every provenance/license table row and source link verbatim');
});
// factory-holdout-42a2e3b838ca9ef7e3cb663d276c1400a222dc2536e2f5d2be7c7315e47c4d6f
