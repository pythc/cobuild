import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { canonicalJson, payloadHash, sha256Hex } from '../src/canonical.ts';

test('canonical JSON sorts object keys and keeps array order', () => {
  assert.equal(canonicalJson({ b: 1, a: 'x' }), '{"a":"x","b":1}');
  assert.equal(canonicalJson({ b: { d: 1, c: [1, { z: 1, y: 2 }] }, a: true }), '{"a":true,"b":{"c":[1,{"y":2,"z":1}],"d":1}}');
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
  assert.throws(() => canonicalJson({ a: 1, b: undefined }));
  assert.equal(canonicalJson({ a: null }), '{"a":null}');
  assert.equal(canonicalJson({ s: '你好' }), '{"s":"你好"}');
  const protoKey = JSON.parse('{"z":1,"__proto__":{"protected":true}}') as Record<string, unknown>;
  assert.equal(canonicalJson(protoKey), '{"__proto__":{"protected":true},"z":1}');
  assert.equal(({} as { protected?: unknown }).protected, undefined);
});

test('canonical hash is stable across key order and uses UTF-8', () => {
  const left = { b: 1, a: { d: '你好', c: [1, 2] } };
  const right = { a: { c: [1, 2], d: '你好' }, b: 1 };
  assert.equal(payloadHash(left), payloadHash(right));
  const encoded = canonicalJson(left);
  assert.equal(sha256Hex(encoded), createHash('sha256').update(Buffer.from(encoded, 'utf8')).digest('hex'));
  assert.throws(() => canonicalJson({ n: Number.NaN }));
});
