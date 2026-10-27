import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { insertAudit } from './audit.js';
import { withTx } from './db.js';
import { HttpError } from './errors.js';
import { enqueueMail } from './rateLimit.js';
import { assertNoSecretMarker, toCsv } from './security.js';
import { dbNow, examState, presentEnrollments, type Direction, type Enrollment } from './present.js';
import type { PublicUser } from './auth.js';

const iso = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const directionSchema = z.enum(['PRODUCT', 'DEVELOPMENT_TEST']);
const durationHoursSchema = z.union([z.literal(24), z.literal(48)]);

export const batchSchema = z.object({
  roundId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(2000).default(''),
  opensAt: iso,
  startClosesAt: iso,
  durationHours: durationHoursSchema,
  status: z.enum(['DRAFT', 'OPEN', 'CLOSED']),
}).strict();

export const batchPatchSchema = batchSchema.partial().refine((value) => Object.keys(value).length > 0);

export const questionSchema = z.object({
  batchId: z.string().uuid(),
  direction: directionSchema,
  title: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(100000),
  published: z.boolean(),
  attachmentIds: z.array(z.string().uuid()).max(10).default([]),
}).strict();

export const questionPatchSchema = questionSchema.partial().refine((value) => Object.keys(value).length > 0);

const STATE_SQL = `CASE
  WHEN e.finalized_at IS NOT NULL THEN 'FINALIZED'
  WHEN e.started_at IS NOT NULL AND e.deadline <= now() THEN 'EXPIRED'
  WHEN e.started_at IS NOT NULL THEN 'ACTIVE'
  ELSE 'READY'
END`;

