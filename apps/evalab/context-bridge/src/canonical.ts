import { createHash } from 'node:crypto';

const MAX_DEPTH = 32;

/**
 * Canonical JSON: object keys sorted lexicographically at every depth,
 * array order preserved, UTF-8. Undefined values are rejected so the hash
 * matches server/src/security.ts canonicalJson.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, 0));
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function payloadHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function canonicalize(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error('canonical JSON rejects deep nesting');
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON rejects non-finite numbers');
    return value;
  }
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new Error('canonical JSON rejects this value');
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (!Object.hasOwn(value, index) || item === undefined) throw new Error('canonical JSON rejects this value');
      return canonicalize(item, depth + 1);
    });
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('canonical JSON rejects this value');
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('canonical JSON rejects this value');
      const item = descriptor.value as unknown;
      if (item === undefined) throw new Error('canonical JSON rejects this value');
      sorted[key] = canonicalize(item, depth + 1);
    }
    return sorted;
  }
  throw new Error('canonical JSON rejects this value');
}
