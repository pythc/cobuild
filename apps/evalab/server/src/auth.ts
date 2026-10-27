import { randomBytes, randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { EMBED_SESSION_COOKIE } from './embedding.js';
import type { AppContext } from './context.js';
import { HttpError } from './errors.js';
import { insertAudit } from './audit.js';
import { withTx } from './db.js';
import { enqueueMail, assertRateLimit } from './rateLimit.js';
import { recordRegistrationRisk } from './candidateRisk.js';
import { consumeRegistrationProofForMail } from './registrationProtection.js';
import {
  dummyPasswordHash,
  hashEmailCode,
  hashPassword,
  safeEqualHex,
  verifyPassword,
} from './security.js';

export type PublicUser = {
  id: string;
  role: 'CANDIDATE' | 'ADMIN';
  name: string;
  email: string;
  studentNo?: string;
  college?: string;
  major?: string;
  phone?: string;
};

export type SessionAuth = {
  sessionId: string;
  csrfToken: string;
  user: PublicUser;
};

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f]/.test(value));

const registerSchema = z.object({
  name: text(40),
  studentNo: z.string().trim().regex(/^[A-Za-z0-9]{6,20}$/),
  college: text(40),
  major: text(40),
  phone: z.string().trim().regex(/^1[3-9]\d{9}$/),
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(128).refine((value) => /\p{L}/u.test(value) && /\d/.test(value)),
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
  acceptedPolicy: z.literal(true),
  registrationContext: z.enum(['ASSESSMENT', 'ACCOUNT_TEAMING']).optional(),
}).strict();

const codeSchema = z.object({
  email: z.string().trim().email().max(200),
  purpose: z.enum(['REGISTER', 'RESET']),
  registrationProof: z.string().max(12000).optional(),
}).strict();

const loginSchema = z.object({
  account: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(128),
}).strict();

const resetSchema = z.object({
  email: z.string().trim().email().max(200),
  challengeId: z.string().uuid(),
  code: z.string().regex(/^\d{6}$/),
  password: z.string().min(8).max(128).refine((value) => /\p{L}/u.test(value) && /\d/.test(value)),
}).strict();

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.slice(0, 4).map((issue) => issue.path.join('.') || 'body');
    throw new HttpError(400, `请求参数不正确：${fields.join('、')}`, 'VALIDATION');
  }
  return parsed.data;
}

type UserRow = {
  id: string;
  role: 'CANDIDATE' | 'ADMIN';
  name: string;
  email: string;
  student_no: string | null;
  college: string | null;
  major: string | null;
  phone: string | null;
  password_hash?: string;
};

export function toPublicUser(row: UserRow): PublicUser {
  const user: PublicUser = {
    id: row.id,
    role: row.role,
    name: row.name,
    email: row.email,
  };
  if (row.student_no) user.studentNo = row.student_no;
  if (row.college) user.college = row.college;
  if (row.major) user.major = row.major;
  if (row.phone) user.phone = row.phone;
  return user;
}

export function clientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '').slice(0, 64);
}

