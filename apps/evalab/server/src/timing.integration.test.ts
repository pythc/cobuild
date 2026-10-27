import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, before, beforeEach, describe, test } from 'node:test';
import express from 'express';
import { Pool } from 'pg';
import {
  acceptConsent,
  authenticateMcp,
  confirmRepository,
  createEnrollment,
  finalizeExam,
  getEnrollmentForActor,
  issueMcpToken,
  listBatches,
  previewRepository,
  probeMcp,
  startExam,
  updateEnrollment,
} from './assessment.js';
import {
  batchSchema,
  createBatch,
  createQuestion,
  createRound,
  extendDeadline,
  listCandidates,
  updateBatch,
} from './admin.js';
import type { PublicUser } from './auth.js';
import { bootstrapAdmin } from './bootstrap.js';
import { closeContext, createContext, type AppContext } from './context.js';
import { seedDemo } from './demoSeed.js';
import { HttpError } from './errors.js';
import { errorHandler } from './http.js';
import { CONSENT_TEXT, CONSENT_VERSION, DIRECT_UPLOAD_VERSION } from './policy.js';
import { sha256Hex } from './security.js';
import { createMaterialUpload, registerMaterialUploads } from './uploads.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  test('timing integration', { skip: 'set TEST_DATABASE_URL to a disposable database' }, () => {});
} else {
  const schema = `timing_${process.pid}`;
  let ctx: AppContext;
  let server: Server;
  let base = '';
  let storage = '';
  let seq = 0;

  async function adminActor(): Promise<PublicUser> {
    const row = await ctx.pool.query<{ id: string; name: string; email: string }>(
      `SELECT id, name, email FROM users WHERE role = 'ADMIN' ORDER BY created_at LIMIT 1`,
    );
    const user = row.rows[0];
    assert.ok(user);
    return { id: user.id, role: 'ADMIN', name: user.name, email: user.email };
  }

  async function candidate(email: string, studentNo: string): Promise<PublicUser> {
    const row = await ctx.pool.query<{ id: string }>(
      `INSERT INTO users (role, name, student_no, college, major, phone, email, password_hash, accepted_policy_at)
       VALUES ('CANDIDATE', '考生甲', $1, '计算机', '软件工程', '13800138000', $2, 'not-used', now())
       RETURNING id`,
      [studentNo, email],
    );
    const id = row.rows[0]?.id;
    assert.ok(id);
    return { id, role: 'CANDIDATE', name: '考生甲', email, studentNo };
  }

  async function openBatch(hours: 24 | 48, options?: {
    status?: 'DRAFT' | 'OPEN' | 'CLOSED';
    openMs?: number;
    closeMs?: number;
    roundId?: string;
    name?: string;
  }) {
    const actor = await adminActor();
    let roundId = options?.roundId;
    if (!roundId) {
      seq += 1;
      roundId = (await createRound(ctx, actor, `计时轮次${seq}`)).round.id;
    }
    const created = await createBatch(ctx, actor, {
      roundId,
      name: options?.name ?? '计时批次',
      description: '时长',
      opensAt: new Date(Date.now() + (options?.openMs ?? -3_600_000)).toISOString(),
      startClosesAt: new Date(Date.now() + (options?.closeMs ?? 3 * 86_400_000)).toISOString(),
      durationHours: hours,
      status: options?.status ?? 'OPEN',
    });
    return { actor, roundId, batch: created.batch };
  }

  async function publishQuestion(actor: PublicUser, batchId: string, title: string) {
    const created = await createQuestion(ctx, actor, {
      batchId,
      direction: 'PRODUCT',
      title,
      content: `题干-${title}`,
      published: true,
      attachmentIds: [],
    });
    assert.ok(created.question);
    return created.question.id;
  }

  async function prepare(batchId: string, email: string, studentNo: string) {
    const user = await candidate(email, studentNo);
    const enrollment = await createEnrollment(ctx, user.id, batchId, 'PRODUCT');
    const consented = await acceptConsent(ctx, user.id, enrollment.id);
    const issued = await issueMcpToken(ctx, user.id, enrollment.id);
    await probeMcp(ctx, await authenticateMcp(ctx, issued.token));
    return { user, id: enrollment.id, token: issued.token, enrollment: consented };
  }

  async function expectHttp(run: () => Promise<unknown>, status: number, code: string) {
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      return true;
    });
  }

  async function timingRow(id: string) {
    const row = await ctx.pool.query<{
      started_at: Date | null; deadline: Date | null; duration_hours: number | null;
      question_version_id: string | null; finalized_at: Date | null; seconds: string | null;
    }>(
      `SELECT started_at, deadline, duration_hours, question_version_id, finalized_at,
              extract(epoch FROM (deadline - started_at))::text AS seconds
       FROM enrollments WHERE id = $1`,
      [id],
    );
    const item = row.rows[0];
    assert.ok(item);
    return item;
  }

  async function uploadFetch(urlPath: string, token: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${token}`);
    if (typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const res = await fetch(base + urlPath, { ...init, headers });
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    const data = text && type.includes('json') ? JSON.parse(text) as Record<string, any> : {};
    return { status: res.status, data, text };
  }

  describe('timing integration', { concurrency: 1, timeout: 120_000 }, () => {
    before(async () => {
      if (!/^timing_[0-9]+$/.test(schema)) throw new Error('refusing unsafe test schema');
      storage = await mkdtemp(path.join(tmpdir(), 'lab-timing-'));
      process.env.DATABASE_URL = databaseUrl;
      process.env.DB_SCHEMA = schema;
      process.env.NODE_ENV = 'test';
      process.env.APP_ORIGIN = 'http://127.0.0.1:5173';
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
      const sql = await readFile(new URL('../migrations/005_exam_duration.sql', import.meta.url), 'utf8');
      await ctx.pool.query(sql);
      await ctx.pool.query(`INSERT INTO schema_migrations (id) VALUES ('005_exam_duration') ON CONFLICT DO NOTHING`);
      const app = express();
      registerMaterialUploads(app, ctx);
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
      if (ctx) await closeContext(ctx);
      if (databaseUrl && /^timing_[0-9]+$/.test(schema)) {
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

    test('persists only 24 or 48 hours and allows preparation before the batch opens', async () => {
      const rejected = batchSchema.safeParse({
        roundId: '00000000-0000-4000-8000-000000000001',
        name: '坏时长',
        description: '',
        opensAt: new Date().toISOString(),
        startClosesAt: new Date(Date.now() + 3600_000).toISOString(),
        durationHours: 36,
        status: 'OPEN',
      });
      assert.equal(rejected.success, false);
      const created = await openBatch(48, { openMs: 86_400_000, closeMs: 3 * 86_400_000 });
      assert.equal(created.batch.durationHours, 48);
      const to24 = await updateBatch(ctx, created.actor, created.batch.id, { durationHours: 24 });
      assert.equal(to24.batch.durationHours, 24);
      const to48 = await updateBatch(ctx, created.actor, created.batch.id, { durationHours: 48 });
      assert.equal(to48.batch.durationHours, 48);
      await publishQuestion(created.actor, created.batch.id, '未开考题目');
      const ready = await prepare(created.batch.id, 'future@example.com', '20261001');
      assert.equal(ready.enrollment.startedAt, null);
      assert.equal(ready.enrollment.durationHours, 48);
      const listed = await listBatches(ctx, ready.user.id);
      const rounds = listed.rounds as Array<{ batches: Array<{ id: string; durationHours: number; enrollment?: { durationHours: number } }> }>;
      const visible = rounds.flatMap((round) => round.batches).find((batch) => batch.id === created.batch.id);
      assert.equal(visible?.durationHours, 48);
      assert.equal(visible?.enrollment?.durationHours, 48);
      await expectHttp(() => startExam(ctx, ready.user.id, ready.id, 48), 409, 'WINDOW_CLOSED');
      const untouched = await timingRow(ready.id);
      assert.equal(untouched.started_at, null);
      assert.equal(untouched.duration_hours, null);
      const moved = await updateEnrollment(ctx, ready.user.id, ready.id, { direction: 'DEVELOPMENT_TEST' });
      assert.equal(moved.direction, 'DEVELOPMENT_TEST');
      const draft = await openBatch(24, { status: 'DRAFT', roundId: created.roundId, name: '草稿批次' });
      await expectHttp(() => createEnrollment(ctx, ready.user.id, draft.batch.id, 'PRODUCT'), 409, 'WINDOW_CLOSED');
      const closed = await openBatch(48, { status: 'CLOSED', roundId: created.roundId, name: '关闭批次' });
      const stranger = await candidate('closed@example.com', '20261002');
      await expectHttp(() => createEnrollment(ctx, stranger.id, closed.batch.id, 'PRODUCT'), 409, 'WINDOW_CLOSED');
      await ctx.pool.query(
        `UPDATE batches
         SET opens_at = clock_timestamp() - interval '1 hour', start_closes_at = clock_timestamp()
         WHERE id = $1`,
        [created.batch.id],
      );
      const late = await candidate('late@example.com', '20261003');
      await expectHttp(() => createEnrollment(ctx, late.id, created.batch.id, 'PRODUCT'), 409, 'WINDOW_CLOSED');
    });

    test('operator restriction gates real starts without interrupting an active attempt', async () => {
      const created = await openBatch(48);
      await publishQuestion(created.actor, created.batch.id, '核查题');
      const ready = await prepare(created.batch.id, 'risk-start@example.com', '20261099');
      await ctx.pool.query(`INSERT INTO user_registration_risk
        (user_id,ip_hash,browser_hash,risk_reasons,review_state,start_restricted,restriction_reason)
        VALUES ($1,$2,$2,'[]','CLEARED',true,'核查中')`, [ready.user.id, 'a'.repeat(64)]);
      const restrictedList = await listCandidates(ctx, {risk:'RESTRICTED',offset:0});
      assert.deepEqual(restrictedList.candidates.map(item=>item.id),[ready.user.id]);
      assert.equal((await listCandidates(ctx, {risk:'PENDING',offset:0})).candidates.length,0);
      await expectHttp(() => startExam(ctx, ready.user.id, ready.id, 48), 403, 'START_RESTRICTED');
      assert.equal((await timingRow(ready.id)).started_at, null);
      await ctx.pool.query('UPDATE user_registration_risk SET start_restricted=false WHERE user_id=$1', [ready.user.id]);
      const started = await startExam(ctx, ready.user.id, ready.id, 48);
      await ctx.pool.query('UPDATE user_registration_risk SET start_restricted=true WHERE user_id=$1', [ready.user.id]);
      const again = await startExam(ctx, ready.user.id, ready.id, 48);
      assert.equal(again.enrollment.deadline, started.enrollment.deadline);
      const identity = await authenticateMcp(ctx, ready.token);
      assert.equal(identity.enrollmentId, ready.id);
      const repo = await previewRepository(ctx, ready.user.id, ready.id, 'https://github.com/octocat/Hello-World');
      assert.ok(repo);
    });

    test('start user lock remains compatible with enrollment foreign-key checks', async () => {
      const created = await openBatch(48);
      await publishQuestion(created.actor, created.batch.id, '并发报名');
      const ready = await prepare(created.batch.id, 'fk-start@example.com', '20261101');
      const holder = await ctx.pool.connect();
      let running: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM batches WHERE id=$1 FOR SHARE',[created.batch.id]);
        running = startExam(ctx,ready.user.id,ready.id,48);
        // Wait until the real start reaches its batch lock, with its user lock already acquired.
        let blocked = false;
        for(let i=0;i<50;i++) {
          await holder.query('SELECT pg_stat_clear_snapshot()');
          const found=await holder.query(`SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid()
            AND application_name='110lab-assessment' AND wait_event_type='Lock'
            AND query LIKE '%assessment_start_window_open%'`);
          if(found.rowCount){blocked=true;break;}
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        assert.ok(blocked,'start waits on the held batch');
        await holder.query("SET LOCAL lock_timeout='1s'");
        await holder.query('SELECT id FROM users WHERE id=$1 FOR KEY SHARE',[ready.user.id]);
        await holder.query('COMMIT');
        await running;
      } finally {
        await holder.query('ROLLBACK');holder.release();
        await running?.catch(()=>undefined);
      }
      assert.equal((await timingRow(ready.id)).duration_hours,48);
    });

    test('rejects a stale duration, then keeps the captured snapshot when the batch changes', async () => {
      const created = await openBatch(48);
      await publishQuestion(created.actor, created.batch.id, '快照题');
      const ready = await prepare(created.batch.id, 'snap@example.com', '20261011');
      const versionsBefore = await ctx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM question_versions qv JOIN questions q ON q.id = qv.question_id WHERE q.batch_id = $1',
        [created.batch.id],
      );
      await expectHttp(() => startExam(ctx, ready.user.id, ready.id, 24), 409, 'DURATION_CHANGED');
      const failed = await timingRow(ready.id);
      assert.equal(failed.started_at, null);
      assert.equal(failed.duration_hours, null);
      assert.equal(failed.question_version_id, null);
      const versionsAfterReject = await ctx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM question_versions qv JOIN questions q ON q.id = qv.question_id WHERE q.batch_id = $1',
        [created.batch.id],
      );
      assert.equal(versionsAfterReject.rows[0]?.n, versionsBefore.rows[0]?.n);
      const started = await startExam(ctx, ready.user.id, ready.id, 48);
      assert.equal(started.enrollment.durationHours, 48);
      assert.equal(started.enrollment.question?.title, '快照题');
      const stored = await timingRow(ready.id);
      assert.equal(Number(stored.seconds), 48 * 60 * 60);
      assert.equal(stored.duration_hours, 48);
      const repeat = await startExam(ctx, ready.user.id, ready.id, 24);
      assert.equal(repeat.enrollment.startedAt, started.enrollment.startedAt);
      assert.equal(repeat.enrollment.deadline, started.enrollment.deadline);
      assert.equal(repeat.enrollment.question?.title, '快照题');
      const edited = await updateBatch(ctx, created.actor, created.batch.id, { durationHours: 24 });
      assert.equal(edited.batch.durationHours, 24);
      const after = await timingRow(ready.id);
      assert.equal(after.duration_hours, 48);
      assert.equal(after.question_version_id, stored.question_version_id);
      assert.equal(new Date(after.deadline ?? 0).toISOString(), new Date(stored.deadline ?? 0).toISOString());
      assert.equal(new Date(after.started_at ?? 0).toISOString(), new Date(stored.started_at ?? 0).toISOString());
      const viewed = await getEnrollmentForActor(ctx, ready.user, ready.id);
      assert.equal(viewed.enrollment.durationHours, 48);
      const waiting = await prepare(created.batch.id, 'wait@example.com', '20261012');
      assert.equal(waiting.enrollment.durationHours, 24);
      await expectHttp(() => startExam(ctx, waiting.user.id, waiting.id, 48), 409, 'DURATION_CHANGED');
      assert.equal((await timingRow(waiting.id)).started_at, null);
      const fresh = await startExam(ctx, waiting.user.id, waiting.id, 24);
      assert.equal(fresh.enrollment.durationHours, 24);
      assert.equal(Number((await timingRow(waiting.id)).seconds), 24 * 60 * 60);
      assert.equal((await timingRow(ready.id)).duration_hours, 48);
    });

    test('a 48 hour attempt continues after the batch window and CLOSED status', async () => {
      const created = await openBatch(48, { closeMs: 3_600_000 });
      await publishQuestion(created.actor, created.batch.id, '收口后仍可交卷');
      const ready = await prepare(created.batch.id, 'active@example.com', '20261021');
      const started = await startExam(ctx, ready.user.id, ready.id, 48);
      assert.equal(Number((await timingRow(ready.id)).seconds), 48 * 60 * 60);
      const parked = await prepare(created.batch.id, 'parked@example.com', '20261022');
      await ctx.pool.query(
        `UPDATE batches SET status = 'CLOSED', start_closes_at = clock_timestamp() - interval '1 second' WHERE id = $1`,
        [created.batch.id],
      );
      const aligned = await ctx.pool.query<{ aligned: boolean; personal: boolean; batch_closed: boolean }>(
        `SELECT t.expires_at = e.deadline AS aligned,
                e.deadline > clock_timestamp() AS personal,
                b.status = 'CLOSED' AND b.start_closes_at <= clock_timestamp() AS batch_closed
         FROM enrollments e
         JOIN batches b ON b.id = e.batch_id
         JOIN mcp_tokens t ON t.enrollment_id = e.id AND t.revoked_at IS NULL
         WHERE e.id = $1`,
        [ready.id],
      );
      assert.equal(aligned.rows[0]?.aligned, true);
      assert.equal(aligned.rows[0]?.personal, true);
      assert.equal(aligned.rows[0]?.batch_closed, true);
      await authenticateMcp(ctx, ready.token);
      const status = await getEnrollmentForActor(ctx, ready.user, ready.id);
      assert.equal(status.enrollment.state, 'ACTIVE');
      assert.equal(status.enrollment.durationHours, 48);
      assert.equal(status.enrollment.finalizedAt, null);
      const rotated = await issueMcpToken(ctx, ready.user.id, ready.id);
      const identity = await authenticateMcp(ctx, rotated.token);
      await expectHttp(() => startExam(ctx, parked.user.id, parked.id, 48), 409, 'WINDOW_CLOSED');
      const late = await candidate('too-late@example.com', '20261023');
      await expectHttp(() => createEnrollment(ctx, late.id, created.batch.id, 'PRODUCT'), 409, 'WINDOW_CLOSED');
      const preview = await previewRepository(ctx, ready.user.id, ready.id, 'https://github.com/octocat/Hello-World');
      const confirmed = await confirmRepository(ctx, ready.user.id, ready.id, preview.preview.id);
      assert.ok(confirmed.repository);
      await acceptConsent(ctx, ready.user.id, ready.id, true);
      const metadata = {
        repoSha: 'a'.repeat(40),
        clients: [{ name: 'test', models: [{ name: 'unknown', source: 'unknown' as const }] }],
        projectSummary: '测试成果',
        collaborationSummary: '测试协作',
      };
      const ticket = await createMaterialUpload(ctx, identity, metadata);
      const uploadPath = new URL(ticket.uploadUrl).pathname;
      const content = Buffer.from('closed-batch-material');
      const manifest = {
        files: [{ name: 'history.jsonl', bytes: content.length, sha256: sha256Hex(content), source: 'agent-export', coverage: 'export' }],
      };
      const listed = await uploadFetch(`${uploadPath}/manifest`, ticket.uploadToken, { method: 'POST', body: JSON.stringify(manifest) });
      assert.equal(listed.status, 200, listed.text);
      const file = listed.data.files[0];
      const put = await uploadFetch(`${uploadPath}/files/${file.id}?offset=0`, ticket.uploadToken, {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream' },
        body: content,
      });
      assert.equal(put.status, 200, put.text);
      const done = await uploadFetch(`${uploadPath}/complete`, ticket.uploadToken, { method: 'POST', body: '{}' });
      assert.equal(done.status, 200, done.text);
      const finalized = await finalizeExam(ctx, ready.user.id, ready.id, confirmed.repository.id, done.data.receipt.id);
      assert.equal(finalized.enrollment.state, 'FINALIZED');
      assert.equal(finalized.enrollment.durationHours, 48);
      assert.equal(started.enrollment.question?.title, '收口后仍可交卷');
    });

    test('extension leaves revoked tokens and expired upload tickets dead, without finalizing', async () => {
      const created = await openBatch(24);
      await publishQuestion(created.actor, created.batch.id, '延期题');
      const ready = await prepare(created.batch.id, 'extend@example.com', '20261031');
      await startExam(ctx, ready.user.id, ready.id, 24);
      const preview = await previewRepository(ctx, ready.user.id, ready.id, 'https://github.com/octocat/Hello-World');
      const confirmed = await confirmRepository(ctx, ready.user.id, ready.id, preview.preview.id);
      assert.ok(confirmed.repository);
      await acceptConsent(ctx, ready.user.id, ready.id, true);
      await ctx.pool.query(
        `UPDATE mcp_tokens SET revoked_at = clock_timestamp(), expires_at = '2000-01-01T00:00:00Z' WHERE enrollment_id = $1`,
        [ready.id],
      );
      const rotated = await issueMcpToken(ctx, ready.user.id, ready.id);
      const identity = await authenticateMcp(ctx, rotated.token);
      const metadata = {
        repoSha: 'a'.repeat(40),
        clients: [{ name: 'test', models: [{ name: 'unknown', source: 'unknown' as const }] }],
        projectSummary: '测试成果',
        collaborationSummary: '测试协作',
      };
      const ticket = await createMaterialUpload(ctx, identity, metadata);
      await ctx.pool.query(
        `UPDATE material_uploads SET status = 'UPLOADING', expires_at = clock_timestamp() - interval '1 minute' WHERE id = $1`,
        [ticket.uploadId],
      );
      const expiredBefore = await ctx.pool.query<{ expires_at: Date }>(
        'SELECT expires_at FROM material_uploads WHERE id = $1',
        [ticket.uploadId],
      );
      await ctx.pool.query(`UPDATE enrollments SET deadline = clock_timestamp() - interval '1 second' WHERE id = $1`, [ready.id]);
      const expiredView = await getEnrollmentForActor(ctx, ready.user, ready.id);
      assert.equal(expiredView.enrollment.state, 'EXPIRED');
      assert.equal(expiredView.enrollment.finalizedAt, null);
      await expectHttp(() => authenticateMcp(ctx, rotated.token), 401, 'DEADLINE');
      const extended = await extendDeadline(ctx, created.actor, ready.id, 30, '监考记录的短暂断网');
      assert.equal(extended.enrollment.state, 'ACTIVE');
      assert.equal(extended.enrollment.finalizedAt, null);
      const tokens = await ctx.pool.query<{ revoked: boolean; expires_at: Date; deadline: Date }>(
        `SELECT t.revoked_at IS NOT NULL AS revoked, t.expires_at, e.deadline
         FROM mcp_tokens t JOIN enrollments e ON e.id = t.enrollment_id
         WHERE t.enrollment_id = $1 ORDER BY t.created_at`,
        [ready.id],
      );
      assert.equal(tokens.rows[0]?.revoked, true);
      assert.equal(tokens.rows[0]?.expires_at.toISOString(), '2000-01-01T00:00:00.000Z');
      assert.equal(tokens.rows[1]?.revoked, false);
      assert.equal(tokens.rows[1]?.expires_at.toISOString(), tokens.rows[1]?.deadline.toISOString());
      const expiredAfter = await ctx.pool.query<{ expires_at: Date; finalized_at: Date | null }>(
        `SELECT u.expires_at, e.finalized_at
         FROM material_uploads u JOIN enrollments e ON e.id = u.enrollment_id WHERE u.id = $1`,
        [ticket.uploadId],
      );
      assert.equal(expiredAfter.rows[0]?.expires_at.toISOString(), expiredBefore.rows[0]?.expires_at.toISOString());
      assert.equal(expiredAfter.rows[0]?.finalized_at, null);
    });

    test('start is inclusive at opensAt, exclusive at startClosesAt, and loses a close race', async () => {
      const edges = await ctx.pool.query<{ open_edge: boolean; close_edge: boolean; before_open: boolean }>(
        `SELECT assessment_start_window_open(t, t + interval '1 hour', t) AS open_edge,
                assessment_start_window_open(t, t, t) AS close_edge,
                assessment_start_window_open(t, t + interval '1 hour', t - interval '1 microsecond') AS before_open
         FROM (SELECT clock_timestamp() AS t) stamp`,
      );
      assert.equal(edges.rows[0]?.open_edge, true);
      assert.equal(edges.rows[0]?.close_edge, false);
      assert.equal(edges.rows[0]?.before_open, false);
      const created = await openBatch(24, { openMs: 3_600_000, closeMs: 7_200_000 });
      await publishQuestion(created.actor, created.batch.id, '边界题');
      const ready = await prepare(created.batch.id, 'edge@example.com', '20261041');
      await expectHttp(() => startExam(ctx, ready.user.id, ready.id, 24), 409, 'WINDOW_CLOSED');
      await ctx.pool.query(
        `UPDATE batches
         SET opens_at = clock_timestamp(), start_closes_at = clock_timestamp() + interval '1 hour'
         WHERE id = $1`,
        [created.batch.id],
      );
      const started = await startExam(ctx, ready.user.id, ready.id, 24);
      const inside = await ctx.pool.query<{ inside: boolean }>(
        `SELECT assessment_start_window_open(b.opens_at, b.start_closes_at, e.started_at) AS inside
         FROM enrollments e JOIN batches b ON b.id = e.batch_id WHERE e.id = $1`,
        [ready.id],
      );
      assert.equal(inside.rows[0]?.inside, true);
      assert.ok(started.enrollment.startedAt);
      const closing = await openBatch(48, { name: '将关闭' });
      await publishQuestion(closing.actor, closing.batch.id, '竞态题');
      const pending = await prepare(closing.batch.id, 'race@example.com', '20261042');
      const holder = await ctx.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM batches WHERE id = $1 FOR UPDATE', [closing.batch.id]);
        const attempt = startExam(ctx, pending.user.id, pending.id, 48);
        await holder.query(
          `UPDATE batches
           SET opens_at = clock_timestamp() - interval '1 hour', start_closes_at = clock_timestamp()
           WHERE id = $1`,
          [closing.batch.id],
        );
        await holder.query('COMMIT');
        await expectHttp(() => attempt, 409, 'WINDOW_CLOSED');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      const missed = await timingRow(pending.id);
      assert.equal(missed.started_at, null);
      assert.equal(missed.duration_hours, null);
      assert.equal(missed.question_version_id, null);
    });

    test('concurrent starts capture one clock and do not deadlock with an admin edit', async () => {
      const created = await openBatch(48);
      await publishQuestion(created.actor, created.batch.id, '并发开始');
      const ready = await prepare(created.batch.id, 'conc@example.com', '20261051');
      const [first, second] = await Promise.all([
        startExam(ctx, ready.user.id, ready.id, 48),
        startExam(ctx, ready.user.id, ready.id, 48),
      ]);
      assert.equal(first.enrollment.startedAt, second.enrollment.startedAt);
      assert.equal(first.enrollment.deadline, second.enrollment.deadline);
      assert.equal(first.enrollment.durationHours, 48);
      const stored = await timingRow(ready.id);
      assert.equal(stored.duration_hours, 48);
      assert.equal(Number(stored.seconds), 48 * 60 * 60);
      const versions = await ctx.pool.query<{ linked: number; written: number }>(
        `SELECT count(DISTINCT e.question_version_id)::int AS linked,
                (SELECT count(*)::int FROM question_versions qv JOIN questions q ON q.id = qv.question_id WHERE q.batch_id = $1) AS written
         FROM enrollments e WHERE e.id = $2`,
        [created.batch.id, ready.id],
      );
      assert.equal(versions.rows[0]?.linked, 1);
      assert.equal(versions.rows[0]?.written, 2);
      const again = await startExam(ctx, ready.user.id, ready.id, 24);
      assert.equal(again.enrollment.startedAt, first.enrollment.startedAt);
      assert.equal((await timingRow(ready.id)).question_version_id, stored.question_version_id);
      const holder = await ctx.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM enrollments WHERE id = $1 FOR UPDATE', [ready.id]);
        const pending = updateBatch(ctx, created.actor, created.batch.id, { durationHours: 24 });
        const winner = await Promise.race([
          pending.then(() => 'done' as const),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
        ]);
        assert.equal(winner, 'done');
        const edited = await pending;
        assert.equal(edited.batch.durationHours, 24);
        await holder.query('ROLLBACK');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
      assert.equal((await timingRow(ready.id)).duration_hours, 48);
      const waiting = await prepare(created.batch.id, 'lock@example.com', '20261052');
      const locker = await ctx.pool.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM batches WHERE id = $1 FOR UPDATE', [created.batch.id]);
        const attempt = startExam(ctx, waiting.user.id, waiting.id, 24);
        await new Promise((resolve) => setTimeout(resolve, 200));
        await locker.query('COMMIT');
        const started = await attempt;
        assert.equal(started.enrollment.durationHours, 24);
      } finally {
        await locker.query('ROLLBACK').catch(() => undefined);
        locker.release();
      }
    });

    test('migration backfills 24 hour snapshots without moving extended deadlines', async () => {
      const client = await ctx.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_duration_snapshot_check');
        await client.query('ALTER TABLE enrollments DROP CONSTRAINT IF EXISTS enrollments_duration_hours_check');
        const round = await client.query<{ id: string }>(`INSERT INTO rounds (name) VALUES ('历史轮次') RETURNING id`);
        const roundId = round.rows[0]?.id;
        const batch = await client.query<{ id: string }>(
          `INSERT INTO batches (round_id, name, opens_at, start_closes_at, duration_hours, status)
           VALUES ($1, '历史批次', clock_timestamp() - interval '2 days', clock_timestamp() - interval '1 day', 24, 'CLOSED')
           RETURNING id`,
          [roundId],
        );
        const batchId = batch.rows[0]?.id;
        const extended = '2031-06-15T08:30:00.000Z';
        const kept = '2032-01-01T00:00:00.000Z';
        async function user(email: string, studentNo: string) {
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO users (role, name, email, password_hash, student_no) VALUES ('CANDIDATE', '历史考生', $1, 'x', $2) RETURNING id`,
            [email, studentNo],
          );
          return inserted.rows[0]?.id;
        }
        const legacyId = await user('legacy@example.com', 'hist-1');
        const capturedId = await user('captured@example.com', 'hist-2');
        const freshId = await user('fresh@example.com', 'hist-3');
        await client.query(
          `INSERT INTO enrollments (user_id, round_id, batch_id, direction, started_at, deadline, duration_hours)
           VALUES ($1, $2, $3, 'PRODUCT', clock_timestamp() - interval '30 hours', $4, NULL)`,
          [legacyId, roundId, batchId, extended],
        );
        await client.query(
          `INSERT INTO enrollments (user_id, round_id, batch_id, direction, started_at, deadline, duration_hours)
           VALUES ($1, $2, $3, 'PRODUCT', clock_timestamp() - interval '10 hours', $4, 48)`,
          [capturedId, roundId, batchId, kept],
        );
        await client.query(
          `INSERT INTO enrollments (user_id, round_id, batch_id, direction) VALUES ($1, $2, $3, 'DEVELOPMENT_TEST')`,
          [freshId, roundId, batchId],
        );
        const sql = await readFile(new URL('../migrations/005_exam_duration.sql', import.meta.url), 'utf8');
        await client.query(sql);
        const rows = await client.query<{ email: string; duration_hours: number | null; deadline: Date | null; started_at: Date | null }>(
          `SELECT u.email, e.duration_hours, e.deadline, e.started_at
           FROM enrollments e JOIN users u ON u.id = e.user_id
           WHERE u.email = ANY($1::text[])`,
          [['legacy@example.com', 'captured@example.com', 'fresh@example.com']],
        );
        const byEmail = new Map(rows.rows.map((row) => [row.email, row]));
        const legacy = byEmail.get('legacy@example.com');
        const captured = byEmail.get('captured@example.com');
        const fresh = byEmail.get('fresh@example.com');
        assert.equal(legacy?.duration_hours, 24);
        assert.equal(legacy?.deadline?.toISOString(), extended);
        assert.ok(legacy?.started_at);
        assert.equal(captured?.duration_hours, 48);
        assert.equal(captured?.deadline?.toISOString(), kept);
        assert.equal(fresh?.duration_hours, null);
        assert.equal(fresh?.deadline, null);
        assert.equal(fresh?.started_at, null);
        await client.query('ROLLBACK');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });

    test('policy and demo copy follow the batch length without changing the consent contract', async () => {
      assert.equal(DIRECT_UPLOAD_VERSION, 'assessment-materials-v2');
      assert.equal(CONSENT_VERSION, 'assessment-consent-v1');
      assert.equal(CONSENT_TEXT.includes('24 小时'), false);
      assert.match(CONSENT_TEXT, /按本批次时长连续计时/);
      assert.match(CONSENT_TEXT, /其他项目、无关聊天、账号凭据库/);
      assert.match(CONSENT_TEXT, /最多 20 个文件，总大小不超过 1 GB/);
      assert.match(CONSENT_TEXT, /到期不会自动交卷/);
      await seedDemo(ctx);
      const demo = await ctx.pool.query<{ description: string; duration_hours: number }>(
        `SELECT description, duration_hours FROM batches WHERE name = '第一批'`,
      );
      assert.equal(demo.rows[0]?.description.includes('24 小时'), false);
      assert.match(demo.rows[0]?.description ?? '', /按本批次时长/);
      assert.equal(demo.rows[0]?.duration_hours, 24);
    });
  });
}
