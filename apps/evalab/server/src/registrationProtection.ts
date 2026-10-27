import { createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createChallenge, HmacAlgorithm, verifySolution, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import type { AppContext } from './context.js';
import { withTx } from './db.js';
import { HttpError } from './errors.js';
import { registrationMailBudgetRetry } from './registrationMailBudget.js';
import { usesEmbeddingSession } from './embedding.js';

export const SIGNUP_COOKIE = 'lab_signup';
export const EMBED_SIGNUP_COOKIE = 'lab_embedded_signup';

const PROOF_MAX = 12_000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const COOKIE_MAX_AGE = 2 * 24 * 3600;
const ALTCHA_COST = 1000;
const ALTCHA_ALGORITHM = 'PBKDF2/SHA-256';
const MAX_VERIFY_ATTEMPTS = 5;

const ISSUE_IP = { bucket: 'register-issue-ip-minute', capacity: 120, windowSeconds: 60 };
const ISSUE_GLOBAL = { bucket: 'register-issue-global-minute', capacity: 1000, windowSeconds: 60 };
const MAIL_EMAIL_COOLDOWN = { bucket: 'register-mail-email-cooldown', capacity: 1, windowSeconds: 60 };
const MAIL_EMAIL_HOUR = { bucket: 'register-mail-email-hour', capacity: 3, windowSeconds: 3600 };
const MAIL_EMAIL_DAY = { bucket: 'register-mail-email-day', capacity: 10, windowSeconds: 86400 };
const MAIL_BROWSER_HOUR = { bucket: 'register-mail-browser-hour', capacity: 8, windowSeconds: 3600 };
const MAIL_BROWSER_DAY = { bucket: 'register-mail-browser-day', capacity: 20, windowSeconds: 86400 };
const MAIL_IP_HOUR = { bucket: 'register-mail-ip-hour', capacity: 300, windowSeconds: 3600 };
const MAIL_IP_DAY = { bucket: 'register-mail-ip-day', capacity: 1000, windowSeconds: 86400 };
const MAIL_GLOBAL_HOUR = 'register-mail-global-hour';
const MAIL_GLOBAL_DAY = 'register-mail-global-day';

const emailSchema = z.string().trim().email().max(200);

const proofSchema = z.object({
  challenge: z.object({
    signature: z.string().regex(/^[0-9a-f]{64}$/i),
    parameters: z.object({
      algorithm: z.literal(ALTCHA_ALGORITHM),
      nonce: z.string().regex(/^[0-9a-f]{16,128}$/i),
      salt: z.string().regex(/^[0-9a-f]{16,128}$/i),
      cost: z.number().int().min(1).max(100_000),
      keyLength: z.number().int().min(16).max(64),
      keyPrefix: z.string().regex(/^[0-9a-f]{2,128}$/i),
      keySignature: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
      expiresAt: z.number().int().positive().optional(),
      data: z.object({
        id: z.string().uuid(),
      }).strict(),
    }).strict(),
  }).strict(),
  solution: z.object({
    counter: z.number().int().min(0).max(100_000),
    derivedKey: z.string().regex(/^[0-9a-f]{64}$/i),
    time: z.number().finite().optional(),
  }).strict(),
}).strict();

type ParsedProof = z.infer<typeof proofSchema>;

type StoredChallenge = Challenge;

type BucketSpec = {
  bucket: string;
  subject: string;
  capacity: number;
  refillPerSecond: number;
};

export class RegistrationLimitError extends HttpError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(429, '操作过于频繁，请稍后再试', 'RATE_LIMITED');
    this.name = 'RegistrationLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function invalidProof(): HttpError {
  return new HttpError(400, '注册验证无效或已过期', 'INVALID');
}

function domainSecret(sessionSecret: string, domain: string): string {
  return createHmac('sha256', sessionSecret).update(domain).digest('hex');
}

function blind(sessionSecret: string, domain: string, value: string): string {
  return createHmac('sha256', domainSecret(sessionSecret, domain)).update(value).digest('hex');
}

export function registrationBrowserHash(sessionSecret: string, browserId: string): string {
  return blind(sessionSecret, 'registration-browser-v1', browserId);
}

export function registrationIpHash(sessionSecret: string, ip: string): string {
  return blind(sessionSecret, 'registration-ip-v1', ip);
}

function bucketSubject(sessionSecret: string, value: string): string {
  return blind(sessionSecret, 'registration-bucket-v1', value);
}

function clientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '').slice(0, 64);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.header('cookie');
  if (!header || header.length > 4096) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function signaturesEqual(left: string, right: string): boolean {
  if (left.length !== right.length || left.length === 0 || left.length > 128) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function hashesEqual(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function readSignupBrowserId(sessionSecret: string, req: Request, embedded = false): string | null {
  const raw = readCookie(req, embedded ? EMBED_SIGNUP_COOKIE : SIGNUP_COOKIE);
  if (!raw || raw.length > 200) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot !== raw.lastIndexOf('.')) return null;
  const browserId = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(browserId) || !/^[A-Za-z0-9_-]{16,80}$/.test(mac)) return null;
  const expected = createHmac('sha256', domainSecret(sessionSecret, 'signup-cookie-v1')).update(browserId).digest('base64url');
  if (!signaturesEqual(expected, mac)) return null;
  return browserId;
}

function writeSignupCookie(res: Response, ctx: AppContext, browserId: string, embedded: boolean): void {
  const mac = createHmac('sha256', domainSecret(ctx.config.sessionSecret, 'signup-cookie-v1')).update(browserId).digest('base64url');
  const parts = [
    `${embedded ? EMBED_SIGNUP_COOKIE : SIGNUP_COOKIE}=${browserId}.${mac}`,
    'HttpOnly',
    'Path=/',
    embedded ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (ctx.config.cookieSecure) parts.push('Secure');
  if (embedded) parts.push('Partitioned');
  res.append('Set-Cookie', parts.join('; '));
}

function parseEmail(value: unknown): string {
  const parsed = emailSchema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, '请求参数不正确', 'VALIDATION');
  return parsed.data.toLowerCase();
}

function parseProof(proof: string): ParsedProof {
  if (proof.length === 0 || proof.length > PROOF_MAX) throw invalidProof();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(proof) || proof.length % 4 !== 0) throw invalidProof();
  const bytes = Buffer.from(proof, 'base64');
  if (bytes.length === 0 || bytes.length > 9_000) throw invalidProof();
  let json: unknown;
  try {
    json = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw invalidProof();
  }
  const parsed = proofSchema.safeParse(json);
  if (!parsed.success) throw invalidProof();
  return parsed.data;
}

function asStoredChallenge(value: unknown, id: string): StoredChallenge | null {
  if (!value || typeof value !== 'object') return null;
  const challenge = value as StoredChallenge;
  const parameters = challenge.parameters;
  if (!parameters || typeof parameters !== 'object') return null;
  const data = parameters.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const dataKeys = Object.keys(data);
  if (dataKeys.length !== 1 || dataKeys[0] !== 'id' || data.id !== id) return null;
  if (parameters.algorithm !== ALTCHA_ALGORITHM || parameters.cost !== ALTCHA_COST || parameters.keyLength !== 32) return null;
  if (typeof parameters.nonce !== 'string' || typeof parameters.salt !== 'string' || typeof parameters.keyPrefix !== 'string') return null;
  if (typeof challenge.signature !== 'string' || typeof parameters.keySignature !== 'string') return null;
  if (typeof parameters.expiresAt !== 'number' || !Number.isFinite(parameters.expiresAt)) return null;
  const latest = Math.floor(Date.now() / 1000) + Math.ceil(CHALLENGE_TTL_MS / 1000) + 30;
  if (parameters.expiresAt > latest) return null;
  return challenge;
}

async function takeToken(client: PoolClient, spec: BucketSpec): Promise<number | null> {
  await client.query(
    `INSERT INTO registration_buckets (bucket, subject, tokens, updated_at)
     VALUES ($1, $2, $3, clock_timestamp())
     ON CONFLICT (bucket, subject) DO NOTHING`,
    [spec.bucket, spec.subject, spec.capacity],
  );
  const selected = await client.query<{ available: number }>(
    `SELECT LEAST($3::float8, tokens + GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - updated_at))) * $4::float8) AS available
     FROM registration_buckets
     WHERE bucket = $1 AND subject = $2
     FOR UPDATE`,
    [spec.bucket, spec.subject, spec.capacity, spec.refillPerSecond],
  );
  const available = Number(selected.rows[0]?.available);
  if (!Number.isFinite(available)) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
  if (available < 1) {
    const retry = Math.ceil((1 - available) / spec.refillPerSecond);
    return Math.max(1, Math.min(86_400, retry));
  }
  await client.query(
    `UPDATE registration_buckets
     SET tokens = $3::float8 - 1, updated_at = clock_timestamp()
     WHERE bucket = $1 AND subject = $2`,
    [spec.bucket, spec.subject, available],
  );
  return null;
}

