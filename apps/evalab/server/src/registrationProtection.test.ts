import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { access, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import express, { type Request } from 'express';
import { solveChallenge, type Challenge } from 'altcha-lib';
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2';
import { registerAccount, requestEmailCode, loginAccount, resetPassword } from './auth.js';
import { assertCandidateCanStart, registerCandidateRisk } from './candidateRisk.js';
import { bootstrapAdmin } from './bootstrap.js';
import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { createPool, withTx } from './db.js';
import { HttpError } from './errors.js';
import { cors, csrfGuard, errorHandler, originGuard, sendSession, sessionLoader } from './http.js';
import { issueRegistrationChallenge, purgeRegistrationProtection, RegistrationLimitError, SIGNUP_COOKIE, EMBED_SIGNUP_COOKIE } from './registrationProtection.js';
import { hashPassword } from './security.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';

test('registration mail budgets are optional validated config', () => {
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://localhost/lab',
    APP_ORIGIN: origin,
    SESSION_SECRET: 'test-session-secret-32chars-minimum',
  };
  const defaults = loadConfig(base);
  assert.equal(defaults.config.registrationMailHourlyBudget, 300);
  assert.equal(defaults.config.registrationMailDailyBudget, 1500);
  assert.equal(defaults.config.registrationQueueLimit, 200);
  const custom = loadConfig({
    ...base,
    REGISTRATION_MAIL_HOURLY_BUDGET: '12',
    REGISTRATION_MAIL_DAILY_BUDGET: '40',
    REGISTRATION_QUEUE_LIMIT: '7',
  });
  assert.equal(custom.config.registrationMailHourlyBudget, 12);
  assert.equal(custom.config.registrationMailDailyBudget, 40);
  assert.equal(custom.config.registrationQueueLimit, 7);
  assert.throws(() => loadConfig({ ...base, REGISTRATION_QUEUE_LIMIT: '0' }), /REGISTRATION_QUEUE_LIMIT/);
  assert.throws(() => loadConfig({ ...base, REGISTRATION_MAIL_HOURLY_BUDGET: '1.5' }), /REGISTRATION_MAIL_HOURLY_BUDGET/);
  assert.throws(() => loadConfig({
    ...base,
    REGISTRATION_MAIL_HOURLY_BUDGET: '500',
    REGISTRATION_MAIL_DAILY_BUDGET: '100',
  }), /REGISTRATION_MAIL_DAILY_BUDGET/);
});

