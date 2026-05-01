import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractVerificationCode,
  parseAccountText,
  toSafeImportedRow,
} from '../lib/account-utils.mjs';

test('parseAccountText supports fixed import formats', () => {
  const parsed = parseAccountText([
    'alice@example.com | openai-pass',
    'bob@example.com | openai-pass | mailbox-pass',
    'carol@example.com | openai-pass | carol-mail@example.com | mailbox-pass',
    'dave@example.com | openai-pass | dave-mail@example.com | mailbox-pass | imap.example.com | 993',
  ].join('\n'));

  assert.equal(parsed.rows.length, 4);
  assert.equal(parsed.invalid.length, 0);
  assert.equal(parsed.rows[0].mailboxEmail, 'alice@example.com');
  assert.equal(parsed.rows[1].mailboxPassword, 'mailbox-pass');
  assert.equal(parsed.rows[2].mailboxEmail, 'carol-mail@example.com');
  assert.equal(parsed.rows[3].imapHost, 'imap.example.com');
  assert.equal(parsed.rows[3].imapPort, 993);
});

test('parseAccountText reports invalid and duplicate rows', () => {
  const parsed = parseAccountText([
    'bad-line',
    'alice@example.com | pass',
    'alice@example.com | pass2',
  ].join('\n'));

  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.invalid.length, 1);
  assert.equal(parsed.duplicates.length, 1);
});

test('safe import rows do not include plaintext passwords or raw lines', () => {
  const parsed = parseAccountText('alice@example.com | openai-secret | mailbox-secret');
  const safe = toSafeImportedRow(parsed.rows[0]);

  assert.equal('rawLine' in safe, false);
  assert.equal('openaiPassword' in safe, false);
  assert.equal('mailboxPassword' in safe, false);
  assert.match(safe.openaiPasswordMasked, /^\*|o/);
  assert.equal(safe.hasMailboxPassword, true);
});

test('extractVerificationCode prefers auth context', () => {
  assert.equal(extractVerificationCode('Your OpenAI verification code is 123456'), '123456');
  assert.equal(extractVerificationCode('验证码：654321，请勿分享'), '654321');
  assert.equal(extractVerificationCode('Invoice 202604 and code 777888'), '777888');
  assert.equal(extractVerificationCode('No code here'), '');
});