export async function overview(ctx: AppContext) {
  const counts = await ctx.pool.query<{
    candidates: number; batches: number; active: number; finalized: number; unreviewed: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM users WHERE role = 'CANDIDATE') AS candidates,
       (SELECT count(*)::int FROM batches) AS batches,
       (SELECT count(*)::int FROM enrollments WHERE finalized_at IS NULL AND started_at IS NOT NULL AND deadline > now()) AS active,
       (SELECT count(*)::int FROM enrollments WHERE finalized_at IS NOT NULL) AS finalized,
       (SELECT count(*)::int FROM enrollments e WHERE e.finalized_at IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM reviews r WHERE r.enrollment_id = e.id
       )) AS unreviewed`,
  );
  const recent = await ctx.pool.query<{ id: string; actor_name: string; action: string; created_at: Date }>(
    `SELECT id, actor_name, action, created_at FROM audit_events ORDER BY created_at DESC LIMIT 8`,
  );
  return {
    counts: counts.rows[0] ?? { candidates: 0, batches: 0, active: 0, finalized: 0, unreviewed: 0 },
    recent: recent.rows.map((row) => ({
      id: row.id,
      actorName: row.actor_name,
      action: row.action,
      createdAt: new Date(row.created_at).toISOString(),
    })),
  };
}

export async function listRounds(ctx: AppContext) {
  const rows = await ctx.pool.query<{ id: string; name: string }>('SELECT id, name FROM rounds ORDER BY created_at, id');
  return { rounds: rows.rows };
}

export async function createRound(ctx: AppContext, actor: PublicUser, name: string) {
  const inserted = await withTx(ctx.pool, async (client) => {
    const row = await client.query<{ id: string; name: string }>(
      'INSERT INTO rounds (name) VALUES ($1) RETURNING id, name',
      [name],
    );
    await insertAudit(client, { actorId: actor.id, actorName: actor.name, action: 'ROUND_CREATE', details: { roundId: row.rows[0]?.id } });
    return row.rows[0];
  });
  if (!inserted) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
  return { round: inserted };
}

export async function listAdminBatches(ctx: AppContext) {
  const rows = await ctx.pool.query<{
    id: string; round_id: string; round_name: string; name: string; description: string;
    opens_at: Date; start_closes_at: Date; duration_hours: number; status: string;
  }>(
    `SELECT b.id, b.round_id, r.name AS round_name, b.name, b.description, b.opens_at, b.start_closes_at, b.duration_hours, b.status
     FROM batches b JOIN rounds r ON r.id = b.round_id
     ORDER BY b.opens_at, b.id`,
  );
  return {
    batches: rows.rows.map(mapBatch),
  };
}

export async function createBatch(ctx: AppContext, actor: PublicUser, input: z.infer<typeof batchSchema>) {
  assertWindow(input.opensAt, input.startClosesAt);
  const row = await withTx(ctx.pool, async (client) => {
    await assertRound(client, input.roundId);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO batches (round_id, name, description, opens_at, start_closes_at, duration_hours, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [input.roundId, input.name, input.description, input.opensAt, input.startClosesAt, input.durationHours, input.status],
    );
    await insertAudit(client, {
      actorId: actor.id,
      actorName: actor.name,
      action: 'BATCH_CREATE',
      details: { batchId: inserted.rows[0]?.id, durationHours: input.durationHours },
    });
    return inserted.rows[0]?.id;
  });
  if (!row) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
  return { batch: await loadBatch(ctx, row) };
}

export async function updateBatch(ctx: AppContext, actor: PublicUser, id: string, patch: z.infer<typeof batchPatchSchema>) {
  const batch = await withTx(ctx.pool, async (client) => {
    // Batch row only. Start locks the enrollment first and this batch second; locking enrollments here would deadlock.
    const current = await client.query<{
      round_id: string; name: string; description: string; opens_at: Date; start_closes_at: Date; duration_hours: number; status: string;
    }>('SELECT round_id, name, description, opens_at, start_closes_at, duration_hours, status FROM batches WHERE id = $1 FOR UPDATE', [id]);
    const row = current.rows[0];
    if (!row) throw new HttpError(404, '未找到', 'NOT_FOUND');
    const next = {
      roundId: patch.roundId ?? row.round_id,
      name: patch.name ?? row.name,
      description: patch.description ?? row.description,
      opensAt: patch.opensAt ?? new Date(row.opens_at).toISOString(),
      startClosesAt: patch.startClosesAt ?? new Date(row.start_closes_at).toISOString(),
      durationHours: patch.durationHours ?? row.duration_hours,
      status: patch.status ?? row.status,
    };
    assertWindow(next.opensAt, next.startClosesAt);
    await assertRound(client, next.roundId);
    await client.query(
      `UPDATE batches SET round_id = $2, name = $3, description = $4, opens_at = $5, start_closes_at = $6,
              duration_hours = $7, status = $8
       WHERE id = $1`,
      [id, next.roundId, next.name, next.description, next.opensAt, next.startClosesAt, next.durationHours, next.status],
    );
    await insertAudit(client, {
      actorId: actor.id,
      actorName: actor.name,
      action: 'BATCH_UPDATE',
      details: { batchId: id, durationHours: next.durationHours },
    });
    return id;
  });
  return { batch: await loadBatch(ctx, batch) };
}

export async function listQuestions(ctx: AppContext, batchId?: string) {
  const rows = await ctx.pool.query<{
    id: string; batch_id: string; direction: Direction; title: string; content: string; published: boolean;
  }>(
    `SELECT id, batch_id, direction, title, content, published FROM questions
     WHERE ($1::uuid IS NULL OR batch_id = $1) ORDER BY created_at, id LIMIT 200`,
    [batchId ?? null],
  );
  const links = await ctx.pool.query<{ question_id: string; attachment_id: string; original_name: string; size_bytes: number }>(
    `SELECT qa.question_id, a.id AS attachment_id, a.original_name, a.size_bytes
     FROM question_attachments qa JOIN attachments a ON a.id = qa.attachment_id
     WHERE qa.question_id = ANY($1::uuid[])
     ORDER BY qa.position`,
    [rows.rows.map((row) => row.id).concat(['00000000-0000-0000-0000-000000000000'])],
  );
  return {
    questions: rows.rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      direction: row.direction,
      title: row.title,
      content: row.content,
      published: row.published,
      attachments: links.rows.filter((link) => link.question_id === row.id).map((link) => ({
        id: link.attachment_id,
        name: link.original_name,
        size: link.size_bytes,
        url: `/api/attachments/${link.attachment_id}`,
      })),
    })),
  };
}

export async function createQuestion(ctx: AppContext, actor: PublicUser, input: z.infer<typeof questionSchema>) {
  const id = await withTx(ctx.pool, async (client) => saveQuestion(client, actor, null, input));
  return { question: (await listQuestions(ctx, undefined)).questions.find((item) => item.id === id) };
}

export async function updateQuestion(ctx: AppContext, actor: PublicUser, id: string, patch: z.infer<typeof questionPatchSchema>) {
  await withTx(ctx.pool, async (client) => {
    const current = await client.query<{
      batch_id: string; direction: Direction; title: string; content: string; published: boolean;
    }>('SELECT batch_id, direction, title, content, published FROM questions WHERE id = $1 FOR UPDATE', [id]);
    const row = current.rows[0];
    if (!row) throw new HttpError(404, '未找到', 'NOT_FOUND');
    const links = await client.query<{ attachment_id: string }>(
      'SELECT attachment_id FROM question_attachments WHERE question_id = $1 ORDER BY position',
      [id],
    );
    await saveQuestion(client, actor, id, {
      batchId: patch.batchId ?? row.batch_id,
      direction: patch.direction ?? row.direction,
      title: patch.title ?? row.title,
      content: patch.content ?? row.content,
      published: patch.published ?? row.published,
      attachmentIds: patch.attachmentIds ?? links.rows.map((item) => item.attachment_id),
    });
  });
  const questions = await listQuestions(ctx);
  const question = questions.questions.find((item) => item.id === id);
  if (!question) throw new HttpError(404, '未找到', 'NOT_FOUND');
  return { question };
}

async function saveQuestion(client: PoolClient, actor: PublicUser, id: string | null, input: z.infer<typeof questionSchema>) {
  const batch = await client.query('SELECT 1 FROM batches WHERE id = $1', [input.batchId]);
  if ((batch.rowCount ?? 0) === 0) throw new HttpError(400, '批次不存在', 'VALIDATION');
  if (input.attachmentIds.length) {
    const found = await client.query('SELECT id FROM attachments WHERE id = ANY($1::uuid[])', [input.attachmentIds]);
    if ((found.rowCount ?? 0) !== input.attachmentIds.length) throw new HttpError(400, '附件不存在', 'VALIDATION');
  }
  let questionId = id;
  if (!questionId) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO questions (batch_id, direction, title, content, published) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.batchId, input.direction, input.title, input.content, input.published],
    );
    questionId = inserted.rows[0]?.id ?? null;
  } else {
    await client.query(
      `UPDATE questions SET batch_id = $2, direction = $3, title = $4, content = $5, published = $6, updated_at = now() WHERE id = $1`,
      [questionId, input.batchId, input.direction, input.title, input.content, input.published],
    );
  }
  if (!questionId) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
  await client.query('DELETE FROM question_attachments WHERE question_id = $1', [questionId]);
  for (let index = 0; index < input.attachmentIds.length; index += 1) {
    await client.query(
      'INSERT INTO question_attachments (question_id, attachment_id, position) VALUES ($1, $2, $3)',
      [questionId, input.attachmentIds[index], index],
    );
  }
  if (input.published) {
    await client.query(
      `INSERT INTO question_versions (question_id, version_no, title, content, attachment_ids)
       VALUES ($1, (SELECT coalesce(max(version_no), 0) + 1 FROM question_versions WHERE question_id = $1), $2, $3, $4::uuid[])`,
      [questionId, input.title, input.content, input.attachmentIds],
    );
  }
  await insertAudit(client, { actorId: actor.id, actorName: actor.name, action: id ? 'QUESTION_UPDATE' : 'QUESTION_CREATE', details: { questionId } });
  return questionId;
}

export async function listCandidates(ctx: AppContext, query: { search?: string; state?: string; batchId?: string; risk?: 'PENDING' | 'RESTRICTED'; offset: number }) {
  const params: unknown[] = [];
  const where = ["u.role = 'CANDIDATE'"];
  if (query.search) {
    params.push(`%${query.search.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(u.name ILIKE $${params.length} ESCAPE '\\' OR u.student_no ILIKE $${params.length} ESCAPE '\\' OR u.email ILIKE $${params.length} ESCAPE '\\')`);
  }
  if (query.batchId) {
    params.push(query.batchId);
    where.push(`EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = u.id AND e.batch_id = $${params.length})`);
  }
  if (query.state) {
    params.push(query.state);
    where.push(`EXISTS (SELECT 1 FROM enrollments e WHERE e.user_id = u.id AND ${STATE_SQL} = $${params.length})`);
  }
  if (query.risk === 'PENDING') where.push("EXISTS (SELECT 1 FROM user_registration_risk risk WHERE risk.user_id=u.id AND risk.review_state='PENDING')");
  if (query.risk === 'RESTRICTED') where.push("EXISTS (SELECT 1 FROM user_registration_risk risk WHERE risk.user_id=u.id AND risk.start_restricted=true)");
  const counted = await ctx.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM users u WHERE ${where.join(' AND ')}`,
    params,
  );
  const limit = 100;
  params.push(query.offset);
  const users = await ctx.pool.query<{
    id: string; role: 'CANDIDATE'; name: string; email: string; student_no: string | null;
    college: string | null; major: string | null; phone: string | null;
  }>(
    `SELECT u.id, u.role, u.name, u.email, u.student_no, u.college, u.major, u.phone
     FROM users u WHERE ${where.join(' AND ')}
     ORDER BY u.student_no NULLS LAST, u.id
     LIMIT ${limit} OFFSET $${params.length}`,
    params,
  );
  const enrollments = await ctx.pool.query<{ id: string; user_id: string; batch_id: string; finalized_at: Date | null; started_at: Date | null; deadline: Date | null }>(
    `SELECT id, user_id, batch_id, finalized_at, started_at, deadline FROM enrollments WHERE user_id = ANY($1::uuid[])`,
    [users.rows.map((row) => row.id).concat(['00000000-0000-0000-0000-000000000000'])],
  );
  const filtered = enrollments.rows.filter((row) => {
    if (query.batchId && row.batch_id !== query.batchId) return false;
    if (query.state && examState(row, new Date()) !== query.state) return false;
    return true;
  });
  const presented = await presentEnrollments(ctx.pool, filtered.map((row) => row.id), 'admin');
  return {
    candidates: users.rows.map((user) => ({
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
      ...(user.student_no ? { studentNo: user.student_no } : {}),
      ...(user.college ? { college: user.college } : {}),
      ...(user.major ? { major: user.major } : {}),
      ...(user.phone ? { phone: user.phone } : {}),
      enrollments: filtered.flatMap((row) => (row.user_id === user.id ? [presented.get(row.id)].filter((item): item is Enrollment => Boolean(item)) : [])),
    })),
    total: counted.rows[0]?.n ?? 0,
    limit,
    offset: query.offset,
  };
}