async function chargeBuckets(client: PoolClient, specs: BucketSpec[]): Promise<void> {
  const ordered = [...specs].sort((left, right) => left.bucket.localeCompare(right.bucket) || left.subject.localeCompare(right.subject));
  let wait = 0;
  for (const spec of ordered) {
    const retry = await takeToken(client, spec);
    if (retry !== null) wait = Math.max(wait, retry);
  }
  if (wait > 0) throw new RegistrationLimitError(wait);
}

function bucket(secret: string, name: string, value: string, capacity: number, windowSeconds: number): BucketSpec {
  return {
    bucket: name,
    subject: bucketSubject(secret, value),
    capacity,
    refillPerSecond: capacity / windowSeconds,
  };
}

export async function issueRegistrationChallenge(ctx: AppContext, req: Request, res: Response): Promise<Challenge> {
  const email = parseEmail(typeof req.query.email === 'string' ? req.query.email : undefined);
  const secret = ctx.config.sessionSecret;
  const embedded = usesEmbeddingSession(ctx.config, req);
  const browserId = readSignupBrowserId(secret, req, embedded) ?? randomBytes(32).toString('base64url');
  const browserHash = registrationBrowserHash(secret, browserId);
  const ipHash = registrationIpHash(secret, clientIp(req));
  const id = randomUUID();
  const issued = await withTx(ctx.pool, async (client) => {
    await chargeBuckets(client, [
      bucket(secret, ISSUE_IP.bucket, `ip:${ipHash}`, ISSUE_IP.capacity, ISSUE_IP.windowSeconds),
      bucket(secret, ISSUE_GLOBAL.bucket, 'global', ISSUE_GLOBAL.capacity, ISSUE_GLOBAL.windowSeconds),
    ]);
    const challenge = await createChallenge({
      algorithm: ALTCHA_ALGORITHM,
      cost: ALTCHA_COST,
      counter: randomInt(500, 1501),
      counterMode: 'uint32',
      deriveKey,
      expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      hmacAlgorithm: HmacAlgorithm.SHA_256,
      hmacSignatureSecret: domainSecret(secret, 'altcha-challenge-signature-v1'),
      hmacKeySignatureSecret: domainSecret(secret, 'altcha-key-signature-v1'),
      data: { id },
    });
    await client.query(
      `INSERT INTO registration_challenges (id, email, browser_hash, challenge_json, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, clock_timestamp() + interval '5 minutes')`,
      [id, email, browserHash, JSON.stringify(challenge)],
    );
    return challenge;
  });
  writeSignupCookie(res, ctx, browserId, embedded);
  return issued;
}