function codeValue(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

async function createChallenge(
  client: PoolClient,
  ctx: AppContext,
  email: string,
  purpose: 'REGISTER' | 'RESET',
  code: string,
  registrationProofId?: string,
): Promise<string> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO email_challenges (email, purpose, code_hash, expires_at, registration_proof_id)
     VALUES ($1, $2, $3, now() + interval '10 minutes', $4)
     RETURNING id`,
    [email, purpose, hashEmailCode(ctx.config.sessionSecret, purpose, email, code), registrationProofId ?? null],
  );
  const id = inserted.rows[0]?.id;
  if (!id) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
  return id;
}

async function consumeChallenge(
  client: PoolClient,
  ctx: AppContext,
  input: { email: string; purpose: 'REGISTER' | 'RESET'; challengeId: string; code: string },
): Promise<boolean> {
  const found = await client.query<{ code_hash: string; attempts: number; consumed_at: Date | null; expired: boolean }>(
    `SELECT code_hash, attempts, consumed_at, (expires_at <= clock_timestamp()) AS expired
     FROM email_challenges
     WHERE id = $1 AND email = $2 AND purpose = $3
     FOR UPDATE`,
    [input.challengeId, input.email, input.purpose],
  );
  const row = found.rows[0];
  if (!row || row.consumed_at || row.expired || row.attempts >= 5) return false;
  const actual = hashEmailCode(ctx.config.sessionSecret, input.purpose, input.email, input.code);
  if (!safeEqualHex(actual, row.code_hash)) {
    await client.query(
      `UPDATE email_challenges
       SET attempts = attempts + 1,
           consumed_at = CASE WHEN attempts + 1 >= 5 THEN clock_timestamp() ELSE consumed_at END
       WHERE id = $1`,
      [input.challengeId],
    );
    return false;
  }
  await client.query(
    `UPDATE email_challenges SET consumed_at = clock_timestamp()
     WHERE email = $1 AND purpose = $2 AND consumed_at IS NULL`,
    [input.email, input.purpose],
  );
  return true;
}

export async function openSession(ctx: AppContext, userId: string): Promise<{ sessionId: string; csrfToken: string }> {
  const csrfToken = randomBytes(32).toString('base64url');
  const inserted = await ctx.pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, csrf_token, expires_at)
     VALUES ($1, $2, now() + interval '7 days')
     RETURNING id`,
    [userId, csrfToken],
  );
  const sessionId = inserted.rows[0]?.id;
  if (!sessionId) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
  return { sessionId, csrfToken };
}

