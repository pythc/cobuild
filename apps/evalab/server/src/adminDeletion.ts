import { lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { insertAudit } from './audit.js';
import { withTx } from './db.js';
import { HttpError } from './errors.js';
import { asyncHandler, requireAdmin, routeId } from './http.js';
import { canonicalJson, safeEqualString, sha256Hex } from './security.js';

const KINDS = ['round', 'batch', 'question', 'candidate', 'enrollment'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const LOCK_TIMEOUT = '1500ms';

export type DeletionKind = (typeof KINDS)[number];

export type DeletionPreview = {
  kind: DeletionKind;
  id: string;
  title: string;
  allowed: boolean;
  reason: string | null;
  fingerprint: string;
  counts: {
    batches: number;
    questions: number;
    enrollments: number;
    materials: number;
    files: number;
  };
  consequences: string[];
};

type JsonValue = string | number | boolean | null;
type JsonRow = Record<string, JsonValue>;

type DeletionState = {
  kind: DeletionKind;
  target: JsonRow;
  batches: JsonRow[];
  questions: JsonRow[];
  versions: JsonRow[];
  enrollments: JsonRow[];
  materials: JsonRow[];
  uploads: JsonRow[];
  files: JsonRow[];
  reviews: JsonRow[];
  receipts: JsonRow[];
  oauthCodes: JsonRow[];
  oauthGrants: JsonRow[];
  sessions: JsonRow[];
  challenges: JsonRow[];
  notifications: JsonRow[];
};

type Scope = {
  preview: DeletionPreview;
  fileIds: string[];
  enrollmentIds: string[];
};

const confirmSchema = z.object({
  confirmation: z.string(),
  fingerprint: z.string(),
}).strict();

export function registerAdminDeletion(router: Router, ctx: AppContext): void {
  router.get('/admin/deletions/:kind/:id', asyncHandler(async (req, res) => {
    requireAdmin(req);
    const kind = parseKind(req.params.kind);
    const id = routeId(req.params.id);
    res.json({ preview: await previewAdminDeletion(ctx, kind, id) });
  }));

  router.delete('/admin/deletions/:kind/:id', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const kind = parseKind(req.params.kind);
    const id = routeId(req.params.id);
    const body = confirmSchema.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError(400, '请准确输入“删除”以确认', 'VALIDATION');
    res.json(await executeAdminDeletion(ctx, { id: auth.user.id, name: auth.user.name }, kind, id, body.data.confirmation, body.data.fingerprint));
  }));
}

