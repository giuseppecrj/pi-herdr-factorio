import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';

// Occupying 8080 checks the selected port without requiring a free listener.
const program = `
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const { runViewerCli } = await import(pathToFileURL(join(process.cwd(), 'server/viewer.ts')).href);
const holder = createServer();
await new Promise((resolve, reject) => {
  holder.once('error', (error) => error.code === 'EADDRINUSE' ? resolve() : reject(error));
  holder.listen(8080, '127.0.0.1', resolve);
});
const root = await mkdtemp(join(tmpdir(), 'viewer-port-default-'));
try {
  const stdout = [];
  const stderr = [];
  const argv = ['--state-dir', root];
  if (process.argv[1] !== 'omitted') argv.push('--port', process.argv[1]);
  const code = await runViewerCli(argv, {
    stdout: (text) => {
      stdout.push(text);
      // Cleanly stop a regression that selects a different free port.
      setImmediate(() => process.emit('SIGTERM'));
    },
    stderr: (text) => stderr.push(text),
  });
  console.log(JSON.stringify({ code, stdout, stderr }));
} finally {
  if (holder.listening) await new Promise((resolve, reject) => holder.close((error) => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
`;

for (const value of ['omitted', '08080', '00008080']) {
  test(`${value} selects decimal port 8080 through runViewerCli`, () => {
    const child = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', program, value], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.notEqual(result.code, 2, 'default and leading-zero ports must pass validation');
    assert.ok(result.code > 0, 'port 8080 is occupied, so startup must refuse');
    assert.deepEqual(result.stdout, [], 'must not listen on a different port');
    assert.deepEqual(result.stderr, ['viewer refused: state unavailable, invalid host, or port in use\n']);
  });
}
// factory-holdout-cf20ac17c1cba1436cbafaec1d86b706d589da2a3bfb53d36bb56e77c54aeddc
