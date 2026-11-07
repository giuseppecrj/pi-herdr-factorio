import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { runViewerCli } from '../../../../server/viewer.ts';

const usage = 'Usage: node server/cli.ts viewer --state-dir <dir> [--run <id>] [--port <1-65535>] [--allowed-host <authorized.ts.net>] [--base-path </prefix>]\n';
const refusal = 'viewer refused: state unavailable, invalid host, or port in use\n';

for (const value of ['1', '8080', '65535']) {
  test(`valid decimal port ${value} reaches runtime startup`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'viewer-port-valid-'));
    try {
      const stdout = [];
      const stderr = [];
      const code = await runViewerCli(['--state-dir', join(root, 'missing'), '--port', value], {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      assert.notEqual(code, 2, 'valid port must not produce usage');
      assert.ok(code > 0, 'missing state directory must still refuse startup');
      assert.equal(stderr.join(''), refusal);
      assert.equal(stdout.join(''), '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const value of ['', 'abc', '0', '-1', '65536', '00000', '999999999999999999999999999999999999']) {
  test(`invalid decimal port ${JSON.stringify(value)} retains usage failure`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'viewer-port-range-'));
    try {
      const stdout = [];
      const stderr = [];
      const code = await runViewerCli(['--state-dir', join(root, 'missing'), `--port=${value}`], {
        stdout: (text) => stdout.push(text),
        stderr: (text) => stderr.push(text),
      });
      assert.equal(code, 2);
      assert.equal(stderr.join(''), usage);
      assert.equal(stdout.join(''), '');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
// factory-holdout-cf20ac17c1cba1436cbafaec1d86b706d589da2a3bfb53d36bb56e77c54aeddc