if (!databaseUrl) {
  test('registration protection postgres', { skip: 'set TEST_DATABASE_URL to a disposable database' }, () => {});
} else {
  const schema = `assessment_antibot_${process.pid}`;
  let ctx: AppContext;
  let server: Server;
  let base = '';
  let seq = 0;

  class Api {
    cookie = '';
    csrf = '';
    async fetch(urlPath: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('origin', origin);
      if (this.cookie) headers.set('cookie', this.cookie);
      const method = init.method ?? 'GET';
      if (this.csrf && method !== 'GET' && method !== 'HEAD') headers.set('x-csrf-token', this.csrf);
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      const response = await fetch(base + urlPath, { ...init, headers });
      const setCookies = response.headers.getSetCookie();
      for (const item of setCookies) {
        const pair = item.split(';')[0] ?? '';
        const name = pair.split('=')[0];
        if (name === 'lab_session' || name === SIGNUP_COOKIE) this.cookie = mergeCookies(this.cookie, pair);
      }
      const text = await response.text();
      const type = response.headers.get('content-type') ?? '';
      const data = text && type.includes('json') ? JSON.parse(text) as Record<string, any> : {};
      if (typeof data.csrfToken === 'string') this.csrf = data.csrfToken;
      return { status: response.status, data, text, setCookies };
    }
  }

  function mergeCookies(previous: string, pair: string): string {
    const cookies = new Map(previous.split('; ').filter(Boolean).map((value) => {
      const name = value.split('=')[0] ?? '';
      return [name, value] as const;
    }));
    cookies.set(pair.split('=')[0] ?? '', pair);
    return [...cookies.values()].join('; ');
  }

  function signupOnly(cookie: string): string {
    return cookie.split('; ').filter((part) => part.startsWith(`${SIGNUP_COOKIE}=`)).join('; ');
  }

  async function proofFor(api: Api, email: string): Promise<{ proof: string; challenge: Challenge; setCookies: string[] }> {
    const issued = await api.fetch(`/api/auth/registration-challenge?email=${encodeURIComponent(email)}`);
    assert.equal(issued.status, 200, issued.text);
    const challenge = issued.data as Challenge;
    const solution = await solveChallenge({ challenge, deriveKey, timeout: 60_000 });
    assert.ok(solution);
    const proof = Buffer.from(JSON.stringify({ challenge, solution })).toString('base64');
    return { proof, challenge, setCookies: issued.setCookies };
  }

  async function codeFor(email: string): Promise<string> {
    const row = await ctx.pool.query<{ body: string }>(
      'SELECT body FROM email_outbox WHERE to_email = $1 ORDER BY created_at DESC LIMIT 1',
      [email],
    );
    const code = row.rows[0]?.body.match(/验证码是 (\d{6})/)?.[1];
    assert.ok(code);
    return code;
  }

  function profile(n: number, email: string) {
    seq += 1;
    return {
      name: '考生甲',
      studentNo: `8${String(n).padStart(7, '0')}`.slice(0, 8),
      college: '计算机',
      major: '软件工程',
      phone: '13800138000',
      email,
      password: 'Student-pass-1',
      acceptedPolicy: true,
    };
  }

  describe('registration protection', { concurrency: 1, timeout: 180_000 }, () => {
    before(async () => {
      if (!/^assessment_antibot_[0-9]+$/.test(schema)) throw new Error('refusing unsafe test schema');
      process.env.DATABASE_URL = databaseUrl;
      process.env.DB_SCHEMA = schema;
      process.env.NODE_ENV = 'test';
      process.env.APP_ORIGIN = origin;
      process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
      process.env.SESSION_SECRET = 'test-session-secret-32chars-minimum';
      process.env.ADMIN_EMAIL = 'admin@example.com';
      process.env.ADMIN_PASSWORD = 'Admin-pass-123';
      process.env.ADMIN_NAME = '管理员';
      process.env.PG_POOL_MAX = '10';
      delete process.env.SEED_DEMO;
      delete process.env.SMTP_HOST;
      delete process.env.MAIL_TEST_SINK;
      delete process.env.REGISTRATION_MAIL_HOURLY_BUDGET;
      delete process.env.REGISTRATION_MAIL_DAILY_BUDGET;
      delete process.env.REGISTRATION_QUEUE_LIMIT;
      const prep = new Pool({ connectionString: databaseUrl });
      await prep.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await prep.query(`CREATE SCHEMA ${schema}`);
      await prep.end();
      const pool = createPool(databaseUrl, schema);
      const client = await pool.connect();
      try {
        for (const id of ['001_init', '002_oauth', '003_direct_upload', '004_admin_deletion', '005_exam_duration', '006_registration_protection']) {
          const url = new URL(`../migrations/${id}.sql`, import.meta.url);
          try {
            await access(url);
          } catch {
            if (id === '005_exam_duration') continue;
            throw new Error(`missing migration ${id}`);
          }
          await client.query(await readFile(url, 'utf8'));
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
        }
      } finally {
        client.release();
      }
      const loaded = loadConfig(process.env);
      ctx = { pool, config: loaded.config };
      await bootstrapAdmin(pool, loaded.startup);
      const app = express();
      app.disable('x-powered-by');
      app.use(cors(ctx));
      app.use(originGuard(ctx));
      app.use('/api', express.json({ limit: '1mb' }));
      app.use(sessionLoader(ctx));
      app.use(csrfGuard);
      const router = express.Router();
      router.get('/auth/registration-challenge', async (req, res, next) => {
        try {
          res.json(await issueRegistrationChallenge(ctx, req, res));
        } catch (error) {
          next(error);
        }
      });
      router.post('/auth/email-code', async (req, res, next) => {
        try {
          res.json(await requestEmailCode(ctx, req));
        } catch (error) {
          next(error);
        }
      });
      router.post('/auth/register', async (req, res, next) => {
        try {
          const result = await registerAccount(ctx, req);
          sendSession(res, ctx, result.sessionId, req);
          res.json({ user: result.user, csrfToken: result.csrfToken });
        } catch (error) {
          next(error);
        }
      });
      router.post('/auth/login', async (req, res, next) => {
        try {
          const result = await loginAccount(ctx, req);
          sendSession(res, ctx, result.sessionId, req);
          res.json({ user: result.user, csrfToken: result.csrfToken });
        } catch (error) {
          next(error);
        }
      });
      router.post('/auth/reset-password', async (req, res, next) => {
        try {
          res.json(await resetPassword(ctx, req));
        } catch (error) {
          next(error);
        }
      });
      registerCandidateRisk(router, ctx);
      app.use('/api', router);
      app.use(errorHandler);
      server = createServer(app);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      base = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ctx) await ctx.pool.end();
      if (/^assessment_antibot_[0-9]+$/.test(schema)) {
        const prep = new Pool({ connectionString: databaseUrl });
        await prep.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await prep.end();
      }
    });

    beforeEach(async () => {
      await ctx.pool.query(`TRUNCATE registration_challenges, registration_buckets, email_outbox, email_challenges, audit_events, sessions, users RESTART IDENTITY CASCADE`);
      await bootstrapAdmin(ctx.pool, {
        adminEmail: 'admin@example.com',
        adminPassword: 'Admin-pass-123',
        adminName: '管理员',
        databaseUrl,
      });
      ctx.config.registrationMailHourlyBudget = 300;
      ctx.config.registrationMailDailyBudget = 1500;
      ctx.config.registrationQueueLimit = 200;
    });

    test('embedded registration uses a separate partitioned cookie and cannot consume a regular browser proof', async () => {
      const previous = { secure: ctx.config.cookieSecure, origins: ctx.config.embeddingOrigins };
      ctx.config.cookieSecure = true;
      ctx.config.embeddingOrigins = ['https://portal.example.test'];
      try {
        const api = new Api();
        const email = 'embedded@example.com';
        const headers = { 'x-lab-embedded': '1' };
        const issued = await api.fetch(`/api/auth/registration-challenge?email=${email}`, { headers });
        assert.equal(issued.status, 200, issued.text);
        const cookie = issued.setCookies.find(c => c.startsWith(EMBED_SIGNUP_COOKIE + '='));
        assert.ok(cookie);
        for (const part of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned']) assert.ok(cookie.includes(part));
        api.cookie = cookie.split(';')[0]!;
        const challenge = issued.data as unknown as Challenge;
        const solution = await solveChallenge({ challenge, deriveKey, timeout: 60_000 });
        assert.ok(solution);
        const body = JSON.stringify({ email, purpose: 'REGISTER', registrationProof: Buffer.from(JSON.stringify({ challenge, solution })).toString('base64') });
        // A first-party request must not accept the embedded browser cookie.
        assert.equal((await api.fetch('/api/auth/email-code', { method: 'POST', body })).status, 400);
        assert.equal((await api.fetch('/api/auth/email-code', { method: 'POST', headers, body })).status, 200);
        assert.equal((await api.fetch('/api/auth/email-code', { method: 'POST', headers, body })).status, 400);
        const regular = new Api();
        const normal = await regular.fetch('/api/auth/registration-challenge?email=regular@example.com');
        assert.match(normal.setCookies[0]!, /SameSite=Lax/);
        assert.doesNotMatch(normal.setCookies[0]!, /Partitioned/);
        ctx.config.embeddingOrigins = [];
        assert.equal((await api.fetch('/api/auth/registration-challenge?email=disabled@example.com', { headers })).status, 403);
      } finally {
        ctx.config.cookieSecure = previous.secure;
        ctx.config.embeddingOrigins = previous.origins;
      }
    });

    test('stops challenge issuance before storing another challenge when the IP bucket is empty', async () => {
      const api = new Api();
      const first = await api.fetch(`/api/auth/registration-challenge?email=${encodeURIComponent('gate@example.com')}`);
      assert.equal(first.status, 200, first.text);
      const before = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM registration_challenges');
      await ctx.pool.query(
        `UPDATE registration_buckets SET tokens = 0, updated_at = clock_timestamp() WHERE bucket = 'register-issue-ip-minute'`,
      );
      const blocked = await api.fetch(`/api/auth/registration-challenge?email=${encodeURIComponent('gate2@example.com')}`);
      assert.equal(blocked.status, 429);
      assert.equal(blocked.data.code, 'RATE_LIMITED');
      const after = await ctx.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM registration_challenges');
      assert.equal(after.rows[0]?.n, before.rows[0]?.n);
    });

    test('rejects missing, forged, mismatched, replayed, and expired proofs', async () => {
      const api = new Api();
      const missing = await api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: 'missing@example.com', purpose: 'REGISTER' }),
      });
      assert.equal(missing.status, 400);
      assert.equal(missing.data.code, 'REGISTRATION_PROOF_REQUIRED');

      const forged = await api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({
          email: 'forged@example.com',
          purpose: 'REGISTER',
          registrationProof: Buffer.from(JSON.stringify({
            challenge: {
              signature: 'a'.repeat(64),
              parameters: {
                algorithm: 'PBKDF2/SHA-256',
                nonce: 'ab'.repeat(16),
                salt: 'cd'.repeat(16),
                cost: 1,
                keyLength: 32,
                keyPrefix: '00',
                data: { id: '11111111-1111-4111-8111-111111111111' },
              },
            },
            solution: { counter: 1, derivedKey: 'e'.repeat(64) },
          })).toString('base64'),
        }),
      });
      assert.equal(forged.status, 400);
      assert.equal(forged.data.code, 'INVALID');

      const issued = await proofFor(api, 'real@example.com');
      const cookie = issued.setCookies.find((item) => item.startsWith(`${SIGNUP_COOKIE}=`)) ?? '';
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Lax/);
      assert.doesNotMatch(cookie, /Secure/);
      assert.equal(issued.challenge.parameters.algorithm, 'PBKDF2/SHA-256');
      assert.equal(issued.challenge.parameters.cost, 1000);
      assert.deepEqual(issued.challenge.parameters.data, { id: issued.challenge.parameters.data?.id });
      assert.equal(JSON.stringify(issued.challenge).includes('real@example.com'), false);
      const stored = await ctx.pool.query<{ challenge_json: { parameters?: { data?: unknown } } }>(
        'SELECT challenge_json FROM registration_challenges WHERE email = $1',
        ['real@example.com'],
      );
      assert.deepEqual(stored.rows[0]?.challenge_json.parameters?.data, { id: issued.challenge.parameters.data?.id });
      assert.equal(JSON.stringify(stored.rows[0]?.challenge_json).includes('@'), false);

      const tampered = JSON.parse(JSON.stringify(issued.challenge)) as Challenge;
      tampered.parameters = { ...tampered.parameters, cost: 50_000 };
      const started = performance.now();
      const cheap = await api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({
          email: 'real@example.com',
          purpose: 'REGISTER',
          registrationProof: Buffer.from(JSON.stringify({
            challenge: tampered,
            solution: { counter: 1, derivedKey: 'f'.repeat(64) },
          })).toString('base64'),
        }),
      });
      assert.equal(cheap.status, 400);
      assert.equal(cheap.data.code, 'INVALID');
      assert.ok(performance.now() - started < 500);

      const mismatch = await api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: 'other@example.com', purpose: 'REGISTER', registrationProof: issued.proof }),
      });
      assert.equal(mismatch.status, 400);
      assert.equal(mismatch.data.code, 'INVALID');
      const mismatchedMail = await ctx.pool.query('SELECT 1 FROM email_outbox WHERE to_email = $1', ['other@example.com']);
      assert.equal(mismatchedMail.rowCount, 0);

      const sent = await api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: 'real@example.com', purpose: 'REGISTER', registrationProof: issued.proof }),
      });
      assert.equal(sent.status, 200, sent.text);
      assert.equal(sent.text.includes('验证码是'), false);
      const replay = await api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: 'real@example.com', purpose: 'REGISTER', registrationProof: issued.proof }),
      });
      assert.equal(replay.status, 400);
      assert.equal(replay.data.code, 'INVALID');
      const mails = await ctx.pool.query('SELECT id FROM email_outbox WHERE to_email = $1', ['real@example.com']);
      assert.equal(mails.rowCount, 1);

      const second = new Api();
      second.cookie = signupOnly(api.cookie);
      const expiring = await proofFor(second, 'expire@example.com');
      await ctx.pool.query(
        `UPDATE registration_challenges
         SET expires_at = clock_timestamp() - interval '1 minute'
         WHERE email = $1 AND consumed_at IS NULL`,
        ['expire@example.com'],
      );
      const expired = await second.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: 'expire@example.com', purpose: 'REGISTER', registrationProof: expiring.proof }),
      });
      assert.equal(expired.status, 400);
      assert.equal(expired.data.code, 'INVALID');
    });

    test('cooldown and queue budgets are atomic and do not block reset', async () => {
      const api = new Api();
      const first = await proofFor(api, 'cool@example.com');
      const second = await proofFor(api, 'cool@example.com');
      const raced = await Promise.all([
        api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email: 'cool@example.com', purpose: 'REGISTER', registrationProof: first.proof }) }),
        api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email: 'cool@example.com', purpose: 'REGISTER', registrationProof: second.proof }) }),
      ]);
      const statuses = raced.map((item) => item.status).sort();
      assert.deepEqual(statuses, [200, 429]);
      const limited = raced.find((item) => item.status === 429);
      assert.equal(limited?.data.code, 'RATE_LIMITED');
      const outbox = await ctx.pool.query('SELECT id FROM email_outbox WHERE to_email = $1', ['cool@example.com']);
      assert.equal(outbox.rowCount, 1);
      const third = await proofFor(api, 'cool@example.com');
      const direct = await requestEmailCode(ctx, {
        body: { email: 'cool@example.com', purpose: 'REGISTER', registrationProof: third.proof },
        ip: '127.0.0.1',
        socket: { remoteAddress: '127.0.0.1' },
        header(name: string) {
          return name.toLowerCase() === 'cookie' ? api.cookie : undefined;
        },
      } as Request).catch((error: unknown) => error);
      assert.ok(direct instanceof RegistrationLimitError);
      assert.equal(direct.status, 429);
      assert.ok(direct.retryAfterSeconds >= 1 && direct.retryAfterSeconds <= 60);

      await ctx.pool.query(`UPDATE email_outbox SET status = 'SENT' WHERE idempotency_key LIKE 'register-code:%'`);
      ctx.config.registrationQueueLimit = 2;
      const queued: Array<{ email: string; proof: string }> = [];
      for (let i = 0; i < 4; i += 1) {
        const email = `queue${i}@example.com`;
        const solved = await proofFor(api, email);
        queued.push({ email, proof: solved.proof });
      }
      const results = await Promise.all(queued.map((item) => api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: item.email, purpose: 'REGISTER', registrationProof: item.proof }),
      })));
      assert.equal(results.filter((item) => item.status === 200).length, 2);
      assert.equal(results.filter((item) => item.status === 429).length, 2);
      const pending = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM email_outbox
         WHERE status IN ('PENDING', 'SENDING') AND idempotency_key LIKE 'register-code:%'`,
      );
      assert.equal(pending.rows[0]?.n, 2);

      const reset = await api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: 'admin@example.com', purpose: 'RESET' }),
      });
      assert.equal(reset.status, 200, reset.text);
      const logged = await api.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ account: 'admin@example.com', password: 'Admin-pass-123' }),
      });
      assert.equal(logged.status, 200, logged.text);
    });

    test('rolling mail budget survives token refill and concurrent sends', async () => {
      ctx.config.registrationMailHourlyBudget = 2;
      const api = new Api();
      for (const n of [0, 1]) {
        const email = `budget${n}@example.com`;
        const solved = await proofFor(api, email);
        const sent = await api.fetch('/api/auth/email-code', {method:'POST', body:JSON.stringify({email,purpose:'REGISTER',registrationProof:solved.proof})});
        assert.equal(sent.status, 200, sent.text);
      }
      // Refill the burst limiter; the rolling monetary cap must still hold.
      await ctx.pool.query("UPDATE registration_buckets SET updated_at=clock_timestamp()-interval '1 day'");
      const email = 'budget-next@example.com';
      const solved = await proofFor(api, email);
      const limited = await api.fetch('/api/auth/email-code', {method:'POST',body:JSON.stringify({email,purpose:'REGISTER',registrationProof:solved.proof})});
      assert.equal(limited.status,429);
      assert.ok(limited.data.retryAfterSeconds > 3500);
      const proof = await ctx.pool.query('SELECT consumed_at FROM registration_challenges WHERE email=$1',[email]);
      assert.equal(proof.rows[0]?.consumed_at,null);
      await ctx.pool.query("UPDATE email_outbox SET created_at=clock_timestamp()-interval '61 minutes' WHERE idempotency_key LIKE 'register-code:%'");
      const sent = await api.fetch('/api/auth/email-code', {method:'POST',body:JSON.stringify({email,purpose:'REGISTER',registrationProof:solved.proof})});
      assert.equal(sent.status,200,sent.text);
    });

    test('checks the email code before hashing and consumes it once', async () => {
      const api = new Api();
      const solved = await proofFor(api, 'once@example.com');
      const sent = await api.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: 'once@example.com', purpose: 'REGISTER', registrationProof: solved.proof }),
      });
      assert.equal(sent.status, 200, sent.text);
      const code = await codeFor('once@example.com');
      const hashStarted = performance.now();
      await hashPassword('Student-pass-1');
      const hashMs = performance.now() - hashStarted;
      const wrongStarted = performance.now();
      const wrong = await api.fetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ ...profile(1, 'once@example.com'), challengeId: sent.data.challengeId, code: code === '000000' ? '000001' : '000000' }),
      });
      const wrongMs = performance.now() - wrongStarted;
      assert.equal(wrong.status, 400);
      assert.equal(wrong.data.code, 'CODE_INVALID');
      const attempt = await ctx.pool.query<{ attempts: number; consumed_at: Date | null }>(
        'SELECT attempts, consumed_at FROM email_challenges WHERE id = $1',
        [sent.data.challengeId],
      );
      assert.equal(attempt.rows[0]?.attempts, 1);
      assert.equal(attempt.rows[0]?.consumed_at, null);
      const users = await ctx.pool.query(`SELECT id FROM users WHERE email = 'once@example.com'`);
      assert.equal(users.rowCount, 0);
      if (hashMs > 40) assert.ok(wrongMs < hashMs, `wrong code took ${wrongMs}ms, hash took ${hashMs}ms`);

      const body = { ...profile(1, 'once@example.com'), challengeId: sent.data.challengeId, code };
      const firstPromise = api.fetch('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
      const consumed = await waitFor(async () => {
        const row = await ctx.pool.query<{ consumed_at: Date | null }>(
          'SELECT consumed_at FROM email_challenges WHERE id = $1',
          [sent.data.challengeId],
        );
        return Boolean(row.rows[0]?.consumed_at);
      });
      assert.equal(consumed, true);
      const secondStarted = performance.now();
      const second = await api.fetch('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
      const secondMs = performance.now() - secondStarted;
      assert.equal(second.status, 400);
      assert.equal(second.data.code, 'CODE_INVALID');
      if (hashMs > 40) assert.ok(secondMs < hashMs, `reused code took ${secondMs}ms, hash took ${hashMs}ms`);
      const first = await firstPromise;
      assert.equal(first.status, 200, first.text);
      const created = await ctx.pool.query(`SELECT id FROM users WHERE email = 'once@example.com'`);
      assert.equal(created.rowCount, 1);
    });

    test('flags shared browsers and IPs without blocking start until an admin says so', async () => {
      const browser = new Api();
      const users: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        const email = `crowd${i}@example.com`;
        const solved = await proofFor(browser, email);
        const sent = await browser.fetch('/api/auth/email-code', {
          method: 'POST',
          body: JSON.stringify({ email, purpose: 'REGISTER', registrationProof: solved.proof }),
        });
        assert.equal(sent.status, 200, sent.text);
        const code = await codeFor(email);
        const created = await browser.fetch('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ ...profile(20 + i, email), challengeId: sent.data.challengeId, code }),
        });
        assert.equal(created.status, 200, created.text);
        users.push(created.data.user.id as string);
        browser.cookie = signupOnly(browser.cookie);
        browser.csrf = '';
      }
      const flags = await ctx.pool.query<{ user_id: string; risk_reasons: string[]; review_state: string; start_restricted: boolean }>(
        `SELECT user_id, risk_reasons, review_state, start_restricted
         FROM user_registration_risk WHERE user_id = ANY($1::uuid[]) ORDER BY created_at`,
        [users],
      );
      assert.equal(flags.rows.length, 3);
      assert.deepEqual(flags.rows[0]?.risk_reasons, []);
      assert.deepEqual(flags.rows[1]?.risk_reasons, []);
      assert.deepEqual(flags.rows[2]?.risk_reasons, ['BROWSER_3_ACCOUNTS_DAY']);
      assert.equal(flags.rows[2]?.review_state, 'PENDING');
      assert.equal(flags.rows.every((row) => row.start_restricted === false), true);
      const raw = await ctx.pool.query<{ ip_hash: string; browser_hash: string }>(
        'SELECT ip_hash, browser_hash FROM user_registration_risk WHERE user_id = $1',
        [users[2]],
      );
      assert.match(raw.rows[0]?.ip_hash ?? '', /^[0-9a-f]{64}$/);
      assert.equal(JSON.stringify(raw.rows).includes('127.'), false);

      const seededIp = raw.rows[0]?.ip_hash ?? '';
      for (let i = 0; i < 29; i += 1) {
        const inserted = await ctx.pool.query<{ id: string }>(
          `INSERT INTO users (role, name, student_no, college, major, phone, email, password_hash)
           VALUES ('CANDIDATE', '批量', $1, '计算机', '软件', '13800138000', $2, 'x') RETURNING id`,
          [`7${String(i).padStart(7, '0')}`.slice(0, 8), `seed${i}@example.com`],
        );
        await ctx.pool.query(
          `INSERT INTO user_registration_risk (user_id, ip_hash, browser_hash, risk_reasons, review_state, start_restricted)
           VALUES ($1, $2, $3, '[]'::jsonb, 'CLEARED', false)`,
          [inserted.rows[0]?.id, seededIp, `${'a'.repeat(63)}${i % 10}`],
        );
      }
      const ipApi = new Api();
      const ipEmail = 'ip30@example.com';
      const ipProof = await proofFor(ipApi, ipEmail);
      const ipSent = await ipApi.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: ipEmail, purpose: 'REGISTER', registrationProof: ipProof.proof }),
      });
      assert.equal(ipSent.status, 200, ipSent.text);
      const ipCode = await codeFor(ipEmail);
      const ipUser = await ipApi.fetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ ...profile(90, ipEmail), challengeId: ipSent.data.challengeId, code: ipCode }),
      });
      assert.equal(ipUser.status, 200, ipUser.text);
      const ipRisk = await ctx.pool.query<{ risk_reasons: string[]; start_restricted: boolean }>(
        'SELECT risk_reasons, start_restricted FROM user_registration_risk WHERE user_id = $1',
        [ipUser.data.user.id],
      );
      assert.equal(ipRisk.rows[0]?.risk_reasons.includes('IP_30_ACCOUNTS_DAY'), true);
      assert.equal(ipRisk.rows[0]?.start_restricted, false);

      const admin = new Api();
      const logged = await admin.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ account: 'admin@example.com', password: 'Admin-pass-123' }),
      });
      assert.equal(logged.status, 200, logged.text);
      const adminId = logged.data.user.id as string;
      const listed = await admin.fetch(`/api/admin/registration-risk?ids=${users[2]},${adminId},00000000-0000-4000-8000-000000000099`);
      assert.equal(listed.status, 200, listed.text);
      assert.equal(listed.data.risks.length, 1);
      assert.equal(listed.data.risks[0].userId, users[2]);
      assert.deepEqual(listed.data.risks[0].reasons, ['BROWSER_3_ACCOUNTS_DAY']);
      assert.equal(listed.data.risks[0].reviewState, 'PENDING');
      assert.equal(listed.data.risks[0].startRestricted, false);
      assert.equal(listed.data.risks[0].restrictionReason, null);
      const tooMany = await admin.fetch(`/api/admin/registration-risk?ids=${Array.from({ length: 101 }, () => users[2]).join(',')}`);
      assert.equal(tooMany.status, 400);

      const round = await ctx.pool.query<{ id: string }>(`INSERT INTO rounds (name) VALUES ('在考轮次') RETURNING id`);
      const batch = await ctx.pool.query<{ id: string }>(
        `INSERT INTO batches (round_id, name, opens_at, start_closes_at, duration_hours, status)
         VALUES ($1, '批', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '2 days', 24, 'OPEN')
         RETURNING id`,
        [round.rows[0]?.id],
      );
      const active = await ctx.pool.query<{ id: string }>(
        `INSERT INTO enrollments (user_id, round_id, batch_id, direction, started_at, deadline, duration_hours)
         VALUES ($1, $2, $3, 'PRODUCT', clock_timestamp(), clock_timestamp() + interval '24 hours', 24)
         RETURNING id`,
        [users[2], round.rows[0]?.id, batch.rows[0]?.id],
      );
      const freshRound = await ctx.pool.query<{ id: string }>(`INSERT INTO rounds (name) VALUES ('未开始轮次') RETURNING id`);
      const fresh = await ctx.pool.query<{ id: string }>(
        `INSERT INTO enrollments (user_id, round_id, batch_id, direction)
         VALUES ($1, $2, $3, 'PRODUCT') RETURNING id`,
        [users[2], freshRound.rows[0]?.id, batch.rows[0]?.id],
      );
      const longReason = '限制原因'.padEnd(500, '。');
      const restricted = await admin.fetch(`/api/admin/candidates/${users[2]}/registration-risk`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'RESTRICT_START', reason: longReason }),
      });
      assert.equal(restricted.status, 200, restricted.text);
      assert.equal(restricted.data.risk.startRestricted, true);
      assert.equal(restricted.data.risk.restrictionReason, longReason);
      const again = await admin.fetch(`/api/admin/candidates/${users[2]}/registration-risk`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'RESTRICT_START', reason: '再次限制' }),
      });
      assert.equal(again.status, 200, again.text);
      const kept = await ctx.pool.query<{ restricted_at: Date; restriction_reason: string }>(
        'SELECT restricted_at, restriction_reason FROM user_registration_risk WHERE user_id = $1',
        [users[2]],
      );
      assert.equal(kept.rows[0]?.restriction_reason, '再次限制');
      const activeStill = await withTx(ctx.pool, async (client) => {
        const row = await client.query<{ started_at: Date | null }>('SELECT started_at FROM enrollments WHERE id = $1 FOR UPDATE', [active.rows[0]?.id]);
        if (row.rows[0]?.started_at) return 'active';
        await assertCandidateCanStart(client, users[2] ?? '');
        return 'new';
      });
      assert.equal(activeStill, 'active');
      await assert.rejects(
        () => withTx(ctx.pool, async (client) => {
          const row = await client.query<{ started_at: Date | null }>('SELECT started_at FROM enrollments WHERE id = $1 FOR UPDATE', [fresh.rows[0]?.id]);
          if (row.rows[0]?.started_at) return;
          await assertCandidateCanStart(client, users[2] ?? '');
        }),
        (error: unknown) => error instanceof HttpError && error.code === 'START_RESTRICTED',
      );
      const candidate = new Api();
      const stillLogsIn = await candidate.fetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ account: 'crowd2@example.com', password: 'Student-pass-1' }),
      });
      assert.equal(stillLogsIn.status, 200, stillLogsIn.text);
      const reset = await candidate.fetch('/api/auth/email-code', {
        method: 'POST',
        body: JSON.stringify({ email: 'crowd2@example.com', purpose: 'RESET' }),
      });
      assert.equal(reset.status, 200, reset.text);
      const audit = await ctx.pool.query<{ action: string; details: { reason?: string } }>(
        `SELECT action, details FROM audit_events WHERE action = 'REGISTRATION_RESTRICT_START' ORDER BY created_at DESC LIMIT 1`,
      );
      assert.equal(audit.rows[0]?.action, 'REGISTRATION_RESTRICT_START');
      assert.equal(audit.rows[0]?.details.reason, '再次限制');
      const longAudit = await ctx.pool.query<{ details: { reason?: string } }>(
        `SELECT details FROM audit_events WHERE action = 'REGISTRATION_RESTRICT_START' ORDER BY created_at ASC LIMIT 1`,
      );
      assert.equal(longAudit.rows[0]?.details.reason?.length, 200);

      const allowed = await admin.fetch(`/api/admin/candidates/${users[2]}/registration-risk`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'ALLOW_START', reason: '复核通过' }),
      });
      assert.equal(allowed.status, 200, allowed.text);
      assert.equal(allowed.data.risk.startRestricted, false);
      await withTx(ctx.pool, async (client) => {
        const row = await client.query<{ started_at: Date | null }>('SELECT started_at FROM enrollments WHERE id = $1 FOR UPDATE', [fresh.rows[0]?.id]);
        if (!row.rows[0]?.started_at) await assertCandidateCanStart(client, users[2] ?? '');
      });
      const cleared = await admin.fetch(`/api/admin/candidates/${users[2]}/registration-risk`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'CLEAR_FLAG', reason: '误报' }),
      });
      assert.equal(cleared.status, 200, cleared.text);
      assert.deepEqual(cleared.data.risk.reasons, []);
      assert.equal(cleared.data.risk.reviewState, 'CLEARED');
      const clearedAgain = await admin.fetch(`/api/admin/candidates/${users[2]}/registration-risk`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'CLEAR_FLAG', reason: '误报' }),
      });
      assert.equal(clearedAgain.status, 200, clearedAgain.text);
      const forbidden = await admin.fetch(`/api/admin/candidates/${adminId}/registration-risk`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'RESTRICT_START', reason: '不行' }),
      });
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.data.code, 'FORBIDDEN');

      await ctx.pool.query(`UPDATE registration_challenges SET expires_at = clock_timestamp() - interval '2 hours'`);
      const removed = await purgeRegistrationProtection(ctx);
      assert.ok(removed >= 1);
      const left = await ctx.pool.query('SELECT id FROM registration_challenges');
      assert.equal(left.rowCount, 0);
    });
  });
}

async function waitFor(check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}