export async function adminEnrollment(ctx: AppContext, id: string) {
  const user = await ctx.pool.query<{
    id: string; role: 'CANDIDATE' | 'ADMIN'; name: string; email: string; student_no: string | null;
    college: string | null; major: string | null; phone: string | null; user_id: string;
  }>(
    `SELECT u.id, u.role, u.name, u.email, u.student_no, u.college, u.major, u.phone, e.user_id
     FROM enrollments e JOIN users u ON u.id = e.user_id WHERE e.id = $1`,
    [id],
  );
  const row = user.rows[0];
  if (!row) throw new HttpError(404, '未找到', 'NOT_FOUND');
  const enrollment = (await presentEnrollments(ctx.pool, [id], 'admin')).get(id);
  if (!enrollment) throw new HttpError(404, '未找到', 'NOT_FOUND');
  const review = await ctx.pool.query<{ score: number; feedback: string; published_at: Date | null }>(
    'SELECT score, feedback, published_at FROM reviews WHERE enrollment_id = $1',
    [id],
  );
  const item = review.rows[0];
  return {
    enrollment,
    user: {
      id: row.id,
      role: row.role,
      name: row.name,
      email: row.email,
      ...(row.student_no ? { studentNo: row.student_no } : {}),
      ...(row.college ? { college: row.college } : {}),
      ...(row.major ? { major: row.major } : {}),
      ...(row.phone ? { phone: row.phone } : {}),
    },
    review: item ? { score: item.score, feedback: item.feedback, publishedAt: item.published_at ? new Date(item.published_at).toISOString() : null } : null,
    serverNow: (await dbNow(ctx.pool)).toISOString(),
  };
}

