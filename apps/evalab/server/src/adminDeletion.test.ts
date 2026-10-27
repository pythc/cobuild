import { registrationProof, mergeCookies } from '../test/registration-proof.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Pool } from 'pg';
import { executeAdminDeletion, purgeDeletedMaterialFiles } from './adminDeletion.js';
import { bootstrapAdmin } from './bootstrap.js';
import { closeContext, createContext, type AppContext } from './context.js';
import { createApp } from './app.js';
import { HttpError } from './errors.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const origin = 'http://127.0.0.1:5173';

if (!databaseUrl) {
  test('admin deletion', { skip: 'set TEST_DATABASE_URL to a disposable database' }, () => {});
} else {
  const schema = `assessment_del_${process.pid}`;
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
      if (this.csrf && method !== 'GET' && method !== 'HEAD') headers.set('x-csrf-token', this.csrf);
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      const res = await fetch(base + urlPath, { ...init, headers });
      for (const item of res.headers.getSetCookie()) {
        const pair = item.split(';')[0] ?? '';
        if (pair.startsWith('lab_session=') || pair.startsWith('lab_signup=')) this.cookie = mergeCookies(this.cookie, pair);
      }
      const text = await res.text();
      const type = res.headers.get('content-type') ?? '';
      const data = text && type.includes('json') ? JSON.parse(text) as Record<string, unknown> : {};
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

  async function register(email: string, studentNo: string, name = '考生甲'): Promise<Api> {
    const api = new Api();
    const sent = await api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email, purpose: 'REGISTER', registrationProof: await registrationProof(api, email) }) });
    assert.equal(sent.status, 200, sent.text);
    const code = await codeFor(email);
    const created = await api.fetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name, studentNo, college: '计算机', major: '软件工程', phone: '13800138000',
        email, password: 'Student-pass-1', challengeId: sent.data.challengeId, code, acceptedPolicy: true,
      }),
    });
    assert.equal(created.status, 200, created.text);
    return api;
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

  async function uploadPng(api: Api): Promise<string> {
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
    const attachment = uploaded.data.attachment as { id: string };
    return attachment.id;
  }

  async function createRound(api: Api, name: string): Promise<string> {
    const round = await api.fetch('/api/admin/rounds', { method: 'POST', body: JSON.stringify({ name }) });
    assert.equal(round.status, 200, round.text);
    return (round.data.round as { id: string }).id;
  }

  async function createBatch(api: Api, roundId: string, name: string, status: 'DRAFT' | 'OPEN' | 'CLOSED' = 'OPEN'): Promise<string> {
    const batch = await api.fetch('/api/admin/batches', {
      method: 'POST',
      body: JSON.stringify({
        roundId,
        name,
        description: '说明',
        opensAt: new Date(Date.now() - 3600_000).toISOString(),
        startClosesAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
        durationHours: 24,
        status,
      }),
    });
    assert.equal(batch.status, 200, batch.text);
    return (batch.data.batch as { id: string }).id;
  }

  async function createQuestion(api: Api, batchId: string, title: string, attachmentIds: string[] = []): Promise<string> {
    const question = await api.fetch('/api/admin/questions', {
      method: 'POST',
      body: JSON.stringify({
        batchId, direction: 'PRODUCT', title, content: `题干-${title}`, published: true, attachmentIds,
      }),
    });
    assert.equal(question.status, 200, question.text);
    return (question.data.question as { id: string }).id;
  }

  async function enroll(api: Api, batchId: string): Promise<string> {
    const enrolled = await api.fetch('/api/enrollments', {
      method: 'POST',
      body: JSON.stringify({ batchId, direction: 'PRODUCT' }),
    });
    assert.equal(enrolled.status, 200, enrolled.text);
    return (enrolled.data.enrollment as { id: string }).id;
  }

  async function preview(api: Api, kind: string, id: string) {
    const result = await api.fetch(`/api/admin/deletions/${kind}/${id}`);
    assert.equal(result.status, 200, result.text);
    const body = result.data.preview as {
      kind: string;
      id: string;
      title: string;
      allowed: boolean;
      reason: string | null;
      fingerprint: string;
      counts: { batches: number; questions: number; enrollments: number; materials: number; files: number };
      consequences: string[];
    };
    assert.equal(body.kind, kind);
    assert.equal(body.id, id);
    assert.equal(typeof body.title, 'string');
    assert.match(body.fingerprint, /^[a-f0-9]{64}$/);
    assert.ok(body.consequences.length > 0);
    return body;
  }

  async function remove(api: Api, kind: string, id: string, fingerprint: string, confirmation = '删除') {
    return api.fetch(`/api/admin/deletions/${kind}/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmation, fingerprint }),
    });
  }

  async function count(sql: string, params: unknown[] = []): Promise<number> {
    const result = await ctx.pool.query<{ n: number }>(sql, params);
    return result.rows[0]?.n ?? 0;
  }

  describe('admin deletion', { concurrency: 1, timeout: 120_000 }, () => {
    before(async () => {
      if (!/^assessment_del_[0-9]+$/.test(schema)) throw new Error('refusing unsafe test schema');
      storage = await mkdirTemp();
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
      const migration = await readFile(new URL('../migrations/004_admin_deletion.sql', import.meta.url), 'utf8');
      await ctx.pool.query(migration);
      const queued = await ctx.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_constraint
         WHERE conrelid = 'deleted_material_files'::regclass AND contype = 'f'`,
      );
      assert.equal(queued.rows[0]?.n, 0);
      const applied = await count(`SELECT count(*)::int AS n FROM schema_migrations WHERE id = '004_admin_deletion'`);
      assert.equal(applied, 1);
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
      if (/^assessment_del_[0-9]+$/.test(schema)) {
        const prep = new Pool({ connectionString: databaseUrl });
        await prep.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await prep.end();
      }
      if (storage) await rm(storage, { recursive: true, force: true });
    });

    beforeEach(async () => {
      await ctx.pool.query(`TRUNCATE registration_challenges, registration_buckets, users, sessions, email_challenges, rate_limits, rounds, batches, attachments,
        questions, question_attachments, question_versions, enrollments, mcp_tokens, repository_previews,
        repositories, material_approvals, materials, finalize_receipts, reviews, audit_events, email_outbox,
        oauth_clients, oauth_requests, oauth_codes, oauth_grants, oauth_access_tokens, oauth_refresh_tokens,
        material_uploads, material_upload_files, deleted_material_files
        RESTART IDENTITY CASCADE`);
      await bootstrapAdmin(ctx.pool, {
        adminEmail: 'admin@example.com',
        adminPassword: 'Admin-pass-123',
        adminName: '管理员',
        databaseUrl: databaseUrl ?? '',
      });
    });

    test('rejects non-admin, bad confirmation, and missing targets without deleting', async () => {
      seq += 1;
      const adm = await admin();
      const roundId = await createRound(adm, `空轮次${seq}`);
      const candidate = await register(`cand${seq}@example.com`, `2026${String(seq).padStart(4, '0')}`);
      const forbidden = await candidate.fetch(`/api/admin/deletions/round/${roundId}`);
      assert.equal(forbidden.status, 403);
      assert.equal(forbidden.data.code, 'FORBIDDEN');
      const previewed = await preview(adm, 'round', roundId);
      const candidateUser = await ctx.pool.query<{id: string}>(`SELECT id FROM users WHERE email = $1`, [`cand${seq}@example.com`]);
      await assert.rejects(
        () => executeAdminDeletion(ctx, {id: candidateUser.rows[0]!.id, name: '考生'}, 'round', roundId, '删除', previewed.fingerprint),
        (error: unknown) => error instanceof HttpError && error.code === 'FORBIDDEN',
      );
      const noCsrf = await fetch(base + `/api/admin/deletions/round/${roundId}`, {
        method: 'DELETE',
        headers: { origin, cookie: adm.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ confirmation: '删除', fingerprint: previewed.fingerprint }),
      });
      assert.equal(noCsrf.status, 403);
      const missingConfirmation = await adm.fetch(`/api/admin/deletions/round/${roundId}`, {
        method: 'DELETE',
        body: JSON.stringify({ fingerprint: previewed.fingerprint }),
      });
      assert.equal(missingConfirmation.status, 400);
      const wrongConfirmation = await remove(adm, 'round', roundId, previewed.fingerprint, 'delete');
      assert.equal(wrongConfirmation.status, 400);
      assert.equal(wrongConfirmation.data.code, 'VALIDATION');
      const badKind = await adm.fetch(`/api/admin/deletions/packet/${roundId}`);
      assert.equal(badKind.status, 400);
      const missing = await adm.fetch(`/api/admin/deletions/round/${randomUUID()}`);
      assert.equal(missing.status, 404);
      assert.equal(await count('SELECT count(*)::int AS n FROM rounds WHERE id = $1', [roundId]), 1);
      const audits = await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ADMIN_DELETE'`);
      assert.equal(audits, 0);
    });

    test('deletes an empty round and a childless batch, and refuses rounds or batches that still have children', async () => {
      seq += 1;
      const adm = await admin();
      const emptyRound = await createRound(adm, `可删轮次${seq}`);
      const blockedRound = await createRound(adm, `占用轮次${seq}`);
      const blockedBatch = await createBatch(adm, blockedRound, `占用批次${seq}`, 'CLOSED');
      await createQuestion(adm, blockedBatch, `占用题目${seq}`);
      const roundPreview = await preview(adm, 'round', blockedRound);
      assert.equal(roundPreview.allowed, false);
      assert.match(roundPreview.reason ?? '', /子项/);
      assert.equal(roundPreview.counts.batches, 1);
      assert.equal(roundPreview.counts.questions, 1);
      const roundDelete = await remove(adm, 'round', blockedRound, roundPreview.fingerprint);
      assert.equal(roundDelete.status, 409);
      assert.equal(roundDelete.data.code, 'DELETION_BLOCKED');
      assert.equal(await count('SELECT count(*)::int AS n FROM batches WHERE id = $1', [blockedBatch]), 1);

      const batchPreview = await preview(adm, 'batch', blockedBatch);
      assert.equal(batchPreview.allowed, false);
      assert.match(batchPreview.reason ?? '', /关闭的批次/);
      const batchDelete = await remove(adm, 'batch', blockedBatch, batchPreview.fingerprint);
      assert.equal(batchDelete.status, 409);
      assert.equal(await count('SELECT count(*)::int AS n FROM questions WHERE batch_id = $1', [blockedBatch]), 1);

      const emptyBatchRound = await createRound(adm, `批次轮次${seq}`);
      const emptyBatch = await createBatch(adm, emptyBatchRound, `空批次${seq}`, 'CLOSED');
      const beforeStatus = await preview(adm, 'batch', emptyBatch);
      assert.equal(beforeStatus.allowed, true);
      const changed = await adm.fetch(`/api/admin/batches/${emptyBatch}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'DRAFT' }),
      });
      assert.equal(changed.status, 200, changed.text);
      const stale = await remove(adm, 'batch', emptyBatch, beforeStatus.fingerprint);
      assert.equal(stale.status, 409);
      assert.equal(stale.data.code, 'PREVIEW_CHANGED');
      assert.equal(await count('SELECT count(*)::int AS n FROM batches WHERE id = $1', [emptyBatch]), 1);
      const freshBatch = await preview(adm, 'batch', emptyBatch);
      const deletedBatch = await remove(adm, 'batch', emptyBatch, freshBatch.fingerprint);
      assert.equal(deletedBatch.status, 200, deletedBatch.text);
      assert.deepEqual(deletedBatch.data, { ok: true, kind: 'batch', id: emptyBatch, filesQueued: 0 });
      assert.equal(await count('SELECT count(*)::int AS n FROM rounds WHERE id = $1', [emptyBatchRound]), 1);

      const freshRound = await preview(adm, 'round', emptyRound);
      assert.equal(freshRound.allowed, true);
      assert.equal(freshRound.reason, null);
      assert.equal(freshRound.counts.batches, 0);
      const deletedRound = await remove(adm, 'round', emptyRound, freshRound.fingerprint);
      assert.equal(deletedRound.status, 200, deletedRound.text);
      assert.equal(await count('SELECT count(*)::int AS n FROM rounds WHERE id = $1', [emptyRound]), 0);
      assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ROUND_CREATE'`), 3);
      assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ADMIN_DELETE'`), 2);
    });

    test('deletes an unassigned question but keeps shared attachments and assigned history', async () => {
      seq += 1;
      const adm = await admin();
      const roundId = await createRound(adm, `题目轮次${seq}`);
      const batchId = await createBatch(adm, roundId, `题目批次${seq}`);
      const attachmentId = await uploadPng(adm);
      const freeId = await createQuestion(adm, batchId, `自由题目${seq}`, [attachmentId]);
      const sharedId = await createQuestion(adm, batchId, `共享题目${seq}`, [attachmentId]);
      const assignedId = await createQuestion(adm, batchId, `已分配题目${seq}`, [attachmentId]);
      const candidate = await register(`q${seq}@example.com`, `3026${String(seq).padStart(4, '0')}`);
      const enrollmentId = await enroll(candidate, batchId);
      const version = await ctx.pool.query<{ id: string }>('SELECT id FROM question_versions WHERE question_id = $1', [assignedId]);
      await ctx.pool.query(
        `UPDATE enrollments
         SET duration_hours = 24, started_at = clock_timestamp(), deadline = clock_timestamp() + interval '24 hours', question_version_id = $2
         WHERE id = $1`,
        [enrollmentId, version.rows[0]?.id],
      );
      const assigned = await preview(adm, 'question', assignedId);
      assert.equal(assigned.allowed, false);
      assert.match(assigned.reason ?? '', /取消发布/);
      assert.equal(assigned.counts.enrollments, 1);
      const blocked = await remove(adm, 'question', assignedId, assigned.fingerprint);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.data.code, 'DELETION_BLOCKED');
      assert.equal(await count('SELECT count(*)::int AS n FROM questions WHERE id = $1', [assignedId]), 1);

      const free = await preview(adm, 'question', freeId);
      assert.equal(free.allowed, true);
      assert.equal(free.counts.questions, 1);
      assert.equal(free.counts.files, 0);
      const deleted = await remove(adm, 'question', freeId, free.fingerprint);
      assert.equal(deleted.status, 200, deleted.text);
      assert.equal(await count('SELECT count(*)::int AS n FROM questions WHERE id = $1', [freeId]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM question_versions WHERE question_id = $1', [freeId]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM question_attachments WHERE question_id = $1', [freeId]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM attachments WHERE id = $1', [attachmentId]), 1);
      assert.equal(await count('SELECT count(*)::int AS n FROM question_attachments WHERE question_id = $1', [sharedId]), 1);
      await lstat(path.join(storage, attachmentId));
    });

    test('new enrollment or upload makes an old preview unusable, and a busy upload lock returns 409', async () => {
      seq += 1;
      const adm = await admin();
      const roundId = await createRound(adm, `变化轮次${seq}`);
      const batchId = await createBatch(adm, roundId, `变化批次${seq}`);
      await createQuestion(adm, batchId, `变化题目${seq}`);
      const candidate = await register(`chg${seq}@example.com`, `4026${String(seq).padStart(4, '0')}`, '考生乙');
      const userId = await ctx.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`chg${seq}@example.com`]);
      const candidateId = userId.rows[0]?.id;
      assert.ok(candidateId);
      const beforeEnroll = await preview(adm, 'candidate', candidateId);
      assert.equal(beforeEnroll.allowed, true);
      assert.equal(beforeEnroll.counts.enrollments, 0);
      const enrollmentId = await enroll(candidate, batchId);
      const staleAccount = await remove(adm, 'candidate', candidateId, beforeEnroll.fingerprint);
      assert.equal(staleAccount.status, 409);
      assert.equal(staleAccount.data.code, 'PREVIEW_CHANGED');
      assert.equal(await count('SELECT count(*)::int AS n FROM users WHERE id = $1', [candidateId]), 1);
      assert.equal(await count('SELECT count(*)::int AS n FROM enrollments WHERE id = $1', [enrollmentId]), 1);

      const beforeUpload = await preview(adm, 'enrollment', enrollmentId);
      const uploadId = randomUUID();
      const tokenId = randomUUID();
      await ctx.pool.query(
        `INSERT INTO mcp_tokens (id, enrollment_id, token_hash, expires_at)
         VALUES ($1, $2, $3, clock_timestamp() + interval '1 day')`,
        [tokenId, enrollmentId, `hash-${uploadId}`],
      );
      await ctx.pool.query(
        `INSERT INTO material_uploads (id, enrollment_id, mcp_token_id, token_hash, repo_sha, metadata, expires_at)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, clock_timestamp() + interval '1 hour')`,
        [uploadId, enrollmentId, tokenId, `upload-${uploadId}`, 'a'.repeat(40)],
      );
      const staleUpload = await remove(adm, 'enrollment', enrollmentId, beforeUpload.fingerprint);
      assert.equal(staleUpload.status, 409);
      assert.equal(staleUpload.data.code, 'PREVIEW_CHANGED');
      assert.equal(await count('SELECT count(*)::int AS n FROM material_uploads WHERE id = $1', [uploadId]), 1);

      const current = await preview(adm, 'enrollment', enrollmentId);
      assert.equal(current.counts.files, 0);
      const holder = await ctx.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`material-upload:${uploadId}`]);
        const busy = await remove(adm, 'enrollment', enrollmentId, current.fingerprint);
        assert.equal(busy.status, 409);
        assert.equal(busy.data.code, 'DELETION_BUSY');
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      assert.equal(await count('SELECT count(*)::int AS n FROM enrollments WHERE id = $1', [enrollmentId]), 1);
      assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'ADMIN_DELETE'`), 0);

      const rowLock = await ctx.pool.connect();
      try {
        await rowLock.query('BEGIN');
        await rowLock.query('SELECT id FROM enrollments WHERE id = $1 FOR UPDATE', [enrollmentId]);
        const busyRow = await remove(adm, 'enrollment', enrollmentId, current.fingerprint);
        assert.equal(busyRow.status, 409);
        assert.equal(busyRow.data.code, 'DELETION_BUSY');
      } finally {
        await rowLock.query('ROLLBACK');
        rowLock.release();
      }
      assert.equal(await count('SELECT count(*)::int AS n FROM enrollments WHERE id = $1', [enrollmentId]), 1);
    });

    test('enrollment deletion removes one finalized attempt and leaves the account and other attempt', async () => {
      seq += 1;
      const adm = await admin();
      const keepRound = await createRound(adm, `保留轮次${seq}`);
      const dropRound = await createRound(adm, `删除轮次${seq}`);
      const keepBatch = await createBatch(adm, keepRound, `保留批次${seq}`);
      const dropBatch = await createBatch(adm, dropRound, `删除批次${seq}`);
      const attachmentId = await uploadPng(adm);
      const questionId = await createQuestion(adm, dropBatch, `交卷题目${seq}`, [attachmentId]);
      await createQuestion(adm, keepBatch, `保留题目${seq}`);
      const candidate = await register(`iso${seq}@example.com`, `5026${String(seq).padStart(4, '0')}`, '考生丙');
      const keepId = await enroll(candidate, keepBatch);
      const dropId = await enroll(candidate, dropBatch);
      const user = await ctx.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [`iso${seq}@example.com`]);
      const userId = user.rows[0]?.id;
      assert.ok(userId);
      const fileId = await seedFinalizedGraph(dropId, userId, questionId, `iso${seq}@example.com`);
      await mkdir(path.join(storage, 'materials'), { recursive: true });
      await writeFile(path.join(storage, 'materials', fileId), 'hello');

      const other = await preview(adm, 'enrollment', keepId);
      const target = await preview(adm, 'enrollment', dropId);
      assert.equal(target.allowed, true);
      assert.match(target.consequences.join('\n'), /重新报名/);
      assert.equal(target.counts.enrollments, 1);
      assert.equal(target.counts.materials, 2);
      assert.equal(target.counts.files, 1);
      const deleted = await remove(adm, 'enrollment', dropId, target.fingerprint);
      assert.equal(deleted.status, 200, deleted.text);
      assert.equal((deleted.data as { filesQueued: number }).filesQueued, 1);
      assert.equal(other.fingerprint.length, 64);

      assert.equal(await count('SELECT count(*)::int AS n FROM enrollments WHERE id = $1', [dropId]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM enrollments WHERE id = $1', [keepId]), 1);
      assert.equal(await count('SELECT count(*)::int AS n FROM users WHERE id = $1', [userId]), 1);
      assert.equal(await count('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [userId]), 1);
      for (const table of [
        'mcp_tokens', 'repository_previews', 'repositories', 'material_approvals', 'materials',
        'finalize_receipts', 'reviews', 'material_uploads', 'oauth_codes',
      ]) {
        assert.equal(await count(`SELECT count(*)::int AS n FROM ${table} WHERE enrollment_id = $1`, [dropId]), 0, table);
      }
      assert.equal(await count('SELECT count(*)::int AS n FROM material_upload_files WHERE id = $1', [fileId]), 0);
      assert.equal(await count(`SELECT count(*)::int AS n FROM oauth_grants`), 0);
      assert.equal(await count(`SELECT count(*)::int AS n FROM oauth_access_tokens`), 0);
      assert.equal(await count(`SELECT count(*)::int AS n FROM oauth_refresh_tokens`), 0);
      assert.equal(await count(`SELECT count(*)::int AS n FROM oauth_requests`), 0);
      assert.equal(await count(`SELECT count(*)::int AS n FROM oauth_clients`), 1);
      assert.equal(await count(`SELECT count(*)::int AS n FROM questions WHERE id = $1`, [questionId]), 1);
      assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'KEEP_ME'`), 1);
      assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox WHERE status = 'SENT'`), 1);
      assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox WHERE status = 'PENDING' AND idempotency_key = $1`, [`publish:${dropId}`]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM email_challenges WHERE email = $1', [`iso${seq}@example.com`]), 2);
      const queued = await ctx.pool.query<{ deleted_at: Date | null }>(
        'SELECT deleted_at FROM deleted_material_files WHERE file_id = $1',
        [fileId],
      );
      assert.equal(queued.rows[0]?.deleted_at ?? null, null);
      await lstat(path.join(storage, 'materials', fileId));
      const removedFiles = await purgeDeletedMaterialFiles(ctx);
      assert.equal(removedFiles, 1);
      await assert.rejects(() => lstat(path.join(storage, 'materials', fileId)));
      const done = await ctx.pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM deleted_material_files WHERE file_id = $1', [fileId]);
      assert.ok(done.rows[0]?.deleted_at);

      const me = await candidate.fetch('/api/auth/me');
      assert.equal(me.status, 200);
      const kept = await candidate.fetch(`/api/enrollments/${keepId}`);
      assert.equal(kept.status, 200, kept.text);
      const gone = await candidate.fetch(`/api/enrollments/${dropId}`);
      assert.equal(gone.status, 404);
      const again = await enroll(candidate, dropBatch);
      assert.notEqual(again, dropId);

      const freed = await preview(adm, 'question', questionId);
      assert.equal(freed.allowed, true);
      const questionDeleted = await remove(adm, 'question', questionId, freed.fingerprint);
      assert.equal(questionDeleted.status, 200, questionDeleted.text);
      assert.equal(await count('SELECT count(*)::int AS n FROM attachments WHERE id = $1', [attachmentId]), 1);
    });

    test('candidate deletion invalidates login, frees identifiers, and never removes an admin', async () => {
      seq += 1;
      const adm = await admin();
      const adminRow = await ctx.pool.query<{ id: string; name: string }>('SELECT id, name FROM users WHERE role = $1', ['ADMIN']);
      const adminId = adminRow.rows[0]?.id;
      assert.ok(adminId);
      const adminPreview = await preview(adm, 'candidate', adminId);
      assert.equal(adminPreview.allowed, false);
      assert.match(adminPreview.reason ?? '', /管理员/);
      const httpBlocked = await remove(adm, 'candidate', adminId, adminPreview.fingerprint);
      assert.equal(httpBlocked.status, 409);
      assert.equal(httpBlocked.data.code, 'DELETION_BLOCKED');
      await assert.rejects(
        () => executeAdminDeletion(ctx, { id: adminId, name: adminRow.rows[0]?.name ?? '管理员' }, 'candidate', adminId, '删除', adminPreview.fingerprint),
        (error: unknown) => error instanceof HttpError && error.code === 'DELETION_BLOCKED',
      );
      assert.equal(await count('SELECT count(*)::int AS n FROM users WHERE id = $1 AND role = $2', [adminId, 'ADMIN']), 1);

      const roundId = await createRound(adm, `考生轮次${seq}`);
      const batchId = await createBatch(adm, roundId, `考生批次${seq}`);
      await createQuestion(adm, batchId, `考生题目${seq}`);
      const email = `bye${seq}@example.com`;
      const studentNo = `6026${String(seq).padStart(4, '0')}`;
      const candidate = await register(email, studentNo, '考生丁');
      const enrollmentId = await enroll(candidate, batchId);
      const user = await ctx.pool.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
      const userId = user.rows[0]?.id;
      assert.ok(userId);
      const tokenId = randomUUID();
      const requestId = randomUUID();
      await ctx.pool.query(
        `INSERT INTO mcp_tokens (id, enrollment_id, token_hash, expires_at) VALUES ($1, $2, $3, clock_timestamp() + interval '1 day')`,
        [tokenId, enrollmentId, `tok-${tokenId}`],
      );
      await ctx.pool.query(
        `INSERT INTO oauth_clients (client_id, metadata) VALUES ('cand-client', '{}'::jsonb)`,
      );
      await ctx.pool.query(
        `INSERT INTO oauth_requests (id, client_id, browser_hash, redirect_uri, code_challenge, resource)
         VALUES ($1, 'cand-client', 'browser', 'http://127.0.0.1:5173/cb', 'challenge', 'http://127.0.0.1:3000/mcp')`,
        [requestId],
      );
      await ctx.pool.query(
        `INSERT INTO oauth_codes (code_hash, request_id, enrollment_id, user_id) VALUES ($1, $2, $3, $4)`,
        [`code-${tokenId}`, requestId, enrollmentId, userId],
      );
      await ctx.pool.query(
        `INSERT INTO oauth_grants (id, client_id, mcp_token_id, resource)
         VALUES ($1, 'cand-client', $2, 'http://127.0.0.1:3000/mcp')`,
        [randomUUID(), tokenId],
      );
      await ctx.pool.query(
        `INSERT INTO email_challenges (email, purpose, code_hash, expires_at)
         VALUES ($1, 'RESET', 'reset-hash', clock_timestamp() + interval '10 minutes')`,
        [email],
      );
      await ctx.pool.query(
        `INSERT INTO email_outbox (to_email, subject, body, status, idempotency_key)
         VALUES ($1, '待发', 'pending', 'PENDING', $2), ($1, '已发', 'sent', 'SENT', $3)`,
        [email, `pending:${userId}`, `sent:${userId}`],
      );
      await ctx.pool.query(
        `INSERT INTO audit_events (actor_id, actor_name, action, enrollment_id, details)
         VALUES ($1, '考生丁', 'KEEP_ME', $2, '{}'::jsonb)`,
        [userId, enrollmentId],
      );
      const seen = await preview(adm, 'candidate', userId);
      assert.equal(seen.counts.enrollments, 1);
      const deleted = await remove(adm, 'candidate', userId, seen.fingerprint);
      assert.equal(deleted.status, 200, deleted.text);
      assert.equal(await count('SELECT count(*)::int AS n FROM users WHERE id = $1', [userId]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM sessions WHERE user_id = $1', [userId]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM enrollments WHERE user_id = $1', [userId]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM oauth_codes WHERE user_id = $1', [userId]), 0);
      assert.equal(await count('SELECT count(*)::int AS n FROM email_challenges WHERE email = $1', [email]), 0);
      assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox WHERE to_email = $1 AND status = 'PENDING'`, [email]), 0);
      assert.equal(await count(`SELECT count(*)::int AS n FROM email_outbox WHERE to_email = $1 AND status = 'SENT'`, [email]), 1);
      assert.equal(await count(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'KEEP_ME' AND actor_id = $1`, [userId]), 1);
      const me = await candidate.fetch('/api/auth/me');
      assert.equal(me.status, 401);
      // Account deletion frees identifiers, but must not erase the registration cooldown.
      await ctx.pool.query("UPDATE registration_buckets SET updated_at = clock_timestamp() - interval '61 seconds' WHERE bucket = 'register-mail-email-cooldown'");
      const again = await register(email, studentNo, '考生丁');
      const relogin = await again.fetch('/api/auth/me');
      assert.equal(relogin.status, 200);
    });

    test('file purge retries a failed removal and does not follow or recurse raw paths', async () => {
      const materials = path.join(storage, 'materials');
      await mkdir(materials, { recursive: true });
      const blockedId = randomUUID();
      await mkdir(path.join(materials, blockedId), { recursive: true });
      await writeFile(path.join(materials, blockedId, 'child.txt'), 'stay');
      const outside = path.join(storage, 'outside.txt');
      await writeFile(outside, 'keep');
      const linkId = randomUUID();
      await symlink(outside, path.join(materials, linkId));
      await ctx.pool.query(
        `INSERT INTO deleted_material_files (file_id) VALUES ($1), ($2)`,
        [blockedId, linkId],
      );
      const first = await purgeDeletedMaterialFiles(ctx);
      assert.equal(first, 1);
      const failed = await ctx.pool.query<{ attempts: number; deleted_at: Date | null; last_error: string | null }>(
        'SELECT attempts, deleted_at, last_error FROM deleted_material_files WHERE file_id = $1',
        [blockedId],
      );
      assert.equal(failed.rows[0]?.attempts, 1);
      assert.equal(failed.rows[0]?.deleted_at ?? null, null);
      assert.equal(failed.rows[0]?.last_error, 'EISDIR');
      assert.equal(await readFile(path.join(materials, blockedId, 'child.txt'), 'utf8'), 'stay');
      assert.equal(await readFile(outside, 'utf8'), 'keep');
      await assert.rejects(() => lstat(path.join(materials, linkId)));

      await rm(path.join(materials, blockedId), { recursive: true, force: true });
      await writeFile(path.join(materials, blockedId), 'now-a-file');
      assert.equal(await purgeDeletedMaterialFiles(ctx), 0, 'honors retry delay');
      await ctx.pool.query(`UPDATE deleted_material_files SET attempts = 20, next_attempt_at = clock_timestamp() - interval '1 second' WHERE file_id = $1`, [blockedId]);
      const second = await purgeDeletedMaterialFiles(ctx);
      assert.equal(second, 1);
      await assert.rejects(() => lstat(path.join(materials, blockedId)));
      const retried = await ctx.pool.query<{ deleted_at: Date | null }>('SELECT deleted_at FROM deleted_material_files WHERE file_id = $1', [blockedId]);
      assert.ok(retried.rows[0]?.deleted_at);
      assert.equal(await readFile(outside, 'utf8'), 'keep');
    });
  });

  async function seedFinalizedGraph(enrollmentId: string, userId: string, questionId: string, email: string): Promise<string> {
    const version = await ctx.pool.query<{ id: string }>('SELECT id FROM question_versions WHERE question_id = $1 ORDER BY version_no DESC LIMIT 1', [questionId]);
    const versionId = version.rows[0]?.id;
    assert.ok(versionId);
    const previewId = randomUUID();
    const repositoryId = randomUUID();
    const tokenId = randomUUID();
    const approvalId = randomUUID();
    const legacyId = randomUUID();
    const directId = randomUUID();
    const uploadId = randomUUID();
    const fileId = randomUUID();
    const requestId = randomUUID();
    const grantId = randomUUID();
    const sha = 'b'.repeat(40);
    await ctx.pool.query(
      `UPDATE enrollments SET consent_version = 'assessment-consent-v1', consent_accepted_at = clock_timestamp(),
       mcp_connected = true, duration_hours = 24, started_at = clock_timestamp() - interval '1 hour',
       deadline = clock_timestamp() + interval '23 hours', finalized_at = clock_timestamp(),
       direct_upload_consent_at = clock_timestamp(), question_version_id = $2, updated_at = clock_timestamp()
       WHERE id = $1`,
      [enrollmentId, versionId],
    );
    await ctx.pool.query(
      `INSERT INTO mcp_tokens (id, enrollment_id, token_hash, expires_at)
       VALUES ($1, $2, $3, clock_timestamp() + interval '1 day')`,
      [tokenId, enrollmentId, `tok-${tokenId}`],
    );
    await ctx.pool.query(
      `INSERT INTO repository_previews (id, enrollment_id, user_id, url, branch, sha, message, author, committed_at, expires_at)
       VALUES ($1, $2, $3, 'https://github.com/octocat/Hello-World', 'main', $4, 'demo', 'octocat', clock_timestamp(), clock_timestamp() + interval '10 minutes')`,
      [previewId, enrollmentId, userId, sha],
    );
    await ctx.pool.query(
      `INSERT INTO repositories (id, enrollment_id, preview_id, url, branch, sha, message, author, committed_at)
       VALUES ($1, $2, $3, 'https://github.com/octocat/Hello-World', 'main', $4, 'demo', 'octocat', clock_timestamp())`,
      [repositoryId, enrollmentId, previewId, sha],
    );
    await ctx.pool.query('UPDATE enrollments SET repository_id = $2 WHERE id = $1', [enrollmentId, repositoryId]);
    await ctx.pool.query(
      `INSERT INTO material_approvals (id, enrollment_id, manifest, payload_hash, repo_sha, state, expires_at, approved_at)
       VALUES ($1, $2, '{"files":[],"clients":[],"projectSummary":"legacy","collaborationSummary":"legacy"}'::jsonb, $3, $4, 'USED', clock_timestamp() + interval '1 hour', clock_timestamp())`,
      [approvalId, enrollmentId, 'c'.repeat(64), sha],
    );
    await ctx.pool.query(
      `INSERT INTO materials (id, enrollment_id, approval_id, sha256, repo_sha, payload, client_count, file_count, coverage)
       VALUES ($1, $2, $3, $4, $5, '{"schemaVersion":1}'::jsonb, 1, 1, 'partial')`,
      [legacyId, enrollmentId, approvalId, 'd'.repeat(64), sha],
    );
    await ctx.pool.query(
      `INSERT INTO materials (id, enrollment_id, sha256, repo_sha, payload, client_count, file_count, coverage)
       VALUES ($1, $2, $3, $4, '{"schemaVersion":2}'::jsonb, 1, 1, 'export')`,
      [directId, enrollmentId, 'e'.repeat(64), sha],
    );
    await ctx.pool.query(
      `INSERT INTO finalize_receipts (enrollment_id, repository_id, materials_id, sha, materials_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [enrollmentId, repositoryId, legacyId, sha, 'd'.repeat(64)],
    );
    await ctx.pool.query(
      `INSERT INTO reviews (enrollment_id, score, feedback, published_at) VALUES ($1, 88, '通过', clock_timestamp())`,
      [enrollmentId],
    );
    await ctx.pool.query(
      `INSERT INTO material_uploads (id, enrollment_id, mcp_token_id, token_hash, repo_sha, metadata, manifest, status, total_bytes, material_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, '{"files":[]}'::jsonb, 'RECEIVED', 5, $6, clock_timestamp() + interval '1 hour')`,
      [uploadId, enrollmentId, tokenId, `up-${uploadId}`, sha, directId],
    );
    await ctx.pool.query(
      `INSERT INTO material_upload_files (id, upload_id, name, sha256, size_bytes, received_bytes)
       VALUES ($1, $2, 'notes.txt', $3, 5, 5)`,
      [fileId, uploadId, 'f'.repeat(64)],
    );
    await ctx.pool.query(`INSERT INTO oauth_clients (client_id, metadata) VALUES ('exam-client', '{}'::jsonb)`);
    await ctx.pool.query(
      `INSERT INTO oauth_requests (id, client_id, browser_hash, redirect_uri, code_challenge, resource)
       VALUES ($1, 'exam-client', 'browser', 'http://127.0.0.1:5173/cb', 'challenge', 'http://127.0.0.1:3000/mcp')`,
      [requestId],
    );
    await ctx.pool.query(
      `INSERT INTO oauth_codes (code_hash, request_id, enrollment_id, user_id) VALUES ($1, $2, $3, $4)`,
      [`code-${enrollmentId}`, requestId, enrollmentId, userId],
    );
    await ctx.pool.query(
      `INSERT INTO oauth_grants (id, client_id, mcp_token_id, resource)
       VALUES ($1, 'exam-client', $2, 'http://127.0.0.1:3000/mcp')`,
      [grantId, tokenId],
    );
    await ctx.pool.query(`INSERT INTO oauth_access_tokens (token_hash, grant_id) VALUES ($1, $2)`, [`access-${grantId}`, grantId]);
    await ctx.pool.query(`INSERT INTO oauth_refresh_tokens (token_hash, grant_id) VALUES ($1, $2)`, [`refresh-${grantId}`, grantId]);
    await ctx.pool.query(
      `INSERT INTO email_outbox (to_email, subject, body, status, idempotency_key)
       VALUES ($1, '结果', 'pending-body', 'PENDING', $2), ($1, '历史', 'sent-body', 'SENT', $3)`,
      [email, `publish:${enrollmentId}`, `sent:${enrollmentId}`],
    );
    await ctx.pool.query(
      `INSERT INTO email_challenges (email, purpose, code_hash, expires_at)
       VALUES ($1, 'RESET', 'challenge-hash', clock_timestamp() + interval '10 minutes')`,
      [email],
    );
    await ctx.pool.query(
      `INSERT INTO audit_events (actor_id, actor_name, action, enrollment_id, details)
       VALUES ($1, '考生丙', 'KEEP_ME', $2, '{}'::jsonb)`,
      [userId, enrollmentId],
    );
    return fileId;
  }

  async function mkdirTemp(): Promise<string> {
    return mkdtemp(path.join(tmpdir(), 'lab-delete-'));
  }
}