export async function previewAdminDeletion(ctx: AppContext, kind: DeletionKind, id: string): Promise<DeletionPreview> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const scope = await loadScope(client, kind, id, false);
    await client.query('COMMIT');
    if (!scope) throw new HttpError(404, '未找到', 'NOT_FOUND');
    return scope.preview;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function executeAdminDeletion(
  ctx: AppContext,
  actor: { id: string; name: string },
  kind: DeletionKind,
  id: string,
  confirmation: string,
  fingerprint: string,
): Promise<{ ok: true; kind: DeletionKind; id: string; filesQueued: number }> {
  if (confirmation !== '删除' || !FINGERPRINT_RE.test(fingerprint)) {
    throw new HttpError(400, '请准确输入“删除”以确认', 'VALIDATION');
  }
  try {
    return await withTx(ctx.pool, async (client) => {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      const administrator = await client.query(`SELECT id FROM users WHERE id = $1 AND role = 'ADMIN' FOR KEY SHARE`, [actor.id]);
      if (!administrator.rowCount) throw new HttpError(403, '仅管理员可执行删除', 'FORBIDDEN');
      const scope = await loadScope(client, kind, id, true);
      if (!scope) throw new HttpError(404, '未找到', 'NOT_FOUND');
      if (!safeEqualString(scope.preview.fingerprint, fingerprint)) {
        throw new HttpError(409, '预览已过期，请重新确认后再删除', 'PREVIEW_CHANGED');
      }
      if (!scope.preview.allowed) {
        throw new HttpError(409, scope.preview.reason ?? '当前不能删除', 'DELETION_BLOCKED');
      }
      const filesQueued = await applyDeletion(client, scope);
      await insertAudit(client, {
        actorId: actor.id,
        actorName: actor.name,
        action: 'ADMIN_DELETE',
        enrollmentId: kind === 'enrollment' ? id : null,
        details: {
          kind,
          targetId: id,
          fileCount: filesQueued,
          enrollmentCount: scope.enrollmentIds.length,
        },
      });
      return { ok: true as const, kind, id, filesQueued };
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (isBusy(error)) throw new HttpError(409, '相关数据正在被使用，请稍后重试', 'DELETION_BUSY');
    throw error;
  }
}

export async function purgeDeletedMaterialFiles(ctx: AppContext): Promise<number> {
  const pending = await ctx.pool.query<{ file_id: string }>(
    `SELECT file_id FROM deleted_material_files
     WHERE deleted_at IS NULL AND next_attempt_at <= clock_timestamp()
     ORDER BY created_at
     LIMIT 30`,
  );
  let removed = 0;
  for (const row of pending.rows) {
    if (await purgeOneFile(ctx, row.file_id)) removed += 1;
  }
  return removed;
}

async function purgeOneFile(ctx: AppContext, fileId: string): Promise<boolean> {
  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{ attempts: number }>(
      `SELECT attempts FROM deleted_material_files
       WHERE file_id = $1 AND deleted_at IS NULL AND next_attempt_at <= clock_timestamp()
       FOR UPDATE SKIP LOCKED`,
      [fileId],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return false;
    }
    try {
      await removeStoredMaterial(ctx.config.storageDir, fileId);
      await client.query(
        `UPDATE deleted_material_files SET deleted_at = clock_timestamp(), last_error = NULL WHERE file_id = $1`,
        [fileId],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'remove-failed';
      await client.query(
        `UPDATE deleted_material_files
         SET attempts = LEAST(attempts + 1, 1000000),
             next_attempt_at = clock_timestamp() + make_interval(secs => LEAST(3600, 60 * power(2, LEAST(attempts, 6)))::int),
             last_error = $2
         WHERE file_id = $1`,
        [fileId, code.slice(0, 80)],
      );
      await client.query('COMMIT');
      return false;
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function removeStoredMaterial(storageDir: string, fileId: string): Promise<void> {
  const target = materialFilePath(storageDir, fileId);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    await rm(target, { force: true });
    return;
  }
  if (info.isDirectory()) {
    const refusal = new Error('refusing-directory') as NodeJS.ErrnoException;
    refusal.code = 'EISDIR';
    throw refusal;
  }
  await rm(target, { force: true });
}

function materialFilePath(storageDir: string, fileId: string): string {
  if (!UUID_RE.test(fileId)) {
    const refusal = new Error('invalid-id') as NodeJS.ErrnoException;
    refusal.code = 'EINVAL';
    throw refusal;
  }
  const root = path.resolve(storageDir, 'materials');
  const target = path.resolve(root, fileId);
  if (path.dirname(target) !== root || path.basename(target) !== fileId) {
    const refusal = new Error('invalid-id') as NodeJS.ErrnoException;
    refusal.code = 'EINVAL';
    throw refusal;
  }
  return target;
}

async function loadScope(client: PoolClient, kind: DeletionKind, id: string, lock: boolean): Promise<Scope | null> {
  if (kind === 'round') return loadRound(client, id, lock);
  if (kind === 'batch') return loadBatch(client, id, lock);
  if (kind === 'question') return loadQuestion(client, id, lock);
  if (kind === 'candidate') return loadCandidate(client, id, lock);
  return loadEnrollment(client, id, lock);
}

async function loadRound(client: PoolClient, id: string, lock: boolean): Promise<Scope | null> {
  if (lock && !(await lockRound(client, id))) return null;
  const target = await one<JsonRow>(client,
    `SELECT id::text, name, created_at FROM rounds WHERE id = $1`,
    [id],
  );
  if (!target) return null;
  const batches = await batchesByRound(client, id);
  const batchIds = batches.map((row) => String(row.id));
  const questions = await questionsByBatches(client, batchIds);
  const versions = await versionsByQuestions(client, questions.map((row) => String(row.id)));
  const enrollments = await enrollmentsWhere(client, 'e.round_id = $1', [id]);
  const enrollmentIds = enrollments.map((row) => String(row.id));
  const related = await relatedByEnrollments(client, enrollmentIds);
  const state = emptyState('round', {
    id: String(target.id),
    name: String(target.name),
    createdAt: stamp(target.created_at),
  });
  state.batches = batches.map(batchRow);
  state.questions = questions.map(questionRow);
  state.versions = versions.map(versionRow);
  state.enrollments = enrollments.map(enrollmentRow);
  Object.assign(state, related);
  const blocked = state.batches.length > 0 || state.questions.length > 0 || state.enrollments.length > 0;
  return finish(state, String(target.name), blocked
    ? '该轮次仍有批次或报名，请先移除这些子项后再删除轮次。'
    : null, blocked
    ? ['不会级联删除批次、题目或报名。', '请先删除子项后再删除轮次。']
    : ['将删除这个空轮次。', '此操作不可恢复。'], enrollmentIds);
}

async function loadBatch(client: PoolClient, id: string, lock: boolean): Promise<Scope | null> {
  if (lock && !(await lockBatch(client, id))) return null;
  const target = await one<Record<string, unknown>>(client,
    `SELECT id, round_id, name, description, status, opens_at, start_closes_at, created_at
     FROM batches WHERE id = $1`,
    [id],
  );
  if (!target) return null;
  const questions = await questionsByBatches(client, [id]);
  const versions = await versionsByQuestions(client, questions.map((row) => String(row.id)));
  const enrollments = await enrollmentsWhere(client, 'e.batch_id = $1', [id]);
  const enrollmentIds = enrollments.map((row) => String(row.id));
  const related = await relatedByEnrollments(client, enrollmentIds);
  const state = emptyState('batch', {
    id,
    roundId: String(target.round_id),
    name: String(target.name),
    description: String(target.description ?? ''),
    status: String(target.status),
    opensAt: stamp(target.opens_at),
    startClosesAt: stamp(target.start_closes_at),
    createdAt: stamp(target.created_at),
  });
  state.batches = [batchRow(target)];
  state.questions = questions.map(questionRow);
  state.versions = versions.map(versionRow);
  state.enrollments = enrollments.map(enrollmentRow);
  Object.assign(state, related);
  const blocked = state.questions.length > 0 || state.enrollments.length > 0;
  return finish(state, String(target.name), blocked
    ? '该批次仍有题目或报名，请先移除这些子项，或保留已关闭的批次。'
    : null, blocked
    ? ['不会级联删除题目或报名。', '请先移除子项，或保留已关闭的批次。']
    : ['将删除这个没有题目和报名的批次。', '此操作不可恢复。'], enrollmentIds);
}

async function loadQuestion(client: PoolClient, id: string, lock: boolean): Promise<Scope | null> {
  if (lock && !(await lockQuestion(client, id))) return null;
  const target = await one<Record<string, unknown>>(client,
    `SELECT id, batch_id, direction, title, published, updated_at, created_at FROM questions WHERE id = $1`,
    [id],
  );
  if (!target) return null;
  const versions = await versionsByQuestions(client, [id]);
  const versionIds = versions.map((row) => String(row.id));
  const enrollments = versionIds.length
    ? await enrollmentsWhere(client, 'e.question_version_id = ANY($1::uuid[])', [versionIds])
    : [];
  const state = emptyState('question', {
    id,
    batchId: String(target.batch_id),
    direction: String(target.direction),
    title: String(target.title),
    published: Boolean(target.published),
    updatedAt: stamp(target.updated_at),
    createdAt: stamp(target.created_at),
  });
  state.questions = [questionRow(target)];
  state.versions = versions.map(versionRow);
  state.enrollments = enrollments.map(enrollmentRow);
  const blocked = enrollments.length > 0;
  return finish(state, String(target.title), blocked
    ? '该题目已分配给报名，历史题目会保留。请取消发布而不是删除。'
    : null, blocked
    ? ['已用于考核的题目版本不会删除。', '请取消发布，而不是删除题目。']
    : ['将删除未被引用的题目、题目版本和题目附件关联。', '共享附件文件会保留。'], []);
}

async function loadCandidate(client: PoolClient, id: string, lock: boolean): Promise<Scope | null> {
  if (lock && !(await lockCandidate(client, id))) return null;
  const target = await one<Record<string, unknown>>(client,
    `SELECT id, role, name, student_no, email, created_at FROM users WHERE id = $1`,
    [id],
  );
  if (!target) return null;
  const enrollments = await enrollmentsWhere(client, 'e.user_id = $1', [id]);
  const enrollmentIds = enrollments.map((row) => String(row.id));
  const related = await relatedByEnrollments(client, enrollmentIds);
  const email = String(target.email);
  const sessions = await rows<Record<string, unknown>>(client,
    `SELECT id, expires_at FROM sessions WHERE user_id = $1 ORDER BY id`,
    [id],
  );
  const challenges = await rows<Record<string, unknown>>(client,
    `SELECT id, purpose, expires_at, consumed_at FROM email_challenges WHERE email = $1 ORDER BY id`,
    [email],
  );
  const notifications = await rows<Record<string, unknown>>(client,
    `SELECT id, status, attempts FROM email_outbox WHERE to_email = $1 ORDER BY id`,
    [email],
  );
  const state = emptyState('candidate', {
    id,
    role: String(target.role),
    name: String(target.name),
    studentNo: target.student_no == null ? null : String(target.student_no),
    email,
    createdAt: stamp(target.created_at),
  });
  state.enrollments = enrollments.map(enrollmentRow);
  Object.assign(state, related);
  state.sessions = sessions.map((row) => ({ id: String(row.id), expiresAt: stamp(row.expires_at) }));
  state.challenges = challenges.map((row) => ({
    id: String(row.id),
    purpose: String(row.purpose),
    expiresAt: stamp(row.expires_at),
    consumedAt: stamp(row.consumed_at),
  }));
  state.notifications = notifications.map((row) => ({
    id: String(row.id),
    status: String(row.status),
    attempts: Number(row.attempts),
  }));
  const blocked = String(target.role) !== 'CANDIDATE';
  return finish(state, String(target.name), blocked
    ? '不能删除管理员账号。'
    : null, blocked
    ? ['管理员账号受保护，直接调用删除服务也不会删除。']
    : [
      '删除该考生账号及其全部轮次中的报名、仓库、材料、评分和交卷记录。',
      '账号登录与 Agent 连接立即失效，学号和邮箱可重新注册。',
      '待发送通知和未使用的验证码会被清除。',
      '已有审计记录会保留。',
    ], enrollmentIds);
}

async function loadEnrollment(client: PoolClient, id: string, lock: boolean): Promise<Scope | null> {
  if (lock && !(await lockEnrollmentRow(client, id))) return null;
  const enrollments = await enrollmentsWhere(client, 'e.id = $1', [id]);
  const target = enrollments[0];
  if (!target) return null;
  const related = await relatedByEnrollments(client, [id]);
  const label = await one<{ title: string }>(client,
    `SELECT u.name || ' · ' || r.name || ' / ' || b.name AS title
     FROM enrollments e
     JOIN users u ON u.id = e.user_id
     JOIN rounds r ON r.id = e.round_id
     JOIN batches b ON b.id = e.batch_id
     WHERE e.id = $1`,
    [id],
  );
  const state = emptyState('enrollment', enrollmentRow(target));
  state.enrollments = [enrollmentRow(target)];
  Object.assign(state, related);
  const notifications = await rows<Record<string, unknown>>(client,
    `SELECT id, status, attempts FROM email_outbox WHERE idempotency_key = $1 ORDER BY id`,
    [`publish:${id}`],
  );
  state.notifications = notifications.map((row) => ({
    id: String(row.id),
    status: String(row.status),
    attempts: Number(row.attempts),
  }));
  return finish(state, label?.title ?? id, null, [
    '将只删除这一次报名及其仓库、材料、评分、交卷、MCP 和 OAuth 记录。',
    '考生账号和其他轮次的报名会保留。',
    '删除后该考生可以重新报名本轮次。',
  ], [id]);
}

async function lockRound(client: PoolClient, id: string): Promise<boolean> {
  const round = await rows<{ id: string }>(client, `SELECT id FROM rounds WHERE id = $1 FOR UPDATE`, [id]);
  // Child foreign keys cannot be added while this parent is locked. Existing
  // children make deletion ineligible; there is no reason to lock active exams.
  return round.length > 0;
}

async function lockBatch(client: PoolClient, id: string): Promise<boolean> {
  const batch = await rows<{ id: string }>(client, `SELECT id FROM batches WHERE id = $1 FOR UPDATE`, [id]);
  return batch.length > 0;
}

async function lockQuestion(client: PoolClient, id: string): Promise<boolean> {
  const question = await rows<{ id: string }>(client, `SELECT id FROM questions WHERE id = $1 FOR UPDATE`, [id]);
  if (question.length === 0) return false;
  await client.query(`SELECT id FROM question_versions WHERE question_id = $1 ORDER BY id FOR UPDATE`, [id]);
  return true;
}

async function lockCandidate(client: PoolClient, id: string): Promise<boolean> {
  const user = await rows<{ id: string }>(client, `SELECT id FROM users WHERE id = $1 FOR UPDATE`, [id]);
  if (user.length === 0) return false;
  const enrollments = await rows<{ id: string }>(client,
    `SELECT id FROM enrollments WHERE user_id = $1 ORDER BY id FOR UPDATE`,
    [id],
  );
  await lockUploads(client, enrollments.map((row) => row.id));
  return true;
}

async function lockEnrollmentRow(client: PoolClient, id: string): Promise<boolean> {
  const enrollment = await rows<{ id: string }>(client, `SELECT id FROM enrollments WHERE id = $1 FOR UPDATE`, [id]);
  if (enrollment.length === 0) return false;
  await lockUploads(client, [id]);
  return true;
}

// Enrollment row locks are already held. Advisory locks match uploads.ts and are taken before upload row locks.
async function lockUploads(client: PoolClient, enrollmentIds: string[]): Promise<void> {
  if (enrollmentIds.length === 0) return;
  const uploads = await rows<{ id: string }>(client,
    `SELECT id FROM material_uploads WHERE enrollment_id = ANY($1::uuid[]) ORDER BY id`,
    [enrollmentIds],
  );
  const ids = uploads.map((row) => row.id).sort();
  for (const uploadId of ids) {
    const got = await client.query<{ ok: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok`,
      [`material-upload:${uploadId}`],
    );
    if (!got.rows[0]?.ok) throw new HttpError(409, '相关上传正在进行，请稍后重试', 'DELETION_BUSY');
  }
  if (ids.length > 0) {
    await client.query(`SELECT id FROM material_uploads WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`, [ids]);
  }
}

async function applyDeletion(client: PoolClient, scope: Scope): Promise<number> {
  const kind = scope.preview.kind;
  const id = scope.preview.id;
  if (kind === 'round') {
    const removed = await client.query(
      `DELETE FROM rounds WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM batches WHERE round_id = $1)
       AND NOT EXISTS (SELECT 1 FROM enrollments WHERE round_id = $1)
       AND NOT EXISTS (SELECT 1 FROM questions q JOIN batches b ON b.id = q.batch_id WHERE b.round_id = $1)`,
      [id],
    );
    if ((removed.rowCount ?? 0) !== 1) throw new HttpError(409, '预览已过期，请重新确认后再删除', 'PREVIEW_CHANGED');
    return 0;
  }
  if (kind === 'batch') {
    const removed = await client.query(
      `DELETE FROM batches WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM questions WHERE batch_id = $1)
       AND NOT EXISTS (SELECT 1 FROM enrollments WHERE batch_id = $1)`,
      [id],
    );
    if ((removed.rowCount ?? 0) !== 1) throw new HttpError(409, '预览已过期，请重新确认后再删除', 'PREVIEW_CHANGED');
    return 0;
  }
  if (kind === 'question') {
    const assigned = await client.query(
      `SELECT 1 FROM enrollments e
       JOIN question_versions v ON v.id = e.question_version_id
       WHERE v.question_id = $1
       LIMIT 1`,
      [id],
    );
    if ((assigned.rowCount ?? 0) > 0) throw new HttpError(409, '该题目已分配给报名，历史题目会保留。请取消发布而不是删除。', 'DELETION_BLOCKED');
    await client.query(`DELETE FROM question_attachments WHERE question_id = $1`, [id]);
    await client.query(`DELETE FROM question_versions WHERE question_id = $1`, [id]);
    const removed = await client.query(`DELETE FROM questions WHERE id = $1`, [id]);
    if ((removed.rowCount ?? 0) !== 1) throw new HttpError(409, '预览已过期，请重新确认后再删除', 'PREVIEW_CHANGED');
    return 0;
  }
  if (kind === 'candidate') {
    const user = await one<{ role: string; email: string }>(client, `SELECT role, email FROM users WHERE id = $1 FOR UPDATE`, [id]);
    if (!user || user.role !== 'CANDIDATE') throw new HttpError(409, '不能删除管理员账号。', 'DELETION_BLOCKED');
    const filesQueued = await deleteEnrollments(client, scope.enrollmentIds);
    const leftover = await rows<{ request_id: string }>(client, `SELECT request_id FROM oauth_codes WHERE user_id = $1`, [id]);
    await client.query(`DELETE FROM oauth_codes WHERE user_id = $1`, [id]);
    if (leftover.length > 0) {
      await client.query(
        `DELETE FROM oauth_requests r
         WHERE r.id = ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.request_id = r.id)`,
        [leftover.map((row) => row.request_id)],
      );
    }
    await client.query(`UPDATE attachments SET uploaded_by = NULL WHERE uploaded_by = $1`, [id]);
    await client.query(`DELETE FROM sessions WHERE user_id = $1`, [id]);
    await client.query(`DELETE FROM email_challenges WHERE email = $1`, [user.email]);
    await client.query(`DELETE FROM email_outbox WHERE to_email = $1 AND status IN ('PENDING', 'SENDING')`, [user.email]);
    const removed = await client.query(`DELETE FROM users WHERE id = $1 AND role = 'CANDIDATE'`, [id]);
    if ((removed.rowCount ?? 0) !== 1) throw new HttpError(409, '不能删除管理员账号。', 'DELETION_BLOCKED');
    return filesQueued;
  }
  return deleteEnrollments(client, [id]);
}

async function deleteEnrollments(client: PoolClient, enrollmentIds: string[]): Promise<number> {
  if (enrollmentIds.length === 0) return 0;
  const files = await rows<{ id: string }>(client,
    `SELECT f.id FROM material_upload_files f
     JOIN material_uploads u ON u.id = f.upload_id
     WHERE u.enrollment_id = ANY($1::uuid[])
     ORDER BY f.id`,
    [enrollmentIds],
  );
  const fileIds = files.map((row) => row.id);
  if (fileIds.length > 0) {
    await client.query(
      `INSERT INTO deleted_material_files (file_id)
       SELECT unnest($1::uuid[])
       ON CONFLICT (file_id) DO NOTHING`,
      [fileIds],
    );
  }
  const requests = await rows<{ request_id: string }>(client,
    `SELECT request_id FROM oauth_codes WHERE enrollment_id = ANY($1::uuid[])`,
    [enrollmentIds],
  );
  await client.query(
    `DELETE FROM oauth_access_tokens t
     USING oauth_grants g, mcp_tokens m
     WHERE t.grant_id = g.id AND g.mcp_token_id = m.id AND m.enrollment_id = ANY($1::uuid[])`,
    [enrollmentIds],
  );
  await client.query(
    `DELETE FROM oauth_refresh_tokens t
     USING oauth_grants g, mcp_tokens m
     WHERE t.grant_id = g.id AND g.mcp_token_id = m.id AND m.enrollment_id = ANY($1::uuid[])`,
    [enrollmentIds],
  );
  await client.query(
    `DELETE FROM oauth_grants g
     USING mcp_tokens m
     WHERE g.mcp_token_id = m.id AND m.enrollment_id = ANY($1::uuid[])`,
    [enrollmentIds],
  );
  await client.query(`DELETE FROM oauth_codes WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  const requestIds = requests.map((row) => row.request_id);
  if (requestIds.length > 0) {
    await client.query(
      `DELETE FROM oauth_requests r
       WHERE r.id = ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM oauth_codes c WHERE c.request_id = r.id)`,
      [requestIds],
    );
  }
  await client.query(`DELETE FROM finalize_receipts WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(`DELETE FROM reviews WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(`UPDATE enrollments SET repository_id = NULL WHERE id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(`DELETE FROM material_upload_files WHERE upload_id IN (
    SELECT id FROM material_uploads WHERE enrollment_id = ANY($1::uuid[])
  )`, [enrollmentIds]);
  await client.query(`DELETE FROM material_uploads WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(`DELETE FROM materials WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(`DELETE FROM material_approvals WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(`DELETE FROM repositories WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(`DELETE FROM repository_previews WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(`DELETE FROM mcp_tokens WHERE enrollment_id = ANY($1::uuid[])`, [enrollmentIds]);
  await client.query(
    `DELETE FROM email_outbox
     WHERE status IN ('PENDING', 'SENDING') AND idempotency_key = ANY($1::text[])`,
    [enrollmentIds.map((enrollmentId) => `publish:${enrollmentId}`)],
  );
  const removed = await client.query(`DELETE FROM enrollments WHERE id = ANY($1::uuid[])`, [enrollmentIds]);
  if ((removed.rowCount ?? 0) !== enrollmentIds.length) {
    throw new HttpError(409, '预览已过期，请重新确认后再删除', 'PREVIEW_CHANGED');
  }
  return fileIds.length;
}

function finish(
  state: DeletionState,
  title: string,
  reason: string | null,
  consequences: string[],
  enrollmentIds: string[],
): Scope {
  const files = state.files.map((row) => String(row.id));
  return {
    preview: {
      kind: state.kind,
      id: String(state.target.id),
      title,
      allowed: reason == null,
      reason,
      fingerprint: sha256Hex(canonicalJson(state)),
      counts: {
        batches: state.batches.length,
        questions: state.questions.length,
        enrollments: state.enrollments.length,
        materials: state.materials.length,
        files: files.length,
      },
      consequences,
    },
    fileIds: files,
    enrollmentIds,
  };
}

function emptyState(kind: DeletionKind, target: JsonRow): DeletionState {
  return {
    kind,
    target,
    batches: [],
    questions: [],
    versions: [],
    enrollments: [],
    materials: [],
    uploads: [],
    files: [],
    reviews: [],
    receipts: [],
    oauthCodes: [],
    oauthGrants: [],
    sessions: [],
    challenges: [],
    notifications: [],
  };
}

async function batchesByRound(client: PoolClient, roundId: string): Promise<Record<string, unknown>[]> {
  return rows(client,
    `SELECT id, round_id, name, description, status, opens_at, start_closes_at, created_at
     FROM batches WHERE round_id = $1 ORDER BY id`,
    [roundId],
  );
}

async function questionsByBatches(client: PoolClient, batchIds: string[]): Promise<Record<string, unknown>[]> {
  if (batchIds.length === 0) return [];
  return rows(client,
    `SELECT id, batch_id, direction, title, published, updated_at, created_at
     FROM questions WHERE batch_id = ANY($1::uuid[]) ORDER BY id`,
    [batchIds],
  );
}

async function versionsByQuestions(client: PoolClient, questionIds: string[]): Promise<Record<string, unknown>[]> {
  if (questionIds.length === 0) return [];
  return rows(client,
    `SELECT id, question_id, version_no, created_at
     FROM question_versions WHERE question_id = ANY($1::uuid[]) ORDER BY id`,
    [questionIds],
  );
}

async function enrollmentsWhere(client: PoolClient, where: string, params: unknown[]): Promise<Record<string, unknown>[]> {
  return rows(client,
    `SELECT e.id, e.user_id, e.round_id, e.batch_id, e.direction, e.updated_at, e.started_at, e.deadline,
            e.finalized_at, e.question_version_id, e.repository_id, e.consent_accepted_at, e.mcp_connected,
            e.direct_upload_consent_at
     FROM enrollments e
     WHERE ${where}
     ORDER BY e.id`,
    params,
  );
}

async function relatedByEnrollments(client: PoolClient, enrollmentIds: string[]): Promise<Pick<DeletionState, 'materials' | 'uploads' | 'files' | 'reviews' | 'receipts' | 'oauthCodes' | 'oauthGrants'>> {
  if (enrollmentIds.length === 0) {
    return { materials: [], uploads: [], files: [], reviews: [], receipts: [], oauthCodes: [], oauthGrants: [] };
  }
  const materials = await rows<Record<string, unknown>>(client,
    `SELECT id, enrollment_id, sha256, repo_sha, received_at, purged_at, invalidated_at, approval_id
     FROM materials WHERE enrollment_id = ANY($1::uuid[]) ORDER BY id`,
    [enrollmentIds],
  );
  const uploads = await rows<Record<string, unknown>>(client,
    `SELECT id, enrollment_id, status, material_id, total_bytes, expires_at, created_at
     FROM material_uploads WHERE enrollment_id = ANY($1::uuid[]) ORDER BY id`,
    [enrollmentIds],
  );
  const files = await rows<Record<string, unknown>>(client,
    `SELECT f.id, f.upload_id, f.sha256, f.size_bytes, f.received_bytes, f.deleted_at
     FROM material_upload_files f
     JOIN material_uploads u ON u.id = f.upload_id
     WHERE u.enrollment_id = ANY($1::uuid[])
     ORDER BY f.id`,
    [enrollmentIds],
  );
  const reviews = await rows<Record<string, unknown>>(client,
    `SELECT enrollment_id, score, published_at, updated_at FROM reviews WHERE enrollment_id = ANY($1::uuid[]) ORDER BY enrollment_id`,
    [enrollmentIds],
  );
  const receipts = await rows<Record<string, unknown>>(client,
    `SELECT id, enrollment_id, submitted_at FROM finalize_receipts WHERE enrollment_id = ANY($1::uuid[]) ORDER BY id`,
    [enrollmentIds],
  );
  const oauthCodes = await rows<Record<string, unknown>>(client,
    `SELECT request_id, enrollment_id, user_id, expires_at, used_at
     FROM oauth_codes WHERE enrollment_id = ANY($1::uuid[]) ORDER BY request_id`,
    [enrollmentIds],
  );
  const oauthGrants = await rows<Record<string, unknown>>(client,
    `SELECT g.id, g.mcp_token_id, g.revoked_at, g.created_at
     FROM oauth_grants g
     JOIN mcp_tokens m ON m.id = g.mcp_token_id
     WHERE m.enrollment_id = ANY($1::uuid[])
     ORDER BY g.id`,
    [enrollmentIds],
  );
  return {
    materials: materials.map((row) => ({
      id: String(row.id),
      enrollmentId: String(row.enrollment_id),
      sha256: String(row.sha256),
      repoSha: String(row.repo_sha),
      receivedAt: stamp(row.received_at),
      purgedAt: stamp(row.purged_at),
      invalidatedAt: stamp(row.invalidated_at),
      approvalId: row.approval_id == null ? null : String(row.approval_id),
    })),
    uploads: uploads.map((row) => ({
      id: String(row.id),
      enrollmentId: String(row.enrollment_id),
      status: String(row.status),
      materialId: row.material_id == null ? null : String(row.material_id),
      totalBytes: String(row.total_bytes),
      expiresAt: stamp(row.expires_at),
      createdAt: stamp(row.created_at),
    })),
    files: files.map((row) => ({
      id: String(row.id),
      uploadId: String(row.upload_id),
      sha256: String(row.sha256),
      sizeBytes: String(row.size_bytes),
      receivedBytes: String(row.received_bytes),
      deletedAt: stamp(row.deleted_at),
    })),
    reviews: reviews.map((row) => ({
      enrollmentId: String(row.enrollment_id),
      score: Number(row.score),
      publishedAt: stamp(row.published_at),
      updatedAt: stamp(row.updated_at),
    })),
    receipts: receipts.map((row) => ({
      id: String(row.id),
      enrollmentId: String(row.enrollment_id),
      submittedAt: stamp(row.submitted_at),
    })),
    oauthCodes: oauthCodes.map((row) => ({
      requestId: String(row.request_id),
      enrollmentId: String(row.enrollment_id),
      userId: String(row.user_id),
      expiresAt: stamp(row.expires_at),
      usedAt: stamp(row.used_at),
    })),
    oauthGrants: oauthGrants.map((row) => ({
      id: String(row.id),
      mcpTokenId: String(row.mcp_token_id),
      revokedAt: stamp(row.revoked_at),
      createdAt: stamp(row.created_at),
    })),
  };
}

function batchRow(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    roundId: String(row.round_id),
    name: String(row.name),
    description: String(row.description ?? ''),
    status: String(row.status),
    opensAt: stamp(row.opens_at),
    startClosesAt: stamp(row.start_closes_at),
    createdAt: stamp(row.created_at),
  };
}

function questionRow(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    batchId: String(row.batch_id),
    direction: String(row.direction),
    title: String(row.title),
    published: Boolean(row.published),
    updatedAt: stamp(row.updated_at),
    createdAt: stamp(row.created_at),
  };
}

function versionRow(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    questionId: String(row.question_id),
    versionNo: Number(row.version_no),
    createdAt: stamp(row.created_at),
  };
}

function enrollmentRow(row: Record<string, unknown>): JsonRow {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    roundId: String(row.round_id),
    batchId: String(row.batch_id),
    direction: String(row.direction),
    updatedAt: stamp(row.updated_at),
    startedAt: stamp(row.started_at),
    deadline: stamp(row.deadline),
    finalizedAt: stamp(row.finalized_at),
    questionVersionId: row.question_version_id == null ? null : String(row.question_version_id),
    repositoryId: row.repository_id == null ? null : String(row.repository_id),
    consentAcceptedAt: stamp(row.consent_accepted_at),
    mcpConnected: Boolean(row.mcp_connected),
    directUploadConsentAt: stamp(row.direct_upload_consent_at),
  };
}

function stamp(value: unknown): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

async function rows<T extends Record<string, unknown>>(client: PoolClient, sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await client.query<T>(sql, params);
  return result.rows;
}

async function one<T extends Record<string, unknown>>(client: PoolClient, sql: string, params: unknown[]): Promise<T | null> {
  const result = await rows<T>(client, sql, params);
  return result[0] ?? null;
}

function parseKind(value: string | string[] | undefined): DeletionKind {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 'round' || raw === 'batch' || raw === 'question' || raw === 'candidate' || raw === 'enrollment') return raw;
  throw new HttpError(400, '删除类型不正确', 'VALIDATION');
}

function isBusy(error: unknown): boolean {
  const code = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  return code === '55P03' || code === '40P01' || code === '57014';
}
