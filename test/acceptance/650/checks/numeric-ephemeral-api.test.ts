import assert from 'node:assert/strict';
import { test } from 'node:test';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startViewer } from '../../../../server/viewer.ts';

test('direct numeric port 0 still creates a working loopback ephemeral viewer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'viewer-ephemeral-api-'));
  let viewer;
  try {
    viewer = await startViewer({ stateDir: root, port: 0 });
    assert.ok(Number.isInteger(viewer.port));
    assert.ok(viewer.port >= 1 && viewer.port <= 65535);
    assert.equal(viewer.address, '127.0.0.1');
    const url = `http://127.0.0.1:${viewer.port}`;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    await response.text();
    // Use node:http so the explicit Host header reaches the server unchanged.
    const foreignStatus = await new Promise((resolve, reject) => {
      const req = request(url, { headers: { Host: 'evil.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(foreignStatus, 403);
  } finally {
    if (viewer) await viewer.close();
    await rm(root, { recursive: true, force: true });
  }
});
// factory-holdout-cf20ac17c1cba1436cbafaec1d86b706d589da2a3bfb53d36bb56e77c54aeddc
