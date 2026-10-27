import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';
import {
  canonicalJson,
  containsSecretMarker,
  escapeCsvCell,
  hashCanonical,
  hashPassword,
  safeEqualString,
  verifyPassword,
} from './security.js';
import { parseRepositoryUrl } from './repoPreview.js';
import { validatePrepareInput, validateSubmitPayload } from './materials.js';
import { sha256Hex } from './security.js';

const baseEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://localhost/lab',
  APP_ORIGIN: 'http://127.0.0.1:5173',
  SESSION_SECRET: 'test-session-secret-32chars-minimum',
};

test('canonical JSON sorts keys, keeps array order, and has a stable hash', () => {
  const value = { z: 1, a: { d: true, c: [3, 2] }, m: null };
  assert.equal(canonicalJson(value), '{"a":{"c":[3,2],"d":true},"m":null,"z":1}');
  assert.equal(hashCanonical(value), '7c6e7fdd45ff7855691a0ab7de150a1d39db692293c8d49a86dbe0e6975bf2b8');
  assert.equal(canonicalJson({ b: 1, a: [2, 1] }), canonicalJson({ a: [2, 1], b: 1 }));
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson(Number.NaN));
  const proto = JSON.parse('{"z":1,"__proto__":{"protected":true}}') as Record<string, unknown>;
  assert.equal(canonicalJson(proto), '{"__proto__":{"protected":true},"z":1}');
  assert.equal(({} as { protected?: boolean }).protected, undefined);
});

test('secret markers ignore ordinary prose', () => {
  assert.equal(containsSecretMarker('Please describe private key management in prose.'), false);
  assert.equal(containsSecretMarker('the sky is blue and ask-me later'), false);
  assert.equal(containsSecretMarker('-----BEGIN PRIVATE KEY-----'), true);
  assert.equal(containsSecretMarker('token sk-abcdefghijklmnopqrstu'), true);
  assert.equal(containsSecretMarker('ghp_abcdefghijklmnopqrstuvwxyz'), true);
  assert.equal(containsSecretMarker('AKIAIOSFODNN7EXAMPLE'), true);
  assert.equal(containsSecretMarker('crsr_' + 'x'.repeat(64)), true);
  assert.equal(containsSecretMarker('sk-ant-abcdefghijklmnopqrstu'), true);
  assert.equal(containsSecretMarker('https://name:secret@example.test/repo'), true);
  assert.equal(containsSecretMarker('password = "exam-secret"'), true);
  assert.equal(containsSecretMarker('密码：exam-secret-123'), true);
  assert.equal(containsSecretMarker('讨论密码策略但不赋值'), false);
});

test('csv cells neutralize spreadsheet formulas', () => {
  assert.equal(escapeCsvCell('=1+1'), `"'=1+1"`);
  assert.equal(escapeCsvCell('+cmd'), `"'+cmd"`);
  assert.equal(escapeCsvCell('safe'), '"safe"');
  assert.equal(escapeCsvCell(' =1+1'), `"' =1+1"`);
  assert.equal(escapeCsvCell('say "hi"'), '"say ""hi"""');
});

test('repository URLs allow only public github and gitee', () => {
  assert.equal(parseRepositoryUrl('https://github.com/octocat/Hello-World.git').canonicalUrl, 'https://github.com/octocat/Hello-World');
  assert.equal(parseRepositoryUrl('https://github.com/octocat/Hello-World/tree/main').branch, 'main');
  assert.equal(parseRepositoryUrl('https://gitee.com/lab/demo').provider, 'gitee');
  for (const bad of [
    'http://github.com/a/b',
    'https://user:pass@github.com/a/b',
    'https://github.com/a/b?token=1',
    'https://1.2.3.4/a/b',
    'https://github.com.evil.com/a/b',
    'https://gist.github.com/a/b',
    'https://github.com/a/b/../../etc',
  ]) {
    assert.throws(() => parseRepositoryUrl(bad));
  }
});

test('passwords verify and reject malformed hashes', async () => {
  const encoded = await hashPassword('correct-horse-1');
  assert.equal(await verifyPassword('correct-horse-1', encoded), true);
  assert.equal(await verifyPassword('wrong-horse-1', encoded), false);
  assert.equal(await verifyPassword('correct-horse-1', 'nope'), false);
  assert.equal(safeEqualString('a', 'a'), true);
  assert.equal(safeEqualString('a', 'ab'), false);
});

test('production refuses demo seed and test mail', () => {
  assert.throws(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', SEED_DEMO: 'true' }));
  assert.throws(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', MAIL_TEST_SINK: 'true' }));
  assert.throws(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', SESSION_SECRET: 'short' }));
});

test('material payload hash covers sorted content and rejects paths or secrets', () => {
  const content = 'history for this exam only';
  const payload = {
    schemaVersion: 1,
    repoSha: 'a'.repeat(40),
    manifest: {
      collaborationSummary: 'pair work',
      projectSummary: 'lab task',
      clients: [{ name: 'cursor', models: [{ name: 'unknown', source: 'unknown', parameters: { reason: 'not reported' } }] }],
      files: [{
        coverage: 'partial',
        source: 'cursor-export',
        bytes: Buffer.byteLength(content),
        sha256: sha256Hex(content),
        name: 'history.txt',
      }],
    },
    files: [{ name: 'history.txt', content }],
  };
  const checked = validateSubmitPayload(payload);
  assert.equal(checked.sha256, hashCanonical(checked.payload));
  const prepared = validatePrepareInput({
    manifest: payload.manifest,
    payloadHash: checked.sha256,
    repoSha: payload.repoSha,
  });
  assert.equal(prepared.payloadHash, checked.sha256);
  assert.throws(() => validatePrepareInput({
    manifest: { ...payload.manifest, files: [{ ...payload.manifest.files[0], name: '../secret.txt' }] },
    payloadHash: checked.sha256,
    repoSha: payload.repoSha,
  }));
  assert.throws(() => validateSubmitPayload({
    ...payload,
    manifest: {
      ...payload.manifest,
      clients: [{ name: 'cursor', models: [{ name: 'unknown', source: 'unknown', parameters: null }] }],
    },
  }));
  assert.throws(() => validateSubmitPayload({
    ...payload,
    manifest: { ...payload.manifest, projectSummary: '   ' },
  }));
  assert.throws(() => validateSubmitPayload({
    ...payload,
    files: [{ name: 'history.txt', content: '-----BEGIN PRIVATE KEY-----\nabc' }],
    manifest: {
      ...payload.manifest,
      files: [{
        ...payload.manifest.files[0],
        bytes: Buffer.byteLength('-----BEGIN PRIVATE KEY-----\nabc'),
        sha256: sha256Hex('-----BEGIN PRIVATE KEY-----\nabc'),
      }],
    },
  }));
});