export function setSessionCookie(res: Response, ctx: AppContext, sessionId: string, embedded = false): void {
  const parts = [
    `${embedded ? EMBED_SESSION_COOKIE : 'lab_session'}=${sessionId}`,
    'HttpOnly',
    'Path=/',
    embedded ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${7 * 24 * 3600}`,
  ];
  if (ctx.config.cookieSecure) parts.push('Secure');
  if (embedded) parts.push('Partitioned');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(res: Response, ctx: AppContext, embedded = false): void {
  const parts = [`${embedded ? EMBED_SESSION_COOKIE : 'lab_session'}=`, 'HttpOnly', 'Path=/', embedded ? 'SameSite=None' : 'SameSite=Lax', 'Max-Age=0'];
  if (ctx.config.cookieSecure) parts.push('Secure');
  if (embedded) parts.push('Partitioned');
  res.append('Set-Cookie', parts.join('; '));
}

export async function requestEmailCode(ctx: AppContext, req: Request): Promise<{ challengeId: string; expiresIn: 600 }> {
  const body = parseBody(codeSchema, req.body);
  const email = body.email.toLowerCase();
  if (body.purpose === 'REGISTER') {
    const code = codeValue();
    const challengeId = await consumeRegistrationProofForMail(ctx, req, email, body.registrationProof, async (client, proofId) => {
      const id = await createChallenge(client, ctx, email, 'REGISTER', code, proofId);
      await enqueueMail(client, {
        to: email,
        subject: '110实验室考核注册验证码',
        body: `您好，\n\n您的验证码是 ${code}，10分钟内有效。如非本人操作请忽略。\n\n110实验室考核系统\n`,
        idempotencyKey: `register-code:${id}`,
      });
      return id;
    });
    return { challengeId, expiresIn: 600 };
  }
  const ip = clientIp(req);
  await assertRateLimit(ctx, ctx.pool, 'email-code-ip', ip, 100, 600);
  await assertRateLimit(ctx, ctx.pool, 'email-code-subject', `RESET:${email}`, 5, 600);
  const existing = await ctx.pool.query('SELECT 1 FROM users WHERE email = $1', [email]);
  const exists = (existing.rowCount ?? 0) > 0;
  const code = codeValue();
  const challengeId = await withTx(ctx.pool, async (client) => {
    const id = await createChallenge(client, ctx, email, 'RESET', code);
    if (!exists) return id;
    await enqueueMail(client, {
      to: email,
      subject: '110实验室考核重置密码验证码',
      body: `您好，\n\n您的验证码是 ${code}，10分钟内有效。如非本人操作请忽略。\n\n110实验室考核系统\n`,
      idempotencyKey: `email-code:${id}`,
    });
    return id;
  });
  return { challengeId, expiresIn: 600 };
}

async function consumeRegisterCode(
  client: PoolClient,
  ctx: AppContext,
  input: { email: string; challengeId: string; code: string },
): Promise<boolean> {
  await client.query(
    `SELECT id FROM email_challenges
     WHERE email = $1 AND purpose = 'REGISTER' AND consumed_at IS NULL
     ORDER BY id
     FOR UPDATE`,
    [input.email],
  );
  const found = await client.query<{ code_hash: string; attempts: number; consumed_at: Date | null; expired: boolean; registration_proof_id: string | null }>(
    `SELECT code_hash, attempts, consumed_at, registration_proof_id,
            (expires_at <= clock_timestamp()) AS expired
     FROM email_challenges
     WHERE id = $1 AND email = $2 AND purpose = 'REGISTER'
     FOR UPDATE`,
    [input.challengeId, input.email],
  );
  const row = found.rows[0];
  if (!row || row.consumed_at || row.expired || row.attempts >= 5 || !row.registration_proof_id) return false;
  const actual = hashEmailCode(ctx.config.sessionSecret, 'REGISTER', input.email, input.code);
  if (!safeEqualHex(actual, row.code_hash)) {
    await client.query(
      `UPDATE email_challenges
       SET attempts = attempts + 1,
           consumed_at = CASE WHEN attempts + 1 >= 5 THEN clock_timestamp() ELSE consumed_at END
       WHERE id = $1`,
      [input.challengeId],
    );
    return false;
  }
  await client.query(
    `UPDATE email_challenges SET consumed_at = clock_timestamp()
     WHERE email = $1 AND purpose = 'REGISTER' AND consumed_at IS NULL`,
    [input.email],
  );
  return true;
}

export async function registerAccount(ctx: AppContext, req: Request): Promise<{ user: PublicUser; csrfToken: string; sessionId: string }> {
  const body = parseBody(registerSchema, req.body);
  const email = body.email.toLowerCase();
  await assertRateLimit(ctx, ctx.pool, 'register-ip', clientIp(req), 300, 3600);
  const accepted = await withTx(ctx.pool, async (client) => consumeRegisterCode(client, ctx, {
    email,
    challengeId: body.challengeId,
    code: body.code,
  }));
  if (!accepted) throw new HttpError(400, '验证码无效或已过期', 'CODE_INVALID');
  const passwordHash = await hashPassword(body.password);
  const created = await withTx(ctx.pool, async (client) => {
    try {
      const inserted = await client.query<UserRow>(
        `INSERT INTO users (role, name, student_no, college, major, phone, email, password_hash, accepted_policy_at)
         VALUES ('CANDIDATE', $1, $2, $3, $4, $5, $6, $7, now())
         RETURNING id, role, name, email, student_no, college, major, phone`,
        [body.name, body.studentNo, body.college, body.major, body.phone, email, passwordHash],
      );
      const row = inserted.rows[0];
      if (!row) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
      await insertAudit(client, { actorId: row.id, actorName: row.name, action: 'REGISTER', details: { registrationContext: body.registrationContext ?? 'ASSESSMENT', policyVersion: '2026-10-15' } });
      await recordRegistrationRisk(client, ctx, row.id, req);
      return row;
    } catch (error) {
      if (isUnique(error, 'users_student_no_key')) {
        throw new HttpError(409, '该学号已注册', 'CONFLICT');
      }
      if (isUnique(error, 'users_email_key')) {
        throw new HttpError(409, '该邮箱已注册', 'CONFLICT');
      }
      throw error;
    }
  });
  const session = await openSession(ctx, created.id);
  return { user: toPublicUser(created), csrfToken: session.csrfToken, sessionId: session.sessionId };
}

export async function loginAccount(ctx: AppContext, req: Request): Promise<{ user: PublicUser; csrfToken: string; sessionId: string }> {
  const body = parseBody(loginSchema, req.body);
  const account = body.account.trim();
  const ip = clientIp(req);
  await assertRateLimit(ctx, ctx.pool, 'login-ip', ip, 200, 900);
  await assertRateLimit(ctx, ctx.pool, 'login-account', account.toLowerCase(), 10, 900);
  const isEmail = account.includes('@');
  const found = await ctx.pool.query<UserRow & { password_hash: string }>(
    isEmail
      ? `SELECT id, role, name, email, student_no, college, major, phone, password_hash FROM users WHERE email = $1`
      : `SELECT id, role, name, email, student_no, college, major, phone, password_hash FROM users WHERE student_no = $1`,
    [isEmail ? account.toLowerCase() : account],
  );
  const row = found.rows[0];
  const hash = row?.password_hash ?? (await dummyPasswordHash());
  const ok = await verifyPassword(body.password, hash);
  if (!row || !ok) throw new HttpError(401, '账号或密码错误', 'BAD_CREDENTIALS');
  const session = await openSession(ctx, row.id);
  await withTx(ctx.pool, async (client) => {
    await insertAudit(client, { actorId: row.id, actorName: row.name, action: 'LOGIN' });
  });
  return { user: toPublicUser(row), csrfToken: session.csrfToken, sessionId: session.sessionId };
}

export async function resetPassword(ctx: AppContext, req: Request): Promise<{ ok: true }> {
  const body = parseBody(resetSchema, req.body);
  const email = body.email.toLowerCase();
  await assertRateLimit(ctx, ctx.pool, 'reset-ip', clientIp(req), 30, 900);
  const passwordHash = await hashPassword(body.password);
  const reset = await withTx(ctx.pool, async (client) => {
    const accepted = await consumeChallenge(client, ctx, {
      email,
      purpose: 'RESET',
      challengeId: body.challengeId,
      code: body.code,
    });
    if (!accepted) return false;
    const user = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE email = $1 FOR UPDATE',
      [email],
    );
    const row = user.rows[0];
    if (!row) return false;
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [row.id, passwordHash]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [row.id]);
    await client.query(
      `UPDATE mcp_tokens SET revoked_at = clock_timestamp()
       WHERE revoked_at IS NULL AND enrollment_id IN (SELECT id FROM enrollments WHERE user_id = $1)`,
      [row.id],
    );
    await insertAudit(client, { actorId: row.id, actorName: row.name, action: 'RESET_PASSWORD' });
    return true;
  });
  if (!reset) throw new HttpError(400, '验证码无效或已过期', 'CODE_INVALID');
  return { ok: true };
}

export async function logoutAccount(ctx: AppContext, auth: SessionAuth | undefined): Promise<{ ok: true }> {
  if (!auth) throw new HttpError(401, '未登录', 'UNAUTHENTICATED');
  await ctx.pool.query('DELETE FROM sessions WHERE id = $1', [auth.sessionId]);
  return { ok: true };
}

export async function loadSession(ctx: AppContext, sessionId: string): Promise<SessionAuth | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const result = await ctx.pool.query<UserRow & { session_id: string; csrf_token: string }>(
    `SELECT s.id AS session_id, s.csrf_token, u.id, u.role, u.name, u.email, u.student_no, u.college, u.major, u.phone
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { sessionId: row.session_id, csrfToken: row.csrf_token, user: toPublicUser(row) };
}

function isUnique(error: unknown, constraint: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505'
    && 'constraint' in error && (error as { constraint?: string }).constraint === constraint;
}
