import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { CanonicalError, HttpError } from './errors.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const MAX_DEPTH = 32;

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bcrsr_[A-Za-z0-9]{20,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bglpat-[A-Za-z0-9\-_]{20,}\b/,
  /https?:\/\/[^\s/:@]+:[^\s/@]+@/i,
  /\b(?:password|passwd|api[_-]?key|secret)\b\s*[:=]\s*['"]?[^\s'"]+/i,
  /(?:密码|密钥)\s*[:：=]\s*\S+/,
];

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value, 0));
}

function normalizeCanonical(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new CanonicalError('nesting too deep');
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalError('non-finite number');
    return value;
  }
  if (value === undefined || typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    throw new CanonicalError('unsupported value');
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => {
      if (!Object.hasOwn(value, index) || item === undefined) throw new CanonicalError('unsupported value');
      return normalizeCanonical(item, depth + 1);
    });
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new CanonicalError('unsupported value');
    const record = value as object;
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(record).sort()) {
      const desc = Object.getOwnPropertyDescriptor(record, key);
      if (!desc || !('value' in desc)) throw new CanonicalError('unsupported value');
      if (desc.value === undefined) throw new CanonicalError('unsupported value');
      out[key] = normalizeCanonical(desc.value, depth + 1);
    }
    return out;
  }
  throw new CanonicalError('unsupported value');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashCanonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function safeEqualString(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

export function safeEqualHex(left: string, right: string): boolean {
  return safeEqualString(left.toLowerCase(), right.toLowerCase());
}

export function blindKey(pepper: string, value: string): string {
  return createHmac('sha256', pepper).update(value).digest('hex');
}

export function hashEmailCode(pepper: string, purpose: string, email: string, code: string): string {
  return createHmac('sha256', pepper).update(`${purpose}\n${email}\n${code}`).digest('hex');
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8 || password.length > 128) {
    throw new Error('password length');
  }
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer;
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

let dummyHash: Promise<string> | null = null;

export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(24).toString('hex'));
  return dummyHash;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4] ?? '', 'base64url');
    const expected = Buffer.from(parts[5] ?? '', 'base64url');
    if (!n || !r || !p || salt.length < 8 || expected.length < 16 || password.length > 128) return false;
    const actual = (await scryptAsync(password, salt, expected.length, { N: n, r, p })) as Buffer;
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function containsSecretMarker(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

export function assertNoSecretMarker(text: string): void {
  if (containsSecretMarker(text)) {
    throw new HttpError(400, '提交内容包含疑似密钥，已被拒绝', 'SECRET_DETECTED');
  }
}

export function escapeCsvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  const prefixed = /^\s*[=+\-@]/.test(raw) || /^[\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${prefixed.replace(/"/g, '""')}"`;
}

export function toCsv(rows: unknown[][]): string {
  const body = rows.map((row) => row.map((cell) => escapeCsvCell(cell)).join(',')).join('\r\n');
  return `\uFEFF${body}\r\n`;
}

const REDACT_KEY = /token|password|secret|code|content|payload|body|cookie|authorization|material/i;

export function redactDetails(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (REDACT_KEY.test(key)) continue;
    if (typeof value === 'string') {
      out[key] = value.replace(/[\u0000-\u001f]/g, ' ').slice(0, 200);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value;
    }
  }
  return out;
}

export function publicAuthor(name: string): string {
  const clean = name.replace(/[\r\n\t]/g, ' ').trim().slice(0, 200);
  const parts = clean.split(/\s+/).filter((part) => part && !part.includes('@'));
  return parts.join(' ') || 'unknown';
}

export function firstLine(message: string): string {
  const line = message.split(/\r?\n/, 1)[0] ?? '';
  return line.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
}
