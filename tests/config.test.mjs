import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('batch login UI is serialized for CPA safety', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../codex-keygen.mjs', import.meta.url), 'utf8');

  assert.match(html, /id="workers"[^>]*max="1"[^>]*disabled/);
  assert.match(app, /workers:\s*1/);
  assert.match(server, /const MAX_LOGIN_WORKERS = 1;/);
  assert.match(server, /launchIsolatedAuthBrowser/);
});
