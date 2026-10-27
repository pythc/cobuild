import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { sha256Hex } from '../src/canonical.ts';
import { assertPayloadCoherent } from '../src/payload.ts';
import type { MaterialPayload } from '../src/types.ts';

test('payload accepts unicode file names and rejects empty clients or a short repo SHA', () => {
  const content = '会话正文\n';
  const name = '会话记录.txt';
  const payload = sample(name, content, 'a'.repeat(40));
  assert.equal(typeof assertPayloadCoherent(payload), 'string');
  assert.throws(() => assertPayloadCoherent({ ...payload, repoSha: 'a'.repeat(39) }));
  assert.doesNotThrow(() => assertPayloadCoherent({ ...payload, repoSha: 'b'.repeat(64) }));
  assert.throws(() => assertPayloadCoherent({
    ...payload,
    manifest: { ...payload.manifest, clients: [] },
  }));
  assert.throws(() => assertPayloadCoherent({
    ...payload,
    manifest: {
      ...payload.manifest,
      clients: [{ name: 'x'.repeat(121), models: [{ name: 'gpt', source: 'reported' }] }],
    },
  }));
  const parameters: Record<string, string> = {};
  for (let index = 0; index < 21; index += 1) parameters[`k${index}`] = 'v';
  assert.throws(() => assertPayloadCoherent({
    ...payload,
    manifest: {
      ...payload.manifest,
      clients: [{ name: 'Cursor', models: [{ name: 'gpt', source: 'reported', parameters }] }],
    },
  }));
  assert.throws(() => assertPayloadCoherent(sample('../secret.txt', content, 'a'.repeat(40))));
});

function sample(name: string, content: string, repoSha: string): MaterialPayload {
  const sha256 = sha256Hex(content);
  return {
    schemaVersion: 1,
    repoSha,
    manifest: {
      files: [{ name, sha256, bytes: Buffer.byteLength(content), source: 'cursor-export', coverage: 'partial' }],
      clients: [{ name: 'Cursor', models: [{ name: 'UNKNOWN', source: 'unknown', parameters: { reason: 'not in export' } }] }],
      projectSummary: '项目摘要',
      collaborationSummary: '协作摘要',
    },
    files: [{ name, content }],
  };
}
