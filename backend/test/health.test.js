import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';

test('health endpoint responds', async () => {
  const server = createApp().listen(0);
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
