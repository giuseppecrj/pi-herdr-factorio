import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { runViewerCli } from '../../../../server/viewer.ts';

const usage = 'Usage: node server/cli.ts viewer --state-dir <dir> [--run <id>] [--port <1-65535>] [--allowed-host <authorized.ts.net>] [--base-path </prefix>]\n';

for (const value of ['0x1F90', '1e4', ' 8080 ', '8080.0', '+8080', '0o17620', '0b1111110010000', '\t8080', '8080\n', '.8080', '８０８０', '٨٠٨٠']) {
  test(`CLI rejects non-decimal spelling ${JSON.stringify(value)} before startup`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'viewer-port-reject-'));
    try {
      const stdout = [];
      const stderr = [];
      // Missing state makes an erroneous validation pass finish without a listener.
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
