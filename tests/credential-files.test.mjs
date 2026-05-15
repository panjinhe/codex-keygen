import test from 'node:test';
import assert from 'node:assert/strict';
import {
  credentialFilename,
  safeCredentialBasename,
} from '../lib/credential-files.mjs';

test('credentialFilename uses email when present', () => {
  assert.equal(
    credentialFilename({ email: 'User.Name+codex@outlook.com', account_id: 'acct_123' }),
    'User.Name+codex@outlook.com.json',
  );
});

test('credentialFilename falls back to account id and sanitizes invalid path characters', () => {
  assert.equal(
    credentialFilename({ account_id: 'acct:123/456' }),
    'acct_123_456.json',
  );
});

test('safeCredentialBasename removes unsafe blank and dot-only names', () => {
  assert.equal(safeCredentialBasename('  ...  '), 'codex-credential');
  assert.equal(safeCredentialBasename('bad<name>|x'), 'bad_name__x');
});