export async function extendDeadline(ctx: AppContext, actor: PublicUser, enrollmentId: string, minutes: number, reason: string) {
  const clean = reason.trim();
  if (clean.length < 1 || clean.length > 500 || /[\u0000-\u001f]/.test(clean)) {
    throw new HttpError(400, '请填写延期原因', 'VALIDATION');
  }
  assertNoSecretMarker(clean);
  return withTx(ctx.pool, async (client) => {
    const locked = await client.query<{ finalized_at: Date | null; started_at: Date | null }>(
      'SELECT finalized_at, started_at FROM enrollments WHERE id = $1 FOR UPDATE',
      [enrollmentId],
    );
    const row = locked.rows[0];
    if (!row) throw new HttpError(404, '未找到', 'NOT_FOUND');
    if (row.finalized_at) throw new HttpError(409, '已交卷的考核不能延期', 'FINALIZED');
    if (!row.started_at) throw new HttpError(409, '考核尚未开始', 'NOT_STARTED');
    await client.query(
      `UPDATE enrollments
       SET deadline = CASE WHEN deadline > clock_timestamp() THEN deadline ELSE clock_timestamp() END + ($2::int * interval '1 minute'),
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [enrollmentId, minutes],
    );
    await client.query(
      `UPDATE mcp_tokens SET expires_at = (SELECT deadline FROM enrollments WHERE id = $1)
       WHERE enrollment_id = $1 AND revoked_at IS NULL`,
      [enrollmentId],
    );
    // Extend still-live uploads clamped by the exam deadline, without reviving expired tickets.
    await client.query(
      `UPDATE material_uploads u SET expires_at=least(e.deadline,u.created_at+interval '2 hours')
       FROM enrollments e WHERE u.enrollment_id=e.id AND e.id=$1
       AND u.status IN ('AWAITING_FILES','UPLOADING') AND u.expires_at>clock_timestamp()
       AND u.expires_at<least(e.deadline,u.created_at+interval '2 hours')`, [enrollmentId],
    );
    await insertAudit(client, {
      actorId: actor.id,
      actorName: actor.name,
      action: 'DEADLINE_EXTEND',
      enrollmentId,
      details: { minutes, reason: clean },
    });
    const enrollment = (await presentEnrollments(client, [enrollmentId], 'admin')).get(enrollmentId);
    if (!enrollment) throw new HttpError(404, '未找到', 'NOT_FOUND');
    return { enrollment };
  });
}

export async function saveReview(ctx: AppContext, actor: PublicUser, enrollmentId: string, score: number, feedback: string) {
  assertNoSecretMarker(feedback);
  return withTx(ctx.pool, async (client) => {
    const enrollment = await client.query<{ finalized_at: Date | null }>('SELECT finalized_at FROM enrollments WHERE id = $1 FOR UPDATE', [enrollmentId]);
    if (!enrollment.rows[0]) throw new HttpError(404, '未找到', 'NOT_FOUND');
    if (!enrollment.rows[0].finalized_at) throw new HttpError(409, '只能评阅已交卷的考核', 'CONFLICT');
    const current = await client.query<{ score: number; feedback: string; published_at: Date | null }>(
      'SELECT score, feedback, published_at FROM reviews WHERE enrollment_id = $1 FOR UPDATE',
      [enrollmentId],
    );
    const existing = current.rows[0];
    if (existing?.published_at) {
      if (existing.score !== score || existing.feedback !== feedback) {
        throw new HttpError(409, '成绩发布后不能修改', 'CONFLICT');
      }
      return { review: { score: existing.score, feedback: existing.feedback, publishedAt: new Date(existing.published_at).toISOString() } };
    }
    await client.query(
      `INSERT INTO reviews (enrollment_id, score, feedback) VALUES ($1, $2, $3)
       ON CONFLICT (enrollment_id) DO UPDATE SET score = EXCLUDED.score, feedback = EXCLUDED.feedback, updated_at = now()`,
      [enrollmentId, score, feedback],
    );
    await insertAudit(client, { actorId: actor.id, actorName: actor.name, action: 'REVIEW', enrollmentId, details: { score } });
    return { review: { score, feedback, publishedAt: null } };
  });
}

export async function publishReview(ctx: AppContext, actor: PublicUser, enrollmentId: string) {
  return withTx(ctx.pool, async (client) => {
    const review = await client.query<{ score: number; feedback: string; published_at: Date | null }>(
      'SELECT score, feedback, published_at FROM reviews WHERE enrollment_id = $1 FOR UPDATE',
      [enrollmentId],
    );
    const row = review.rows[0];
    if (!row) throw new HttpError(409, '请先保存评分', 'CONFLICT');
    if (!row.published_at) {
      await client.query('UPDATE reviews SET published_at = now(), updated_at = now() WHERE enrollment_id = $1', [enrollmentId]);
      const person = await client.query<{ email: string; name: string; batch_name: string; round_name: string }>(
        `SELECT u.email, u.name, b.name AS batch_name, r.name AS round_name
         FROM enrollments e
         JOIN users u ON u.id = e.user_id
         JOIN batches b ON b.id = e.batch_id
         JOIN rounds r ON r.id = e.round_id
         WHERE e.id = $1`,
        [enrollmentId],
      );
      const who = person.rows[0];
      if (who) {
        await enqueueMail(client, {
          to: who.email,
          subject: '110实验室考核结果',
          body: `${who.name} 同学，您好：\n\n您在「${who.round_name} / ${who.batch_name}」的考核成绩已发布。\n分数：${row.score}\n评语：\n${row.feedback}\n\n查看：${ctx.config.appOrigin}/recruitment/exam/${enrollmentId}\n\n110实验室考核系统\n`,
          idempotencyKey: `publish:${enrollmentId}`,
        });
      }
      await insertAudit(client, { actorId: actor.id, actorName: actor.name, action: 'PUBLISH_RESULT', enrollmentId, details: { score: row.score } });
    }
    const fresh = await client.query<{ published_at: Date }>('SELECT published_at FROM reviews WHERE enrollment_id = $1', [enrollmentId]);
    return { review: { score: row.score, feedback: row.feedback, publishedAt: new Date(fresh.rows[0]?.published_at ?? new Date()).toISOString() } };
  });
}

export async function exportCsv(ctx: AppContext, actor: PublicUser): Promise<string> {
  const rows = await ctx.pool.query<{
    name: string; student_no: string | null; college: string | null; major: string | null; phone: string | null; email: string;
    round_name: string; batch_name: string; direction: string; finalized_at: Date | null; started_at: Date | null; deadline: Date | null;
    sha: string | null; materials_hash: string | null; score: number | null; feedback: string | null; published_at: Date | null;
  }>(
    `SELECT u.name, u.student_no, u.college, u.major, u.phone, u.email, r.name AS round_name, b.name AS batch_name,
            e.direction, e.finalized_at, e.started_at, e.deadline, repo.sha,
            m.sha256 AS materials_hash, rv.score, rv.feedback, rv.published_at
     FROM enrollments e
     JOIN users u ON u.id = e.user_id
     JOIN batches b ON b.id = e.batch_id
     JOIN rounds r ON r.id = e.round_id
     LEFT JOIN repositories repo ON repo.id = e.repository_id
     LEFT JOIN LATERAL (
       SELECT sha256 FROM materials WHERE enrollment_id = e.id AND invalidated_at IS NULL ORDER BY received_at DESC LIMIT 1
     ) m ON true
     LEFT JOIN reviews rv ON rv.enrollment_id = e.id
     ORDER BY u.student_no NULLS LAST, e.created_at
     LIMIT 50000`,
  );
  const now = await dbNow(ctx.pool);
  const header = ['姓名', '学号', '学院', '专业', '手机', '邮箱', '轮次', '批次', '方向', '状态', '开始时间', '截止时间', '交卷时间', '仓库SHA', '材料SHA', '分数', '评语', '成绩发布时间'];
  const body = rows.rows.map((row) => [
    row.name, row.student_no, row.college, row.major, row.phone, row.email, row.round_name, row.batch_name, row.direction,
    examState(row, now), isoDate(row.started_at), isoDate(row.deadline), isoDate(row.finalized_at), row.sha, row.materials_hash,
    row.score, row.feedback, isoDate(row.published_at),
  ]);
  await withTx(ctx.pool, async (client) => {
    await insertAudit(client, { actorId: actor.id, actorName: actor.name, action: 'EXPORT', details: { rowCount: rows.rows.length } });
  });
  return toCsv([header, ...body]);
}

export async function listAudit(ctx: AppContext) {
  const rows = await ctx.pool.query<{ id: string; actor_name: string; action: string; created_at: Date; details: Record<string, unknown> }>(
    'SELECT id, actor_name, action, created_at, details FROM audit_events ORDER BY created_at DESC LIMIT 200',
  );
  return {
    events: rows.rows.map((row) => ({
      id: row.id,
      actorName: row.actor_name,
      action: row.action,
      createdAt: new Date(row.created_at).toISOString(),
      details: row.details ?? {},
    })),
  };
}

async function loadBatch(ctx: AppContext, id: string) {
  const rows = await listAdminBatches(ctx);
  const batch = rows.batches.find((item) => item.id === id);
  if (!batch) throw new HttpError(404, '未找到', 'NOT_FOUND');
  return batch;
}

function mapBatch(row: {
  id: string; round_id: string; round_name: string; name: string; description: string;
  opens_at: Date; start_closes_at: Date; duration_hours: number; status: string;
}) {
  return {
    id: row.id,
    roundId: row.round_id,
    roundName: row.round_name,
    name: row.name,
    description: row.description,
    opensAt: new Date(row.opens_at).toISOString(),
    startClosesAt: new Date(row.start_closes_at).toISOString(),
    durationHours: row.duration_hours,
    status: row.status,
  };
}

function assertWindow(opensAt: string, startClosesAt: string): void {
  if (Date.parse(startClosesAt) <= Date.parse(opensAt)) {
    throw new HttpError(400, '结束时间必须晚于开始时间', 'VALIDATION');
  }
}

async function assertRound(client: PoolClient, id: string): Promise<void> {
  const found = await client.query('SELECT 1 FROM rounds WHERE id = $1', [id]);
  if ((found.rowCount ?? 0) === 0) throw new HttpError(400, '轮次不存在', 'VALIDATION');
}

function isoDate(value: Date | null): string {
  return value ? new Date(value).toISOString() : '';
}
