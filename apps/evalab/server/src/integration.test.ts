import { registrationProof, mergeCookies } from '../test/registration-proof.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMaterialUpload, MAX_MATERIAL_BYTES, CHUNK_BYTES, purgeUploadFiles } from './uploads.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { authenticateMcp, prepareMcpMaterials, probeMcp, submitMcpMaterials } from './assessment.js';
import { bootstrapAdmin } from './bootstrap.js';
import { closeContext, createContext, type AppContext } from './context.js';
import { createApp } from './app.js';
import { hashCanonical, sha256Hex } from './security.js';
import { purgeReleasedHistory } from './retention.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';

if (!databaseUrl) {
  test('postgres integration', { skip: 'set TEST_DATABASE_URL to a disposable database' }, () => {});
} else {
  const schema = `assessment_test_${process.pid}`;
  let ctx: AppContext;
  let server: Server;
  let base = '';
  let storage = '';
  let seq = 0;

  class Api {
    cookie = '';
    csrf = '';
    async fetch(urlPath: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('origin', origin);
      if (this.cookie) headers.set('cookie', this.cookie);
      const method = init.method ?? 'GET';
      if (this.csrf && method !== 'GET') headers.set('x-csrf-token', this.csrf);
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      const res = await fetch(base + urlPath, { ...init, headers });
      for (const item of res.headers.getSetCookie()) {
        const pair = item.split(';')[0] ?? '';
        if (pair.startsWith('lab_session=') || pair.startsWith('lab_signup=')) this.cookie = mergeCookies(this.cookie, pair);
      }
      const text = await res.text();
      const type = res.headers.get('content-type') ?? '';
      const data = text && type.includes('json') ? JSON.parse(text) as Record<string, any> : {};
      if (typeof data.csrfToken === 'string') this.csrf = data.csrfToken;
      return { status: res.status, data, text };
    }
  }

  async function codeFor(email: string): Promise<string> {
    const row = await ctx.pool.query<{ body: string }>('SELECT body FROM email_outbox WHERE to_email = $1 ORDER BY created_at DESC LIMIT 1', [email]);
    const code = row.rows[0]?.body.match(/验证码是 (\d{6})/)?.[1];
    assert.ok(code);
    return code;
  }

  async function register(api: Api, email: string, studentNo: string, name = '考生甲') {
    const sent = await api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email, purpose: 'REGISTER', registrationProof: await registrationProof(api, email) }) });
    assert.equal(sent.status, 200);
    assert.equal(sent.text.includes('验证码是'), false);
    const code = await codeFor(email);
    const created = await api.fetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name, studentNo, college: '计算机', major: '软件工程', phone: '13800138000',
        email, password: 'Student-pass-1', challengeId: sent.data.challengeId, code, acceptedPolicy: true,
      }),
    });
    assert.equal(created.status, 200, created.text);
    return created;
  }

  async function admin(): Promise<Api> {
    const api = new Api();
    const logged = await api.fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account: 'admin@example.com', password: 'Admin-pass-123' }),
    });
    assert.equal(logged.status, 200, logged.text);
    return api;
  }

  async function uploadPng(api: Api) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const boundary = '----labboundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await api.fetch('/api/admin/attachments', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    assert.equal(uploaded.status, 200, uploaded.text);
    return uploaded.data.attachment.id as string;
  }

  async function uploadNamed(api: Api, filename: string) {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const boundary = '----labboundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await api.fetch('/api/admin/attachments', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    assert.equal(uploaded.status, 200, uploaded.text);
    return uploaded.data.attachment.id as string;
  }

  async function openProduct(api: Api, title: string) {
    seq += 1;
    const round = await api.fetch('/api/admin/rounds', { method: 'POST', body: JSON.stringify({ name: `轮次${seq}` }) });
    assert.equal(round.status, 200, round.text);
    const batch = await api.fetch('/api/admin/batches', {
      method: 'POST',
      body: JSON.stringify({
        roundId: round.data.round.id,
        name: '第一批',
        description: '说明',
        opensAt: new Date(Date.now() - 3600_000).toISOString(),
        startClosesAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
        durationHours: 24,
        status: 'OPEN',
      }),
    });
    assert.equal(batch.status, 200, batch.text);
    const attachmentId = await uploadPng(api);
    const question = await api.fetch('/api/admin/questions', {
      method: 'POST',
      body: JSON.stringify({
        batchId: batch.data.batch.id,
        direction: 'PRODUCT',
        title,
        content: `题干-${title}`,
        published: true,
        attachmentIds: [attachmentId],
      }),
    });
    assert.equal(question.status, 200, question.text);
    return { batchId: batch.data.batch.id as string, attachmentId, roundId: round.data.round.id as string };
  }

  async function enrollAndConsent(api: Api, batchId: string) {
    const enrolled = await api.fetch('/api/enrollments', {
      method: 'POST',
      body: JSON.stringify({ batchId, direction: 'PRODUCT' }),
    });
    assert.equal(enrolled.status, 200, enrolled.text);
    const id = enrolled.data.enrollment.id as string;
    const consent = await api.fetch(`/api/enrollments/${id}/consent`, {
      method: 'POST',
      body: JSON.stringify({ version: 'assessment-consent-v1', accepted: true }),
    });
    assert.equal(consent.status, 200, consent.text);
    return id;
  }

  function payloadFor(repoSha: string, content = 'history for this exam only') {
    const file = {
      name: 'history.txt',
      sha256: sha256Hex(content),
      bytes: Buffer.byteLength(content),
      source: 'cursor-export',
      coverage: 'partial' as const,
    };
    const manifest = {
      files: [file],
      clients: [{ name: 'cursor', models: [{ name: 'unknown', source: 'unknown' as const, parameters: { reason: 'not reported' } }] }],
      projectSummary: 'project summary',
      collaborationSummary: 'collaboration summary',
    };
    const payload = { schemaVersion: 1 as const, repoSha, manifest, files: [{ name: file.name, content }] };
    return { manifest, payload, payloadHash: hashCanonical(payload) };
  }

  describe('postgres integration', { concurrency: 1, timeout: 120_000 }, () => {
    before(async () => {
      if (!/^assessment_test_[0-9]+$/.test(schema)) throw new Error('refusing unsafe test schema');
      storage = await mkdtemp(path.join(tmpdir(), 'lab-assess-'));
      process.env.DATABASE_URL = databaseUrl;
      process.env.DB_SCHEMA = schema;
      process.env.NODE_ENV = 'test';
      process.env.APP_ORIGIN = origin;
      process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3000';
      process.env.SESSION_SECRET = 'test-session-secret-32chars-minimum';
      process.env.MAIL_TEST_SINK = 'true';
      process.env.ADMIN_EMAIL = 'admin@example.com';
      process.env.ADMIN_PASSWORD = 'Admin-pass-123';
      process.env.ADMIN_NAME = '管理员';
      process.env.STORAGE_DIR = storage;
      delete process.env.SEED_DEMO;
      delete process.env.SMTP_HOST;
      const prep = new Pool({ connectionString: databaseUrl });
      await prep.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await prep.end();
      ctx = await createContext();
      const app = createApp(ctx);
      server = createServer(app);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('no port');
      base = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ctx) await closeContext(ctx);
      if (databaseUrl && /^assessment_test_[0-9]+$/.test(schema)) {
        const prep = new Pool({ connectionString: databaseUrl });
        await prep.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await prep.end();
      }
      if (storage) await rm(storage, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await ctx.pool.query(`TRUNCATE registration_challenges, registration_buckets, users, sessions, email_challenges, rate_limits, rounds, batches, attachments,
        questions, question_attachments, question_versions, enrollments, mcp_tokens, repository_previews,
        repositories, material_approvals, materials, finalize_receipts, reviews, audit_events, email_outbox
        RESTART IDENTITY CASCADE`);
      await bootstrapAdmin(ctx.pool, {
        adminEmail: 'admin@example.com',
        adminPassword: 'Admin-pass-123',
        adminName: '管理员',
        databaseUrl: databaseUrl ?? '',
      });
      ctx.repoFetcher = async (input) => ({
        url: 'https://github.com/octocat/Hello-World',
        branch: input.branch || 'main',
        sha: 'a'.repeat(40),
        message: 'demo',
        author: 'octocat',
        committedAt: new Date().toISOString(),
      });
    });

    test('auth codes are one-time, throttled, and CSRF/origin protected', async () => {
      const email = 'stu1@example.com';
      const api = new Api();
      const health = await api.fetch('/api/health');
      assert.deepEqual(health.data, { status: 'ok', database: 'ok' });
      // Markdown may embed HTTPS diagrams; scripts and frames remain restricted.
      const securityResponse = await fetch(base + '/api/health');
      const policy = securityResponse.headers.get('content-security-policy') ?? '';
      assert.match(policy, /(?:^|;)\s*img-src 'self' https: data:/);
      assert.match(policy, /(?:^|;)\s*script-src 'self';/);
      assert.match(policy, /(?:^|;)\s*frame-ancestors 'none'/);
      assert.equal(securityResponse.headers.get('referrer-policy'), 'no-referrer');
      await register(api, email, '20260001');
      const me = await api.fetch('/api/auth/me');
      assert.equal(me.data.user.email, email);
      const missing = await fetch(base + '/api/enrollments', {
        method: 'POST',
        headers: { origin, cookie: api.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ batchId: '00000000-0000-4000-8000-000000000001', direction: 'PRODUCT' }),
      });
      assert.equal(missing.status, 403);
      const badOrigin = await fetch(base + '/api/auth/logout', {
        method: 'POST',
        headers: { origin: 'https://evil.example', cookie: api.cookie, 'content-type': 'application/json', 'x-csrf-token': api.csrf },
      });
      assert.equal(badOrigin.status, 403);
      const again = await api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email, purpose: 'REGISTER', registrationProof: await registrationProof(api, email) }) });
      assert.equal(again.status, 409);
      for (let i = 0; i < 5; i += 1) {
        const sent = await api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email: 'fresh@example.com', purpose: 'RESET' }) });
        assert.equal(sent.status, 200);
      }
      const limited = await api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email: 'fresh@example.com', purpose: 'RESET' }) });
      assert.equal(limited.status, 429);
      const resetSent = await api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email, purpose: 'RESET' }) });
      const resetCode = await codeFor(email);
      const reset = await api.fetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email, challengeId: resetSent.data.challengeId, code: resetCode, password: 'Student-pass-2' }),
      });
      assert.equal(reset.status, 200);
      const reused = await api.fetch('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ email, challengeId: resetSent.data.challengeId, code: resetCode, password: 'Student-pass-3' }),
      });
      assert.equal(reused.status, 400);
      await api.fetch('/api/auth/logout', { method: 'POST', body: '{}' });
      const old = await api.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: email, password: 'Student-pass-1' }) });
      assert.equal(old.status, 401);
      const logged = await api.fetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: '20260001', password: 'Student-pass-2' }) });
      assert.equal(logged.status, 200);
      const forbidden = await api.fetch('/api/admin/overview');
      assert.equal(forbidden.status, 403);
    });

    test('one round enrollment, hidden questions, concurrent start, and immutable snapshot', async () => {
      const root = await admin();
      const first = await openProduct(root, '题目甲-隐藏');
      const other = await root.fetch('/api/admin/batches', {
        method: 'POST',
        body: JSON.stringify({
          roundId: first.roundId,
          name: '第二批',
          description: '同轮',
          opensAt: new Date(Date.now() - 3600_000).toISOString(),
          startClosesAt: new Date(Date.now() + 86400_000).toISOString(),
          durationHours: 24,
          status: 'OPEN',
        }),
      });
      const candidate = new Api();
      await register(candidate, 'stu2@example.com', '20260002');
      const id = await enrollAndConsent(candidate, first.batchId);
      const dup = await candidate.fetch('/api/enrollments', { method: 'POST', body: JSON.stringify({ batchId: other.data.batch.id, direction: 'DEVELOPMENT_TEST' }) });
      assert.equal(dup.status, 409);
      const beforeStart = await candidate.fetch(`/api/enrollments/${id}`);
      assert.equal(beforeStart.data.enrollment.question, null);
      assert.equal(beforeStart.text.includes('题目甲-隐藏'), false);
      const blocked = await candidate.fetch(`/api/attachments/${first.attachmentId}`);
      assert.equal(blocked.status, 404);
      const blockedStart = await candidate.fetch(`/api/enrollments/${id}/start`, { method: 'POST', body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }) });
      assert.equal(blockedStart.status, 409);
      const token = await candidate.fetch(`/api/enrollments/${id}/mcp-token`, { method: 'POST', body: '{}' });
      await probeMcp(ctx, await authenticateMcp(ctx, token.data.token));
      const rotated = await candidate.fetch(`/api/enrollments/${id}/mcp-token`, { method: 'POST', body: '{}' });
      await assert.rejects(() => authenticateMcp(ctx, token.data.token));
      const staleProbe = await candidate.fetch(`/api/enrollments/${id}/start`, { method: 'POST', body: JSON.stringify({confirmed:true,expectedDurationHours:24}) });
      assert.equal(staleProbe.status, 409);
      assert.equal(staleProbe.data.code, 'MCP_REQUIRED');
      await probeMcp(ctx, await authenticateMcp(ctx, rotated.data.token));
      const [a, b] = await Promise.all([
        candidate.fetch(`/api/enrollments/${id}/start`, { method: 'POST', body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }) }),
        candidate.fetch(`/api/enrollments/${id}/start`, { method: 'POST', body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }) }),
      ]);
      assert.equal(a.status, 200, a.text);
      assert.equal(b.status, 200, b.text);
      assert.equal(a.data.enrollment.startedAt, b.data.enrollment.startedAt);
      assert.equal(a.data.enrollment.question.title, '题目甲-隐藏');
      const versions = await ctx.pool.query('SELECT count(*)::int AS n FROM question_versions qv JOIN enrollments e ON e.question_version_id = qv.id WHERE e.id = $1', [id]);
      assert.equal(versions.rows[0]?.n, 1);
      await root.fetch(`/api/admin/questions/${(await root.fetch('/api/admin/questions?batchId=' + first.batchId)).data.questions[0].id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: '已改题目', content: '新题干' }),
      });
      const afterEdit = await candidate.fetch(`/api/enrollments/${id}`);
      assert.equal(afterEdit.data.enrollment.question.title, '题目甲-隐藏');
      const file = await candidate.fetch(`/api/attachments/${first.attachmentId}`);
      assert.equal(file.status, 200);
      const changed = await candidate.fetch(`/api/enrollments/${id}`, { method: 'PATCH', body: JSON.stringify({ direction: 'DEVELOPMENT_TEST' }) });
      assert.equal(changed.status, 409);
      const emptyAdmin = await admin();
      const emptyRound = await emptyAdmin.fetch('/api/admin/rounds', { method: 'POST', body: JSON.stringify({ name: '空题库轮' }) });
      const emptyBatch = await emptyAdmin.fetch('/api/admin/batches', {
        method: 'POST',
        body: JSON.stringify({
          roundId: emptyRound.data.round.id,
          name: '空批次',
          description: '无题',
          opensAt: new Date(Date.now() - 1000).toISOString(),
          startClosesAt: new Date(Date.now() + 86400_000).toISOString(),
          durationHours: 24,
          status: 'OPEN',
        }),
      });
      const otherUser = new Api();
      await register(otherUser, 'stu3@example.com', '20260003');
      const emptyId = await enrollAndConsent(otherUser, emptyBatch.data.batch.id);
      const emptyToken = await otherUser.fetch(`/api/enrollments/${emptyId}/mcp-token`, { method: 'POST', body: '{}' });
      await probeMcp(ctx, await authenticateMcp(ctx, emptyToken.data.token));
      const failed = await otherUser.fetch(`/api/enrollments/${emptyId}/start`, { method: 'POST', body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }) });
      assert.equal(failed.status, 409);
      assert.equal(failed.data.code, 'EMPTY_POOL');
      const still = await ctx.pool.query('SELECT started_at FROM enrollments WHERE id = $1', [emptyId]);
      assert.equal(still.rows[0]?.started_at, null);
    });

    test('repo SHA pin, approval, idempotent submit, deadline, and stable finalize receipt', async () => {
      const root = await admin();
      const opened = await openProduct(root, '交卷题');
      const candidate = new Api();
      await register(candidate, 'stu4@example.com', '20260004');
      const id = await enrollAndConsent(candidate, opened.batchId);
      const tokenRes = await candidate.fetch(`/api/enrollments/${id}/mcp-token`, { method: 'POST', body: '{}' });
      const firstToken = tokenRes.data.token as string;
      const identity = await authenticateMcp(ctx, firstToken);
      await probeMcp(ctx, identity);
      const rotated = await candidate.fetch(`/api/enrollments/${id}/mcp-token`, { method: 'POST', body: '{}' });
      await assert.rejects(() => authenticateMcp(ctx, firstToken));
      const currentIdentity = await authenticateMcp(ctx, rotated.data.token as string);
      await probeMcp(ctx, currentIdentity);
      assert.equal((await candidate.fetch(`/api/enrollments/${id}/start`, { method: 'POST', body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }) })).status, 200);
      let sha = 'a'.repeat(40);
      let fetches = 0;
      ctx.repoFetcher = async () => {
        fetches += 1;
        return {
          url: 'https://github.com/octocat/Hello-World',
          branch: 'main',
          sha,
          message: 'pinned',
          author: 'octocat',
          committedAt: '2026-09-01T00:00:00.000Z',
        };
      };
      const preview = await candidate.fetch(`/api/enrollments/${id}/repository/preview`, {
        method: 'POST',
        body: JSON.stringify({ url: 'https://github.com/octocat/Hello-World' }),
      });
      assert.equal(preview.data.preview.sha, sha);
      const afterPreview = fetches;
      const confirmed = await candidate.fetch(`/api/enrollments/${id}/repository/confirm`, {
        method: 'POST',
        body: JSON.stringify({ previewId: preview.data.preview.id }),
      });
      assert.equal(fetches, afterPreview);
      assert.equal(confirmed.data.enrollment.repository.sha, 'a'.repeat(40));
      const badUrl = await candidate.fetch(`/api/enrollments/${id}/repository/preview`, {
        method: 'POST',
        body: JSON.stringify({ url: 'https://user:pass@github.com/octocat/Hello-World' }),
      });
      assert.equal(badUrl.status, 400);
      const first = payloadFor('a'.repeat(40));
      const prepared = await prepareMcpMaterials(ctx, currentIdentity, {
        manifest: first.manifest,
        payloadHash: first.payloadHash,
        repoSha: 'a'.repeat(40),
      });
      await assert.rejects(() => submitMcpMaterials(ctx, currentIdentity, { approvalId: prepared.approvalId, payload: first.payload }));
      const approved = await candidate.fetch(`/api/enrollments/${id}/approvals/${prepared.approvalId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approved: true }),
      });
      assert.equal(approved.status, 200, approved.text);
      const submitted = await submitMcpMaterials(ctx, currentIdentity, { approvalId: prepared.approvalId, payload: first.payload });
      const repeated = await submitMcpMaterials(ctx, currentIdentity, { approvalId: prepared.approvalId, payload: first.payload });
      assert.equal(repeated.receipt.id, submitted.receipt.id);
      sha = 'b'.repeat(40);
      const nextPreview = await candidate.fetch(`/api/enrollments/${id}/repository/preview`, {
        method: 'POST',
        body: JSON.stringify({ url: 'https://github.com/octocat/Hello-World', branch: 'dev' }),
      });
      const rebound = await candidate.fetch(`/api/enrollments/${id}/repository/confirm`, {
        method: 'POST',
        body: JSON.stringify({ previewId: nextPreview.data.preview.id }),
      });
      assert.equal(rebound.data.enrollment.repository.sha, 'b'.repeat(40));
      assert.equal(rebound.data.enrollment.materials, null);
      const stale = await candidate.fetch(`/api/enrollments/${id}/finalize`, {
        method: 'POST',
        body: JSON.stringify({ repositoryId: confirmed.data.enrollment.repository.id, materialsId: submitted.receipt.id, confirmed: true }),
      });
      assert.equal(stale.status, 409);
      const second = payloadFor('b'.repeat(40), 'updated history for this exam');
      const preparedB = await prepareMcpMaterials(ctx, currentIdentity, {
        manifest: second.manifest,
        payloadHash: second.payloadHash,
        repoSha: 'b'.repeat(40),
      });
      await candidate.fetch(`/api/enrollments/${id}/approvals/${preparedB.approvalId}/approve`, {
        method: 'POST',
        body: JSON.stringify({ approved: true }),
      });
      const submittedB = await submitMcpMaterials(ctx, currentIdentity, { approvalId: preparedB.approvalId, payload: second.payload });
      await ctx.pool.query(`UPDATE enrollments SET deadline = now() - interval '1 minute' WHERE id = $1`, [id]);
      const expired = await candidate.fetch(`/api/enrollments/${id}/finalize`, {
        method: 'POST',
        body: JSON.stringify({
          repositoryId: rebound.data.enrollment.repository.id,
          materialsId: submittedB.receipt.id,
          confirmed: true,
        }),
      });
      assert.equal(expired.status, 409);
      const viewed = await candidate.fetch(`/api/enrollments/${id}`);
      assert.equal(viewed.data.enrollment.state, 'EXPIRED');
      const extended = await root.fetch(`/api/admin/enrollments/${id}/extend`, {
        method: 'POST',
        body: JSON.stringify({ minutes: 30, reason: '监考记录的短暂断网' }),
      });
      assert.equal(extended.status, 200, extended.text);
      assert.equal(extended.data.enrollment.state, 'ACTIVE');
      const done = await candidate.fetch(`/api/enrollments/${id}/finalize`, {
        method: 'POST',
        body: JSON.stringify({
          repositoryId: rebound.data.enrollment.repository.id,
          materialsId: submittedB.receipt.id,
          confirmed: true,
        }),
      });
      assert.equal(done.status, 200, done.text);
      const again = await candidate.fetch(`/api/enrollments/${id}/finalize`, {
        method: 'POST',
        body: JSON.stringify({
          repositoryId: rebound.data.enrollment.repository.id,
          materialsId: submittedB.receipt.id,
          confirmed: true,
        }),
      });
      assert.equal(again.data.receipt.id, done.data.receipt.id);
      const stranger = new Api();
      await register(stranger, 'stu5@example.com', '20260005');
      const hidden = await stranger.fetch(`/api/enrollments/${id}/materials`);
      assert.equal(hidden.status, 403);
      assert.equal((await candidate.fetch(`/api/enrollments/${id}/materials`)).status,403,'owner cannot read legacy v1 body');
      const legacyBody=await root.fetch(`/api/enrollments/${id}/materials`);
      assert.equal(legacyBody.status,200);
      assert.ok(legacyBody.data.payload.files[0].content.length>0,'admin retains legacy material review');
      const review = await root.fetch(`/api/admin/enrollments/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ score: 86, feedback: '=1+1' }),
      });
      assert.equal(review.status, 200, review.text);
      const unpublished = await candidate.fetch(`/api/enrollments/${id}`);
      assert.equal(unpublished.data.enrollment.result, null);
      const published = await root.fetch(`/api/admin/enrollments/${id}/publish`, { method: 'POST', body: '{}' });
      assert.equal(published.status, 200, published.text);
      const visible = await candidate.fetch(`/api/enrollments/${id}`);
      assert.equal(visible.data.enrollment.result.score, 86);
      const csv = await root.fetch('/api/admin/export');
      assert.equal(csv.status, 200);
      assert.match(csv.text, /'=1\+1/);
      await ctx.pool.query(`UPDATE reviews SET published_at = now() - interval '91 days' WHERE enrollment_id = $1`, [id]);
      assert.equal(await purgeReleasedHistory(ctx), 2);
      const purged = await root.fetch(`/api/enrollments/${id}/materials`);
      assert.equal(purged.data.purged, true);
      assert.equal(purged.data.payload.files[0].content, '');
    });

    test('different candidates can start the same one-question pool', async () => {
      const root = await admin();
      const opened = await openProduct(root, '并发题');
      const first = new Api();
      const second = new Api();
      await register(first, 'stu6@example.com', '20260006');
      await register(second, 'stu7@example.com', '20260007');
      const left = await enrollAndConsent(first, opened.batchId);
      const right = await enrollAndConsent(second, opened.batchId);
      for (const api of [first, second]) {
        const id = api === first ? left : right;
        const token = await api.fetch(`/api/enrollments/${id}/mcp-token`, { method: 'POST', body: '{}' });
        await probeMcp(ctx, await authenticateMcp(ctx, token.data.token));
      }
      const [a, b] = await Promise.all([
        first.fetch(`/api/enrollments/${left}/start`, { method: 'POST', body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }) }),
        second.fetch(`/api/enrollments/${right}/start`, { method: 'POST', body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }) }),
      ]);
      assert.equal(a.status, 200, a.text);
      assert.equal(b.status, 200, b.text);
      assert.equal(a.data.enrollment.question.title, '并发题');
      assert.equal(b.data.enrollment.question.title, '并发题');
      const span = await ctx.pool.query<{ seconds: string }>(
        `SELECT extract(epoch FROM (deadline - started_at))::text AS seconds FROM enrollments WHERE id = ANY($1::uuid[])`,
        [[left, right]],
      );
      assert.equal(span.rows.length, 2);
      for (const row of span.rows) assert.equal(Number(row.seconds), 24 * 60 * 60);
      const versions = await ctx.pool.query<{ n: number }>(
        `SELECT count(DISTINCT question_version_id)::int AS n FROM enrollments WHERE batch_id = $1 AND started_at IS NOT NULL`,
        [opened.batchId],
      );
      assert.equal(versions.rows[0]?.n, 2);
      const percent = await uploadNamed(root, '100%.png');
      assert.equal(typeof percent, 'string');
    });


    async function activeDirect(consent = true) {
      const root = await admin();
      const opened = await openProduct(root, '原文件上传');
      const api = new Api();
      await register(api, 'direct@example.com', '20260100');
      const id = await enrollAndConsent(api, opened.batchId);
      const token = await api.fetch(`/api/enrollments/${id}/mcp-token`, {method:'POST',body:'{}'});
      const identity = await authenticateMcp(ctx,token.data.token);
      await probeMcp(ctx,identity);
      assert.equal((await api.fetch(`/api/enrollments/${id}/start`,{method:'POST',body:JSON.stringify({confirmed:true,expectedDurationHours:24})})).status,200);
      const preview=await api.fetch(`/api/enrollments/${id}/repository/preview`,{method:'POST',body:JSON.stringify({url:'https://github.com/octocat/Hello-World'})});
      assert.equal((await api.fetch(`/api/enrollments/${id}/repository/confirm`,{method:'POST',body:JSON.stringify({previewId:preview.data.preview.id})})).status,200);
      if(consent)assert.equal((await api.fetch(`/api/enrollments/${id}/consent`,{method:'POST',body:JSON.stringify({version:'assessment-materials-v2',accepted:true})})).status,200);
      const metadata={repoSha:'a'.repeat(40),clients:[{name:'test',models:[{name:'unknown',source:'unknown'}]}],projectSummary:'测试成果',collaborationSummary:'测试协作'};
      return {api,id,identity,metadata};
    }
    function ticketApi(api:Api,ticket:{uploadUrl:string;uploadToken:string}) {
      const url=new URL(ticket.uploadUrl).pathname;
      return (suffix='',method='GET',body?:string|Buffer)=>api.fetch(url+suffix,{method,headers:{authorization:`Bearer ${ticket.uploadToken}`,...(Buffer.isBuffer(body)?{'content-type':'application/octet-stream'}:{})},body});
    }

    test('direct upload preserves original bytes >1MB, resumes, separates consent and returns idempotent receipt',async()=>{
      const {api,id,identity,metadata}=await activeDirect(false);
      await assert.rejects(()=>createMaterialUpload(ctx,identity,metadata),/新版材料说明/);
      assert.equal((await api.fetch(`/api/enrollments/${id}/consent`,{method:'POST',body:JSON.stringify({version:'assessment-materials-v2',accepted:true})})).status,200);
      const ticket=await createMaterialUpload(ctx,identity,metadata), send=ticketApi(api,ticket);
      const content=Buffer.concat([Buffer.from('password=TEST_ONLY_NOT_SECRET\r\n对话原文\r\n'),Buffer.alloc(2*1024*1024,0xff)]);
      const manifest={files:[{name:'history.jsonl',bytes:content.length,sha256:sha256Hex(content),source:'agent-export',coverage:'export'}]};
      assert.equal((await api.fetch(new URL(ticket.uploadUrl).pathname)).status,401,'cookie is not upload authority');
      const listed=await send('/manifest','POST',JSON.stringify(manifest));assert.equal(listed.status,200,listed.text);
      const f=listed.data.files[0];
      assert.equal((await send('/manifest','POST',JSON.stringify(manifest))).data.files[0].id,f.id);
      assert.equal((await send('/complete','POST','{}')).status,409);
      const chunk=await send(`/files/${f.id}?offset=0`,'PUT',content.subarray(0,140096));assert.equal(chunk.status,200,chunk.text);
      assert.equal((await send()).data.files[0].receivedBytes,140096);
      assert.equal((await send(`/files/${f.id}?offset=0`,'PUT',Buffer.from('x'))).status,409);
      assert.equal((await send(`/files/${f.id}?offset=140096`,'PUT',content.subarray(140096))).status,200);
      const done=await send('/complete','POST','{}');assert.equal(done.status,200,done.text);
      assert.deepEqual((await send('/complete','POST','{}')).data,done.data);
      const approvals=await ctx.pool.query('SELECT * FROM material_approvals WHERE enrollment_id=$1',[id]);assert.equal(approvals.rowCount,0,'no approval records needed');
      const root=await admin();
      assert.equal((await api.fetch(`/api/enrollments/${id}/materials`)).status,403,'owner cannot read uploaded material');
      assert.equal((await new Api().fetch(`/api/enrollments/${id}/materials`)).status,401,'anonymous material read denied');
      const doc=await root.fetch(`/api/enrollments/${id}/materials`);assert.equal(doc.status,200);assert.equal(doc.data.payload.schemaVersion,2);assert.equal(doc.data.payload.files[0].content,undefined);
      assert.equal((await api.fetch(doc.data.payload.files[0].downloadUrl)).status,403,'owner cannot download raw material');
      const download=await fetch(base+doc.data.payload.files[0].downloadUrl,{headers:{cookie:root.cookie}});
      assert.equal(download.status,200);assert.match(download.headers.get('content-disposition')??'',/attachment/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()),content,'no cropping or rewriting');
      const other=new Api();await register(other,'other-direct@example.com','20260101');
      assert.equal((await other.fetch(doc.data.payload.files[0].downloadUrl)).status,403);
      const detail=await api.fetch(`/api/enrollments/${id}`);assert.equal(detail.data.enrollment.materialUpload.receivedBytes,content.length);
      assert.equal((await api.fetch(`/api/enrollments/${id}/finalize`,{method:'POST',body:JSON.stringify({repositoryId:detail.data.enrollment.repository.id,materialsId:done.data.receipt.id,confirmed:true})})).status,200);
      assert.equal((await send(`/files/${f.id}?offset=${content.length}`,'PUT',Buffer.from('x'))).status,409);
      assert.equal((await send('/complete','POST','{}')).data.receipt.id,done.data.receipt.id,'receipt retry does not mutate finalized exam');
      await ctx.pool.query("UPDATE enrollments SET deadline=now()-interval '91 days' WHERE id=$1",[id]);
      await purgeReleasedHistory(ctx);await purgeUploadFiles(ctx);
      assert.equal((await root.fetch(doc.data.payload.files[0].downloadUrl)).status,404);
      // Finalized receipt retention intentionally blocks deletion in 001; isolate the added 003 cascades.
      await ctx.pool.query('DELETE FROM finalize_receipts WHERE enrollment_id=$1',[id]);
      await ctx.pool.query('DELETE FROM enrollments WHERE id=$1',[id]);
      assert.equal((await ctx.pool.query('SELECT 1 FROM material_uploads WHERE enrollment_id=$1',[id])).rowCount,0,'enrollment cascades remain valid');
    });

    test('direct upload enforces aggregate1GiB, exact hashes, repository changes, revoked and expired tickets',async()=>{
      const {api,id,identity,metadata}=await activeDirect();
      const ticket=await createMaterialUpload(ctx,identity,metadata),send=ticketApi(api,ticket);
      const file={name:'large.jsonl',bytes:MAX_MATERIAL_BYTES,sha256:'a'.repeat(64),source:'agent-export',coverage:'export'};
      assert.equal((await send('/manifest','POST',JSON.stringify({files:[file,{...file,name:'extra',bytes:1}]}))).status,413);
      assert.equal((await send('/manifest','POST',JSON.stringify({files:[file]}))).status,200);
      const second=await createMaterialUpload(ctx,identity,metadata),next=ticketApi(api,second);
      assert.equal((await send()).status,409,'superseded ticket cannot write');
      const f=(await next('/manifest','POST',JSON.stringify({files:[{...file,bytes:4}]}))).data.files[0];
      assert.equal((await next(`/files/${f.id}?offset=0`,'PUT',Buffer.from('test'))).status,200);
      const bad=await next('/complete','POST','{}');assert.equal(bad.status,409);assert.equal(bad.data.code,'HASH_MISMATCH');
      await ctx.pool.query("UPDATE repositories SET sha=$2 WHERE id=(SELECT repository_id FROM enrollments WHERE id=$1)",[id,'b'.repeat(40)]);
      assert.equal((await next()).data.code,'REPOSITORY_CHANGED');
      await ctx.pool.query("UPDATE repositories SET sha=$2 WHERE id=(SELECT repository_id FROM enrollments WHERE id=$1)",[id,'a'.repeat(40)]);
      await ctx.pool.query('UPDATE mcp_tokens SET revoked_at=now() WHERE id=$1',[identity.mcpTokenId]);
      assert.equal((await next()).status,401);
      await ctx.pool.query('UPDATE mcp_tokens SET revoked_at=NULL WHERE id=$1',[identity.mcpTokenId]);
      await ctx.pool.query("UPDATE material_uploads SET expires_at=now()-interval '1 second' WHERE id=$1",[second.uploadId]);
      assert.equal((await next()).status,401);
    });

    test('replaced uploads release storage, repo change frees reservations, extension preserves live tickets',async()=>{
      const {api,id,identity,metadata}=await activeDirect();
      await ctx.pool.query("UPDATE enrollments SET deadline=now()+interval '5 minutes' WHERE id=$1",[id]);
      const ticket=await createMaterialUpload(ctx,identity,metadata),send=ticketApi(api,ticket);
      const data=Buffer.from('first material');
      const f=(await send('/manifest','POST',JSON.stringify({files:[{name:'raw.txt',bytes:data.length,sha256:sha256Hex(data),source:'agent-export',coverage:'export'}]}))).data.files[0];
      await send(`/files/${f.id}?offset=0`,'PUT',data);
      const root=await admin();
      const extension=await root.fetch(`/api/admin/enrollments/${id}/extend`,{method:'POST',body:JSON.stringify({minutes:10,reason:'上传验收延期'})});
      assert.equal(extension.status,200,extension.text);
      const extended=(await send()).data.expiresAt;assert.ok(new Date(extended).getTime()>new Date(ticket.expiresAt).getTime());
      const done=await send('/complete','POST','{}');assert.equal(done.status,200,done.text);
      const priorDoc=await root.fetch(`/api/enrollments/${id}/materials`);
      const second=await createMaterialUpload(ctx,identity,metadata),next=ticketApi(api,second);
      const f2=(await next('/manifest','POST',JSON.stringify({files:[{name:'raw.txt',bytes:data.length,sha256:sha256Hex(data),source:'agent-export',coverage:'export'}]}))).data.files[0];
      await next(`/files/${f2.id}?offset=0`,'PUT',data);assert.equal((await next('/complete','POST','{}')).status,200);
      await purgeUploadFiles(ctx);
      assert.equal((await root.fetch(priorDoc.data.payload.files[0].downloadUrl)).status,404,'replaced raw files are reclaimed');
      const third=await createMaterialUpload(ctx,identity,metadata);
      const preview=await ctx.pool.query("INSERT INTO repository_previews(enrollment_id,user_id,url,branch,sha,message,author,committed_at,expires_at) SELECT id,user_id,'https://github.com/octocat/Hello-World','main',$2,'test','test',now(),now()+interval '10 minutes' FROM enrollments WHERE id=$1 RETURNING id",[id,'b'.repeat(40)]);
      assert.equal((await api.fetch(`/api/enrollments/${id}/repository/confirm`,{method:'POST',body:JSON.stringify({previewId:preview.rows[0].id})})).status,200);
      assert.equal((await ctx.pool.query('SELECT status FROM material_uploads WHERE id=$1',[third.uploadId])).rows[0].status,'SUPERSEDED');
    });

    test('1GiB real HTTP chunk transfer stays bounded in memory and completes', {skip:process.env.TEST_BIG_MATERIAL_UPLOAD!=='1',timeout:120000},async()=>{
      const {api,identity,metadata}=await activeDirect();
      const ticket=await createMaterialUpload(ctx,identity,metadata),send=ticketApi(api,ticket);
      const chunk=Buffer.alloc(CHUNK_BYTES,0x41),h=createHash('sha256');
      for(let i=0;i<MAX_MATERIAL_BYTES/CHUNK_BYTES;i++)h.update(chunk);
      const f=(await send('/manifest','POST',JSON.stringify({files:[{name:'full-1g.jsonl',bytes:MAX_MATERIAL_BYTES,sha256:h.digest('hex'),source:'agent-export',coverage:'export'}]}))).data.files[0];
      assert.ok(f);
      const baseline=process.memoryUsage().rss;let peak=baseline;
      for(let offset=0;offset<MAX_MATERIAL_BYTES;offset+=CHUNK_BYTES){
        const r=await send(`/files/${f.id}?offset=${offset}`,'PUT',chunk);assert.equal(r.status,200,r.text);peak=Math.max(peak,process.memoryUsage().rss);
      }
      const done=await send('/complete','POST','{}');assert.equal(done.status,200,done.text);
      assert.ok(peak-baseline<256*1024*1024,`Unexpected memory growth: ${peak-baseline}`);
      console.log(JSON.stringify({test:'1GiB raw file',bytes:MAX_MATERIAL_BYTES,chunks:MAX_MATERIAL_BYTES/CHUNK_BYTES,rssGrowth:peak-baseline}));
    });

    test('history includes inactive batches and unpublished retention clears approvals', async () => {
      const root = await admin();
      const opened = await openProduct(root, '历史题');
      const candidate = new Api();
      await register(candidate, 'stu8@example.com', '20260008');
      const id = await enrollAndConsent(candidate, opened.batchId);
      const closed = await root.fetch(`/api/admin/batches/${opened.batchId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'CLOSED' }),
      });
      assert.equal(closed.status, 200, closed.text);
      const listed = await candidate.fetch('/api/batches');
      assert.equal(listed.status, 200, listed.text);
      const ownBatch = listed.data.rounds.flatMap((round: { batches: Array<{ id: string; status: string }> }) => round.batches)
        .find((batch: { id: string }) => batch.id === opened.batchId);
      assert.equal(ownBatch?.status, 'CLOSED');
      const history = await candidate.fetch('/api/enrollments');
      assert.equal(history.status, 200, history.text);
      assert.equal(history.data.enrollments.some((item: { id: string }) => item.id === id), true);
      const token = await candidate.fetch(`/api/enrollments/${id}/mcp-token`, { method: 'POST', body: '{}' });
      await probeMcp(ctx, await authenticateMcp(ctx, token.data.token));
      await ctx.pool.query(`UPDATE batches SET status = 'OPEN', start_closes_at = now() + interval '1 day' WHERE id = $1`, [opened.batchId]);
      assert.equal((await candidate.fetch(`/api/enrollments/${id}/start`, { method: 'POST', body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }) })).status, 200);
      await ctx.pool.query(
        `INSERT INTO material_approvals (enrollment_id, manifest, payload_hash, repo_sha, state, expires_at)
         VALUES ($1, $2::jsonb, $3, $4, 'APPROVED', now() + interval '30 minutes')`,
        [id, JSON.stringify({ files: [], clients: [], projectSummary: 'keep-me', collaborationSummary: 'keep-us' }), 'b'.repeat(64), 'a'.repeat(40)],
      );
      await ctx.pool.query(
        `INSERT INTO materials (enrollment_id, approval_id, repo_sha, sha256, payload, client_count, file_count, coverage)
         SELECT $1, id, $2, $3, $4::jsonb, 1, 1, 'partial' FROM material_approvals WHERE enrollment_id = $1 LIMIT 1`,
        [id, 'a'.repeat(40), 'c'.repeat(64), JSON.stringify({
          schemaVersion: 1,
          repoSha: 'a'.repeat(40),
          manifest: { files: [{ name: 'history.txt', sha256: 'd'.repeat(64), bytes: 4, source: 'cursor-export', coverage: 'partial' }], clients: [{ name: 'cursor', models: [{ name: 'unknown', source: 'unknown' }] }], projectSummary: 'keep-me', collaborationSummary: 'keep-us' },
          files: [{ name: 'history.txt', content: 'note' }],
        })],
      );
      await ctx.pool.query(`UPDATE enrollments SET deadline = now() - interval '91 days' WHERE id = $1`, [id]);
      assert.equal(await purgeReleasedHistory(ctx), 1);
      const stored = await ctx.pool.query<{ content: string; project: string; collaboration: string }>(
        `SELECT m.payload->'files'->0->>'content' AS content,
                a.manifest->>'projectSummary' AS project,
                a.manifest->>'collaborationSummary' AS collaboration
         FROM materials m
         JOIN material_approvals a ON a.enrollment_id = m.enrollment_id
         WHERE m.enrollment_id = $1`,
        [id],
      );
      assert.equal(stored.rows[0]?.content, '');
      assert.equal(stored.rows[0]?.project, '');
      assert.equal(stored.rows[0]?.collaboration, '');
    });
  });
}
