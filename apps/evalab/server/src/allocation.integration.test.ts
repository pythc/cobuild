import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createContext, closeContext, type AppContext } from './context.js';
import { createPool } from './db.js';
import { createBatch, createQuestion, createRound, updateQuestion } from './admin.js';
import { acceptConsent, authenticateMcp, createEnrollment, getEnrollmentForActor, issueMcpToken, probeMcp, startExam, type Direction } from './assessment.js';
import type { PublicUser } from './auth.js';
import { HttpError } from './errors.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
describe('balanced question allocation', { skip: !databaseUrl, concurrency: 1, timeout: 60000 }, () => {
  const schema = `allocation_${process.pid}`;
  let ctx: AppContext;
  let peer: AppContext;
  let admin: PublicUser;
  let seq = 0;

  before(async () => {
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl!, DB_SCHEMA: schema, NODE_ENV: 'test',
      APP_ORIGIN: 'http://127.0.0.1:5173', PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
      SESSION_SECRET: 'allocation-test-secret-32-characters', MAIL_TEST_SINK: 'true',
      SEED_DEMO: 'false', ADMIN_EMAIL: 'allocation-admin@example.test', ADMIN_PASSWORD: 'Fixture-password-123',
    });
    delete process.env.SMTP_HOST;
    delete process.env.LEGACY_APP_ORIGINS;
    delete process.env.EMBEDDING_ORIGINS;
    ctx = await createContext();
    peer = { ...ctx, pool: createPool(databaseUrl!, schema) };
    const row = (await ctx.pool.query("SELECT id, name, email FROM users WHERE role='ADMIN'")).rows[0];
    admin = { ...row, role: 'ADMIN' };
  });

  after(async () => {
    if (peer) await closeContext(peer);
    if (ctx) {
      await ctx.pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await closeContext(ctx);
    }
  });

  async function batch() {
    const round = await createRound(ctx, admin, `均衡分配-${++seq}`);
    return (await createBatch(ctx, admin, {
      roundId: round.round.id, name: '分配批次', description: '',
      opensAt: new Date(Date.now() - 3600000).toISOString(),
      startClosesAt: new Date(Date.now() + 86400000).toISOString(), durationHours: 48, status: 'OPEN',
    })).batch.id;
  }

  async function question(batchId: string, title: string, direction: Direction = 'PRODUCT', published = true) {
    const created = await createQuestion(ctx, admin, { batchId, title, content: title, direction, published, attachmentIds: [] });
    assert.ok(created.question);
    return created.question.id;
  }

  async function ready(batchId: string, direction: Direction = 'PRODUCT') {
    const email = `${randomUUID()}@example.test`;
    const row = (await ctx.pool.query(
      "INSERT INTO users(role,name,email,password_hash,accepted_policy_at) VALUES('CANDIDATE','分配测试',$1,'not-used',now()) RETURNING id", [email],
    )).rows[0];
    const e = await createEnrollment(ctx, row.id, batchId, direction);
    await acceptConsent(ctx, row.id, e.id);
    const issued = await issueMcpToken(ctx, row.id, e.id);
    await probeMcp(ctx, await authenticateMcp(ctx, issued.token));
    return { userId: row.id as string, id: e.id };
  }

  async function assigned(enrollmentId: string) {
    return (await ctx.pool.query(
      'SELECT v.question_id, e.question_version_id, e.started_at, e.deadline FROM enrollments e LEFT JOIN question_versions v ON v.id=e.question_version_id WHERE e.id=$1', [enrollmentId],
    )).rows[0];
  }

  async function start(batchId: string, direction: Direction = 'PRODUCT') {
    const e = await ready(batchId, direction);
    await startExam(ctx, e.userId, e.id, 48);
    return { ...e, ...(await assigned(e.id)) };
  }

  async function counts(ids: string[]) {
    const rows = (await ctx.pool.query<{ question_id: string; n: number }>(
      'SELECT v.question_id,count(*)::int AS n FROM enrollments e JOIN question_versions v ON v.id=e.question_version_id WHERE v.question_id=ANY($1::uuid[]) AND e.started_at IS NOT NULL GROUP BY v.question_id', [ids],
    )).rows;
    return ids.map(id => rows.find(row => row.question_id === id)?.n ?? 0);
  }

  test('unused questions come first, editorial versions do not count, existing assignments stay locked', async () => {
    const b = await batch();
    const first = await question(b, '题目一');
    const original = await start(b);
    assert.equal(original.question_id, first);
    const second = await question(b, '题目二');
    for (let i = 0; i < 3; i++) await updateQuestion(ctx, admin, second, { content: `修订${i}` });
    const waiting = await ready(b);
    const user: PublicUser = { id: waiting.userId, role: 'CANDIDATE', name: '分配测试', email: 'not-used@example.test' };
    assert.equal((await getEnrollmentForActor(ctx, user, waiting.id)).enrollment.question, null);
    assert.deepEqual(await counts([first, second]), [1, 0]);
    await startExam(ctx, waiting.userId, waiting.id, 48);
    assert.equal((await assigned(waiting.id)).question_id, second);
    await startExam(ctx, original.userId, original.id, 48);
    assert.deepEqual(await assigned(original.id), {
      question_id: first, question_version_id: original.question_version_id,
      started_at: original.started_at, deadline: original.deadline,
    });
    assert.deepEqual(await counts([first, second]), [1, 1]);
  });

  test('new questions catch up with historical imbalance before heavily used questions get another participant', async () => {
    const b = await batch();
    const a = await question(b, '历史热门题');
    for (let i = 0; i < 5; i++) await start(b);
    const c = await question(b, '新题');
    for (let i = 0; i < 5; i++) assert.equal((await start(b)).question_id, c);
    assert.deepEqual(await counts([a, c]), [5, 5]);
    const d = await question(b, '后来加入的题');
    for (let i = 0; i < 5; i++) assert.equal((await start(b)).question_id, d);
    for (let i = 0; i < 3; i++) await start(b);
    assert.deepEqual(await counts([a, c, d]), [6, 6, 6]);
  });

  test('finalized and expired participants count; unpublished, other direction and other batch questions stay out', async () => {
    const b = await batch();
    const a = await question(b, '已参与题');
    const done = await start(b), expired = await start(b);
    await ctx.pool.query('UPDATE enrollments SET finalized_at=clock_timestamp() WHERE id=$1', [done.id]);
    await ctx.pool.query("UPDATE enrollments SET started_at=now()-interval '49 hours',deadline=now()-interval '1 hour' WHERE id=$1", [expired.id]);
    const c = await question(b, '参与较少题');
    assert.equal((await start(b)).question_id, c);
    const hidden = await question(b, '未发布题', 'PRODUCT', false);
    const dev = await question(b, '开发题', 'DEVELOPMENT_TEST');
    const elsewhere = await question(await batch(), '其他批次题');
    assert.equal((await start(b)).question_id, c);
    assert.equal((await start(b, 'DEVELOPMENT_TEST')).question_id, dev);
    assert.deepEqual(await counts([a, c, hidden, dev, elsewhere]), [2, 2, 0, 1, 0]);
  });

  test('concurrent starts across independent connections remain even and duplicate requests cannot reroll', async () => {
    const b = await batch();
    const ids = await Promise.all(['并发一', '并发二', '并发三'].map(title => question(b, title)));
    const candidates = [];
    for (let i = 0; i < 24; i++) candidates.push(await ready(b));
    const starts = candidates.map((e, i) => startExam(i % 2 ? peer : ctx, e.userId, e.id, 48));
    const duplicate = startExam(peer, candidates[0]!.userId, candidates[0]!.id, 48);
    const results = await Promise.all(starts);
    assert.equal((await duplicate).enrollment.startedAt, results[0]!.enrollment.startedAt);
    assert.deepEqual(await counts(ids), [8, 8, 8]);
    const saved = await assigned(candidates[0]!.id);
    await startExam(ctx, candidates[0]!.userId, candidates[0]!.id, 24);
    assert.deepEqual(await assigned(candidates[0]!.id), saved);
  });

  test('an empty published pool leaves the attempt unstarted and can be retried after publication', async () => {
    const b = await batch(), q = await question(b, '待发布', 'PRODUCT', false), e = await ready(b);
    await assert.rejects(startExam(ctx, e.userId, e.id, 48), error => error instanceof HttpError && error.code === 'EMPTY_POOL');
    assert.deepEqual(await assigned(e.id), { question_id: null, question_version_id: null, started_at: null, deadline: null });
    await updateQuestion(ctx, admin, q, { published: true });
    assert.equal((await startExam(ctx, e.userId, e.id, 48)).enrollment.question?.title, '待发布');
    assert.deepEqual(await counts([q]), [1]);
  });
});