export async function consumeRegistrationProofForMail(
  ctx: AppContext,
  req: Request,
  email: string,
  proof: string | undefined,
  send: (client: PoolClient, proofId: string) => Promise<string>,
): Promise<string> {
  if (proof === undefined || proof.trim() === '') {
    throw new HttpError(400, '请先完成注册验证', 'REGISTRATION_PROOF_REQUIRED');
  }
  const parsed = parseProof(proof);
  const secret = ctx.config.sessionSecret;
  const browserId = readSignupBrowserId(secret, req, usesEmbeddingSession(ctx.config, req));
  if (!browserId) throw invalidProof();
  const browserHash = registrationBrowserHash(secret, browserId);
  const ipHash = registrationIpHash(secret, clientIp(req));
  const proofId = parsed.challenge.parameters.data.id;
  const outcome = await withTx(ctx.pool, async (client) => {
    const found = await client.query<{
      email: string;
      browser_hash: string;
      challenge_json: unknown;
      consumed_at: Date | null;
      verify_attempts: number;
      expired: boolean;
    }>(
      `SELECT email, browser_hash, challenge_json, consumed_at, verify_attempts,
              (expires_at <= clock_timestamp() OR created_at <= clock_timestamp() - interval '5 minutes') AS expired
       FROM registration_challenges
       WHERE id = $1
       FOR UPDATE`,
      [proofId],
    );
    const row = found.rows[0];
    if (!row || row.consumed_at || row.expired) return { kind: 'invalid' as const };
    if (row.email !== email || !hashesEqual(row.browser_hash, browserHash)) return { kind: 'invalid' as const };
    const stored = asStoredChallenge(row.challenge_json, proofId);
    if (!stored?.signature || !signaturesEqual(stored.signature, parsed.challenge.signature)) return { kind: 'invalid' as const };
    if (row.verify_attempts >= MAX_VERIFY_ATTEMPTS) return { kind: 'invalid' as const };
    let verified: Awaited<ReturnType<typeof verifySolution>>;
    try {
      verified = await verifySolution({
        challenge: stored,
        solution: parsed.solution,
        counterMode: 'uint32',
        deriveKey,
        hmacAlgorithm: HmacAlgorithm.SHA_256,
        hmacSignatureSecret: domainSecret(secret, 'altcha-challenge-signature-v1'),
        hmacKeySignatureSecret: domainSecret(secret, 'altcha-key-signature-v1'),
      });
    } catch {
      return { kind: 'invalid' as const };
    }
    if (!verified.verified) {
      if (verified.invalidSolution) {
        await client.query(
          `UPDATE registration_challenges
           SET verify_attempts = verify_attempts + 1,
               consumed_at = CASE WHEN verify_attempts + 1 >= $2 THEN clock_timestamp() ELSE consumed_at END
           WHERE id = $1`,
          [proofId, MAX_VERIFY_ATTEMPTS],
        );
      }
      return { kind: 'invalid' as const };
    }
    const existing = await client.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if ((existing.rowCount ?? 0) > 0) return { kind: 'conflict' as const };
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ['110lab-registration-mail-queue']);
    const budgetRetry = await registrationMailBudgetRetry(client, ctx.config, email);
    if (budgetRetry > 0) throw new RegistrationLimitError(budgetRetry);
    await chargeBuckets(client, [
      bucket(secret, MAIL_EMAIL_COOLDOWN.bucket, `email:${email}`, MAIL_EMAIL_COOLDOWN.capacity, MAIL_EMAIL_COOLDOWN.windowSeconds),
      bucket(secret, MAIL_EMAIL_HOUR.bucket, `email:${email}`, MAIL_EMAIL_HOUR.capacity, MAIL_EMAIL_HOUR.windowSeconds),
      bucket(secret, MAIL_EMAIL_DAY.bucket, `email:${email}`, MAIL_EMAIL_DAY.capacity, MAIL_EMAIL_DAY.windowSeconds),
      bucket(secret, MAIL_BROWSER_HOUR.bucket, `browser:${browserHash}`, MAIL_BROWSER_HOUR.capacity, MAIL_BROWSER_HOUR.windowSeconds),
      bucket(secret, MAIL_BROWSER_DAY.bucket, `browser:${browserHash}`, MAIL_BROWSER_DAY.capacity, MAIL_BROWSER_DAY.windowSeconds),
      bucket(secret, MAIL_IP_HOUR.bucket, `ip:${ipHash}`, MAIL_IP_HOUR.capacity, MAIL_IP_HOUR.windowSeconds),
      bucket(secret, MAIL_IP_DAY.bucket, `ip:${ipHash}`, MAIL_IP_DAY.capacity, MAIL_IP_DAY.windowSeconds),
      bucket(secret, MAIL_GLOBAL_HOUR, 'global', ctx.config.registrationMailHourlyBudget, 3600),
      bucket(secret, MAIL_GLOBAL_DAY, 'global', ctx.config.registrationMailDailyBudget, 86400),
    ]);
    const queued = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM email_outbox
       WHERE status IN ('PENDING', 'SENDING')
         AND idempotency_key LIKE 'register-code:%'`,
    );
    if ((queued.rows[0]?.n ?? 0) >= ctx.config.registrationQueueLimit) throw new RegistrationLimitError(60);
    const consumed = await client.query(
      `UPDATE registration_challenges
       SET consumed_at = clock_timestamp()
       WHERE id = $1 AND consumed_at IS NULL`,
      [proofId],
    );
    if ((consumed.rowCount ?? 0) !== 1) return { kind: 'invalid' as const };
    const challengeId = await send(client, proofId);
    return { kind: 'ok' as const, challengeId };
  });
  if (outcome.kind === 'conflict') throw new HttpError(409, '该邮箱已注册', 'CONFLICT');
  if (outcome.kind !== 'ok') throw invalidProof();
  return outcome.challengeId;
}

export async function purgeRegistrationProtection(ctx: AppContext): Promise<number> {
  const deleted = await ctx.pool.query(
    `DELETE FROM registration_challenges
     WHERE expires_at < clock_timestamp() - interval '1 hour'
        OR created_at < clock_timestamp() - interval '1 day'
        OR (consumed_at IS NOT NULL AND consumed_at < clock_timestamp() - interval '1 day')`,
  );
  await ctx.pool.query(
    `DELETE FROM registration_buckets
     WHERE updated_at < clock_timestamp() - interval '2 days'`,
  );
  return deleted.rowCount ?? 0;
}
