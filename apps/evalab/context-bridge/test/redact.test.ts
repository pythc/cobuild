import assert from 'node:assert/strict';
import test from 'node:test';
import { containsSecretMarker, redactText } from '../src/redact.ts';

test('redacts credential markers and leaves ordinary prose', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----';
  const input = [
    'Please do not commit a private key or ask-the-user about sk-short.',
    pem,
    'token sk-abcdefghijklmnopqrstuvwxyz012345',
    'ghp_abcdefghijklmnopqrstuvwxyz012345',
    'AKIAIOSFODNN7EXAMPLE',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'set a password before the exam',
    '这个密码是什么意思',
    'password = "example-pass-123"',
    '密码：exam-secret-123',
    '密钥：hidden-key-1',
    '密钥管理说明',
    'sk-ant-abcdefghij',
    `crsr_${'x'.repeat(64)}`,
    'https://name:secret@example.test/repo',
    'https://example.test/public',
    '普通项目描述',
  ].join('\n');
  const redacted = redactText(input);
  assert.ok(redacted.redactions >= 5);
  assert.equal(containsSecretMarker(redacted.text), false);
  assert.match(redacted.text, /private key/);
  assert.match(redacted.text, /ask-the-user/);
  assert.match(redacted.text, /sk-short/);
  assert.match(redacted.text, /set a password before the exam/);
  assert.match(redacted.text, /这个密码是什么意思/);
  assert.match(redacted.text, /密钥管理说明/);
  assert.doesNotMatch(redacted.text, /BEGIN PRIVATE KEY/);
  assert.doesNotMatch(redacted.text, /sk-abcdefghijklmnopqrstuvwxyz012345/);
  assert.doesNotMatch(redacted.text, /ghp_abcdefghijklmnopqrstuvwxyz012345/);
  assert.doesNotMatch(redacted.text, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(redacted.text, /example-pass-123/);
  assert.doesNotMatch(redacted.text, /exam-secret-123/);
  assert.doesNotMatch(redacted.text, /hidden-key-1/);
  assert.doesNotMatch(redacted.text, /sk-ant-abcdefghij/);
  assert.doesNotMatch(redacted.text, /crsr_x/);
  assert.doesNotMatch(redacted.text, /name:secret@/);
  assert.match(redacted.text, /https:\/\/example\.test\/public/);
  assert.match(redacted.text, /普通项目描述/);
  assert.equal(containsSecretMarker(redacted.text), false);
});
