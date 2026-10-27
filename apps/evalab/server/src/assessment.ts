import { randomBytes, randomInt } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AppContext } from './context.js';
import type { PublicUser } from './auth.js';
import { insertAudit } from './audit.js';
import { assertCandidateCanStart } from './candidateRisk.js';
import { withTx } from './db.js';
import { HttpError } from './errors.js';
import { assertRateLimit, enqueueMail } from './rateLimit.js';
import { canonicalJson, safeEqualHex, sha256Hex } from './security.js';
import { CONSENT_VERSION } from './policy.js';
import {
  displayManifest,
  validatePrepareInput,
  validateSubmitPayload,
  type MaterialManifest,
  type MaterialPayload,
} from './materials.js';
import { dbNow, presentEnrollments, type Direction, type Enrollment } from './present.js';
import { parseRepositoryUrl, selectRepoFetcher } from './repoPreview.js';

export type { Enrollment, Direction, MaterialManifest, MaterialPayload };
export type McpIdentity = { userId: string; enrollmentId: string; oauthOrigins?: string[]; mcpTokenId?: string };

type LockedEnrollment = {
  id: string;
  user_id: string;
  round_id: string;
  batch_id: string;
  direction: Direction;
  consent_version: string | null;
  consent_accepted_at: Date | null;
  mcp_connected: boolean;
  started_at: Date | null;
  deadline: Date | null;
  finalized_at: Date | null;
  question_version_id: string | null;
  repository_id: string | null;
  batch_status: string;
  opens_at: Date;
  start_closes_at: Date;
  duration_hours: number;
  expired: boolean;
  window_closed: boolean;
};

async function lockEnrollment(client: PoolClient, id: string): Promise<LockedEnrollment | null> {
  const result = await client.query<Omit<LockedEnrollment, 'expired' | 'window_closed'>>(
    `SELECT e.id, e.user_id, e.round_id, e.batch_id, e.direction, e.consent_version, e.consent_accepted_at,
            e.mcp_connected, e.started_at, e.deadline, e.finalized_at, e.question_version_id, e.repository_id,
            b.status AS batch_status, b.opens_at, b.start_closes_at, b.duration_hours
     FROM enrollments e
     JOIN batches b ON b.id = e.batch_id
     WHERE e.id = $1
     FOR UPDATE OF e`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const clock = await client.query<{ expired: boolean; window_closed: boolean }>(
    `SELECT (e.deadline IS NOT NULL AND e.deadline <= clock_timestamp()) AS expired,
            (b.start_closes_at <= clock_timestamp()) AS window_closed
     FROM enrollments e
     JOIN batches b ON b.id = e.batch_id
     WHERE e.id = $1`,
    [id],
  );
  return {
    ...row,
    expired: clock.rows[0]?.expired ?? false,
    window_closed: clock.rows[0]?.window_closed ?? false,
  };
}

function assertOwner(row: { user_id: string } | null, userId: string): asserts row is LockedEnrollment {
  if (!row || row.user_id !== userId) throw new HttpError(404, '未找到', 'NOT_FOUND');
}

function assertActive(row: LockedEnrollment): void {
  if (row.finalized_at) throw new HttpError(409, '考核已交卷，不能再修改', 'FINALIZED');
  if (!row.started_at) throw new HttpError(409, '考核尚未开始', 'NOT_STARTED');
  if (row.expired) throw new HttpError(409, '考核已截止', 'DEADLINE');
}

async function viewOf(client: PoolClient | AppContext['pool'], id: string, audience: 'candidate' | 'admin') {
  const map = await presentEnrollments(client, [id], audience);
  const enrollment = map.get(id);
  if (!enrollment) throw new HttpError(404, '未找到', 'NOT_FOUND');
  const now = await dbNow(client);
  return { enrollment, serverNow: now.toISOString() };
}

export async function listBatches(ctx: AppContext, userId?: string): Promise<{ rounds: unknown[]; serverNow: string }> {
  const batches = await ctx.pool.query<{
    id: string; round_id: string; round_name: string; name: string; description: string;
    opens_at: Date; start_closes_at: Date; duration_hours: number; status: string;
  }>(
    `SELECT b.id, b.round_id, r.name AS round_name, b.name, b.description, b.opens_at, b.start_closes_at,
            b.duration_hours, b.status
     FROM batches b JOIN rounds r ON r.id = b.round_id
     WHERE b.status <> 'DRAFT'
        OR ($1::uuid IS NOT NULL AND EXISTS (
          SELECT 1 FROM enrollments enrolled WHERE enrolled.batch_id = b.id AND enrolled.user_id = $1
        ))
     ORDER BY r.created_at, b.opens_at, b.id`,
    [userId ?? null],
  );
  const counts = await ctx.pool.query<{ batch_id: string; direction: Direction; n: number }>(
    `SELECT batch_id, direction, count(*)::int AS n FROM questions WHERE published = true GROUP BY batch_id, direction`,
  );
  const countMap = new Map<string, { PRODUCT: number; DEVELOPMENT_TEST: number }>();
  for (const row of counts.rows) {
    const current = countMap.get(row.batch_id) ?? { PRODUCT: 0, DEVELOPMENT_TEST: 0 };
    current[row.direction] = row.n;
    countMap.set(row.batch_id, current);
  }
  let enrollmentByBatch = new Map<string, Enrollment>();
  if (userId) {
    const enrolled = await ctx.pool.query<{ id: string; batch_id: string }>(
      'SELECT id, batch_id FROM enrollments WHERE user_id = $1',
      [userId],
    );
    const presented = await presentEnrollments(ctx.pool, enrolled.rows.map((row) => row.id), 'candidate');
    enrollmentByBatch = new Map(enrolled.rows.flatMap((row) => {
      const enrollment = presented.get(row.id);
      return enrollment ? [[row.batch_id, enrollment] as const] : [];
    }));
  }
  const rounds = new Map<string, { id: string; name: string; batches: unknown[] }>();
  for (const batch of batches.rows) {
    const round = rounds.get(batch.round_id) ?? { id: batch.round_id, name: batch.round_name, batches: [] };
    const enrollment = enrollmentByBatch.get(batch.id);
    round.batches.push({
      id: batch.id,
      name: batch.name,
      description: batch.description,
      status: batch.status,
      opensAt: new Date(batch.opens_at).toISOString(),
      startClosesAt: new Date(batch.start_closes_at).toISOString(),
      durationHours: batch.duration_hours,
      directions: ['PRODUCT', 'DEVELOPMENT_TEST'],
      directionCounts: countMap.get(batch.id) ?? { PRODUCT: 0, DEVELOPMENT_TEST: 0 },
      ...(enrollment ? { enrollment } : {}),
    });
    rounds.set(batch.round_id, round);
  }
  return { rounds: [...rounds.values()], serverNow: (await dbNow(ctx.pool)).toISOString() };
}

export async function listOwnEnrollments(ctx: AppContext, userId: string): Promise<{ enrollments: Enrollment[]; serverNow: string }> {
  const rows = await ctx.pool.query<{ id: string }>(
    `SELECT e.id
     FROM enrollments e
     JOIN batches b ON b.id = e.batch_id
     WHERE e.user_id = $1
     ORDER BY e.created_at DESC, e.id`,
    [userId],
  );
  const presented = await presentEnrollments(ctx.pool, rows.rows.map((row) => row.id), 'candidate');
  return {
    enrollments: rows.rows.flatMap((row) => {
      const enrollment = presented.get(row.id);
      return enrollment ? [enrollment] : [];
    }),
    serverNow: (await dbNow(ctx.pool)).toISOString(),
  };
}

export async function createEnrollment(ctx: AppContext, userId: string, batchId: string, direction: Direction): Promise<Enrollment> {
  return withTx(ctx.pool, async (client) => {
    const batch = await client.query<{ id: string; round_id: string; enrollable: boolean }>(
      `SELECT id, round_id,
              (status = 'OPEN' AND clock_timestamp() < start_closes_at) AS enrollable
       FROM batches WHERE id = $1 FOR SHARE`,
      [batchId],
    );
    const row = batch.rows[0];
    if (!row || !row.enrollable) throw new HttpError(409, '该批次当前不能报名', 'WINDOW_CLOSED');
    const existing = await client.query<{ id: string }>(
      'SELECT id FROM enrollments WHERE user_id = $1 AND round_id = $2',
      [userId, row.round_id],
    );
    if (existing.rows[0]) throw new HttpError(409, '本轮已选择批次，请修改原报名', 'ALREADY_ENROLLED');
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO enrollments (user_id, round_id, batch_id, direction)
       SELECT $1, b.round_id, b.id, $2
       FROM batches b
       WHERE b.id = $3 AND b.status = 'OPEN' AND clock_timestamp() < b.start_closes_at
       RETURNING id`,
      [userId, direction, batchId],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new HttpError(409, '该批次当前不能报名', 'WINDOW_CLOSED');
    return (await viewOf(client, id, 'candidate')).enrollment;
  });
}

export async function updateEnrollment(
  ctx: AppContext,
  userId: string,
  enrollmentId: string,
  patch: { batchId?: string; direction?: Direction },
): Promise<Enrollment> {
  return withTx(ctx.pool, async (client) => {
    const row = await lockEnrollment(client, enrollmentId);
    assertOwner(row, userId);
    if (row.started_at) throw new HttpError(409, '考核开始后不能修改批次或方向', 'CONFLICT');
    const batchId = patch.batchId ?? row.batch_id;
    const direction = patch.direction ?? row.direction;
    const batch = await client.query<{ round_id: string; enrollable: boolean }>(
      `SELECT round_id, (status = 'OPEN' AND clock_timestamp() < start_closes_at) AS enrollable
       FROM batches WHERE id = $1 FOR SHARE`,
      [batchId],
    );
    const next = batch.rows[0];
    if (!next || !next.enrollable || next.round_id !== row.round_id) {
      throw new HttpError(409, '只能在本轮未截止的开放批次中修改', 'WINDOW_CLOSED');
    }
    const saved = await client.query<{ id: string }>(
      `UPDATE enrollments e
       SET batch_id = b.id, direction = $3, updated_at = clock_timestamp()
       FROM batches b
       WHERE e.id = $1 AND b.id = $2 AND b.round_id = e.round_id
         AND b.status = 'OPEN' AND clock_timestamp() < b.start_closes_at
       RETURNING e.id`,
      [enrollmentId, batchId, direction],
    );
    if (!saved.rows[0]) throw new HttpError(409, '只能在本轮未截止的开放批次中修改', 'WINDOW_CLOSED');
    return (await viewOf(client, enrollmentId, 'candidate')).enrollment;
  });
}

export async function getEnrollmentForActor(ctx: AppContext, actor: PublicUser, enrollmentId: string) {
  const found = await ctx.pool.query<{ user_id: string }>('SELECT user_id FROM enrollments WHERE id = $1', [enrollmentId]);
  const row = found.rows[0];
  if (!row || (row.user_id !== actor.id && actor.role !== 'ADMIN')) throw new HttpError(404, '未找到', 'NOT_FOUND');
  return viewOf(ctx.pool, enrollmentId, actor.role === 'ADMIN' ? 'admin' : 'candidate');
}

export async function acceptConsent(ctx: AppContext, userId: string, enrollmentId: string, direct = false): Promise<Enrollment> {
  return withTx(ctx.pool, async (client) => {
    const row = await lockEnrollment(client, enrollmentId);
    assertOwner(row, userId);
    if (row.finalized_at) throw new HttpError(409, '考核已交卷', 'FINALIZED');
    await client.query(
      `UPDATE enrollments SET consent_version = $2, consent_accepted_at = coalesce(consent_accepted_at, now()),
           direct_upload_consent_at = CASE WHEN $3 THEN coalesce(direct_upload_consent_at, now()) ELSE direct_upload_consent_at END, updated_at = now()
       WHERE id = $1`,
      [enrollmentId, CONSENT_VERSION, direct],
    );
    await insertAudit(client, { actorId: userId, actorName: 'candidate', action: 'CONSENT', enrollmentId, details: { version: direct ? 'assessment-materials-v2' : CONSENT_VERSION } });
    return (await viewOf(client, enrollmentId, 'candidate')).enrollment;
  });
}

export async function issueMcpToken(ctx: AppContext, userId: string, enrollmentId: string): Promise<{ token: string; mcpUrl: string; expiresAt: string }> {
  return withTx(ctx.pool, async (client) => {
    const row = await lockEnrollment(client, enrollmentId);
    assertOwner(row, userId);
    if (row.finalized_at) throw new HttpError(409, '考核已交卷', 'FINALIZED');
    if (row.started_at && row.expired) throw new HttpError(409, '考核已截止', 'DEADLINE');
    if (!row.started_at && row.window_closed) throw new HttpError(409, '考核窗口已关闭', 'WINDOW_CLOSED');
    const raw = `lab_${randomBytes(32).toString('base64url')}`;
    await client.query(
      `UPDATE mcp_tokens SET revoked_at = now() WHERE enrollment_id = $1 AND revoked_at IS NULL`,
      [enrollmentId],
    );
    if (!row.started_at) await client.query('UPDATE enrollments SET mcp_connected = false WHERE id = $1', [enrollmentId]);
    const expires = row.deadline ?? row.start_closes_at;
    await client.query(
      `INSERT INTO mcp_tokens (enrollment_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [enrollmentId, sha256Hex(raw), expires],
    );
    const user = await client.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [userId]);
    await insertAudit(client, {
      actorId: userId,
      actorName: user.rows[0]?.name ?? 'candidate',
      action: 'MCP_TOKEN_ROTATE',
      enrollmentId,
    });
    return {
      token: raw,
      mcpUrl: `${ctx.config.publicBaseUrl.replace(/\/$/, '')}/mcp`,
      expiresAt: new Date(expires).toISOString(),
    };
  });
}

export async function startExam(
  ctx: AppContext,
  userId: string,
  enrollmentId: string,
  expectedDurationHours?: number,
): Promise<{ enrollment: Enrollment; serverNow: string }> {
  return withTx(ctx.pool, async (client) => {
    // Match candidate deletion: user, enrollment, then batch. Restriction and start serialize on the user.
    await client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
    const row = await lockEnrollment(client, enrollmentId);
    assertOwner(row, userId);
    if (row.started_at) return viewOf(client, enrollmentId, 'candidate');
    await assertCandidateCanStart(client, userId);
    if (row.consent_version !== CONSENT_VERSION || !row.consent_accepted_at) {
      throw new HttpError(409, '请先阅读并同意考核同意书', 'CONSENT_REQUIRED');
    }
    if (!row.mcp_connected) throw new HttpError(409, '请先测试 MCP 连接', 'MCP_REQUIRED');
    const lockedBatch = await client.query<{ duration_hours: number; can_start: boolean }>(
      `SELECT b.duration_hours,
              (b.status = 'OPEN' AND assessment_start_window_open(b.opens_at, b.start_closes_at, stamp.stamp_at)) AS can_start
       FROM batches b
       CROSS JOIN (SELECT clock_timestamp() AS stamp_at) stamp
       WHERE b.id = $1
       FOR UPDATE OF b`,
      [row.batch_id],
    );
    const batch = lockedBatch.rows[0];
    if (!batch?.can_start) throw new HttpError(409, '当前不在可开始时间内', 'WINDOW_CLOSED');
    if (expectedDurationHours != null && expectedDurationHours !== batch.duration_hours) {
      throw new HttpError(409, '批次时长已变更，请刷新后确认', 'DURATION_CHANGED');
    }
    // The batch lock serializes starts across processes. This separate statement
    // sees prior committed assignments after a lock wait (READ COMMITTED).
    // Count people across all snapshots of a question, not its version count;
    // finished and expired attempts still participated, unstarted enrollments did not.
    const poolRows = await client.query<{ id: string; participants: number }>(
      `SELECT q.id, count(e.id)::int AS participants
       FROM questions q
       LEFT JOIN question_versions v ON v.question_id = q.id
       LEFT JOIN enrollments e ON e.question_version_id = v.id
         AND e.started_at IS NOT NULL AND e.batch_id = $1 AND e.direction = $2
       WHERE q.batch_id = $1 AND q.direction = $2 AND q.published = true
       GROUP BY q.id
       ORDER BY participants, q.id`,
      [row.batch_id, row.direction],
    );
    if (poolRows.rows.length === 0) throw new HttpError(409, '该方向暂无可用题目', 'EMPTY_POOL');
    const leastUsed = poolRows.rows.filter(item => item.participants === poolRows.rows[0]!.participants);
    const picked = leastUsed[randomInt(leastUsed.length)];
    if (!picked) throw new HttpError(409, '该方向暂无可用题目', 'EMPTY_POOL');
    const question = await client.query<{ id: string; title: string; content: string; published: boolean }>(
      'SELECT id, title, content, published FROM questions WHERE id = $1 AND batch_id = $2 AND direction = $3 FOR UPDATE',
      [picked.id, row.batch_id, row.direction],
    );
    const current = question.rows[0];
    if (!current?.published) throw new HttpError(409, '该方向暂无可用题目', 'EMPTY_POOL');
    const attachments = await client.query<{ attachment_id: string }>(
      'SELECT attachment_id FROM question_attachments WHERE question_id = $1 ORDER BY position, attachment_id',
      [current.id],
    );
    const version = await client.query<{ id: string }>(
      `INSERT INTO question_versions (question_id, version_no, title, content, attachment_ids)
       VALUES ($1, (SELECT coalesce(max(version_no), 0) + 1 FROM question_versions WHERE question_id = $1), $2, $3, $4::uuid[])
       RETURNING id`,
      [current.id, current.title, current.content, attachments.rows.map((item) => item.attachment_id)],
    );
    const versionId = version.rows[0]?.id;
    if (!versionId) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
    const started = await client.query<{ started_at: Date }>(
      `UPDATE enrollments e
       SET started_at = stamp.started,
           deadline = stamp.started + ($2::int * interval '1 hour'),
           duration_hours = $2::int,
           question_version_id = $3::uuid,
           updated_at = stamp.started
       FROM (SELECT clock_timestamp() AS started) stamp
       JOIN batches b ON b.id = $4::uuid
       WHERE e.id = $1::uuid
         AND e.started_at IS NULL
         AND b.status = 'OPEN'
         AND assessment_start_window_open(b.opens_at, b.start_closes_at, stamp.started)
       RETURNING e.started_at`,
      [enrollmentId, batch.duration_hours, versionId, row.batch_id],
    );
    if (!started.rows[0]) throw new HttpError(409, '当前不在可开始时间内', 'WINDOW_CLOSED');
    await client.query(
      `UPDATE mcp_tokens SET expires_at = (SELECT deadline FROM enrollments WHERE id = $1)
       WHERE enrollment_id = $1 AND revoked_at IS NULL`,
      [enrollmentId],
    );
    const user = await client.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [userId]);
    await insertAudit(client, {
      actorId: userId,
      actorName: user.rows[0]?.name ?? 'candidate',
      action: 'START',
      enrollmentId,
      details: { questionVersionId: versionId, durationHours: batch.duration_hours },
    });
    return viewOf(client, enrollmentId, 'candidate');
  });
}

export async function previewRepository(ctx: AppContext, userId: string, enrollmentId: string, url: string, branch?: string) {
  const row = await ctx.pool.query<{ user_id: string; finalized_at: Date | null; started_at: Date | null; expired: boolean }>(
    `SELECT user_id, finalized_at, started_at, (deadline IS NOT NULL AND deadline <= clock_timestamp()) AS expired
     FROM enrollments WHERE id = $1`,
    [enrollmentId],
  );
  const current = row.rows[0];
  if (!current || current.user_id !== userId) throw new HttpError(404, '未找到', 'NOT_FOUND');
  if (current.finalized_at) throw new HttpError(409, '考核已交卷', 'FINALIZED');
  if (!current.started_at) throw new HttpError(409, '考核尚未开始', 'NOT_STARTED');
  if (current.expired) throw new HttpError(409, '考核已截止', 'DEADLINE');
  await assertRateLimit(ctx, ctx.pool, 'repo-preview-user', userId, 30, 600);
  parseRepositoryUrl(url, branch);
  const meta = await selectRepoFetcher(ctx)({ url, ...(branch ? { branch } : {}) });
  if (!/^[0-9a-f]{40}$/.test(meta.sha) && !/^[0-9a-f]{64}$/.test(meta.sha)) {
    throw new HttpError(502, '代码托管平台返回的提交不完整', 'REPO_PROVIDER');
  }
  const inserted = await ctx.pool.query<{ id: string; expires_at: Date }>(
    `INSERT INTO repository_previews (enrollment_id, user_id, url, branch, sha, message, author, committed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '10 minutes')
     RETURNING id, expires_at`,
    [enrollmentId, userId, meta.url, meta.branch, meta.sha, meta.message, meta.author, meta.committedAt],
  );
  const preview = inserted.rows[0];
  if (!preview) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
  return {
    preview: {
      id: preview.id,
      url: meta.url,
      branch: meta.branch,
      sha: meta.sha,
      message: meta.message,
      author: meta.author,
      committedAt: meta.committedAt,
      expiresAt: new Date(preview.expires_at).toISOString(),
    },
  };
}

export async function confirmRepository(ctx: AppContext, userId: string, enrollmentId: string, previewId: string): Promise<Enrollment> {
  return withTx(ctx.pool, async (client) => {
    const row = await lockEnrollment(client, enrollmentId);
    assertOwner(row, userId);
    assertActive(row);
    const preview = await client.query<{
      url: string; branch: string; sha: string; message: string; author: string; committed_at: Date; expired: boolean;
    }>(
      `SELECT url, branch, sha, message, author, committed_at, (expires_at <= now()) AS expired
       FROM repository_previews WHERE id = $1 AND enrollment_id = $2 AND user_id = $3`,
      [previewId, enrollmentId, userId],
    );
    const item = preview.rows[0];
    if (!item) throw new HttpError(404, '预览不存在', 'NOT_FOUND');
    if (item.expired) throw new HttpError(409, '仓库预览已过期，请重新获取', 'PREVIEW_EXPIRED');
    const current = row.repository_id
      ? await client.query<{ id: string; sha: string }>('SELECT id, sha FROM repositories WHERE id = $1', [row.repository_id])
      : { rows: [] as Array<{ id: string; sha: string }> };
    const same = current.rows[0];
    if (same && same.sha === item.sha) {
      await client.query(
        `UPDATE repositories SET preview_id = $2, url = $3, branch = $4, message = $5, author = $6, committed_at = $7, confirmed_at = now()
         WHERE id = $1`,
        [same.id, previewId, item.url, item.branch, item.message, item.author, item.committed_at],
      );
    } else {
      if (same) await client.query('UPDATE repositories SET superseded_at = now() WHERE id = $1', [same.id]);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO repositories (enrollment_id, preview_id, url, branch, sha, message, author, committed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [enrollmentId, previewId, item.url, item.branch, item.sha, item.message, item.author, item.committed_at],
      );
      const repositoryId = inserted.rows[0]?.id;
      if (!repositoryId) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
      await client.query('UPDATE enrollments SET repository_id = $2, updated_at = now() WHERE id = $1', [enrollmentId, repositoryId]);
      await client.query(
        `UPDATE material_approvals SET state = 'SUPERSEDED'
         WHERE enrollment_id = $1 AND state IN ('PENDING', 'APPROVED') AND repo_sha <> $2`,
        [enrollmentId, item.sha],
      );
      await client.query(
        `UPDATE material_uploads SET status='SUPERSEDED' WHERE enrollment_id=$1 AND status IN ('AWAITING_FILES','UPLOADING') AND repo_sha<>$2`,
        [enrollmentId, item.sha],
      );
      await client.query(
        `UPDATE materials SET invalidated_at = now()
         WHERE enrollment_id = $1 AND invalidated_at IS NULL AND repo_sha <> $2`,
        [enrollmentId, item.sha],
      );
    }
    const user = await client.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [userId]);
    await insertAudit(client, {
      actorId: userId,
      actorName: user.rows[0]?.name ?? 'candidate',
      action: 'REPO_CONFIRM',
      enrollmentId,
      details: { sha: item.sha, previewId },
    });
    return (await viewOf(client, enrollmentId, 'candidate')).enrollment;
  });
}

export async function approveMaterials(ctx: AppContext, userId: string, enrollmentId: string, approvalId: string): Promise<{ ok: true }> {
  return withTx(ctx.pool, async (client) => {
    const row = await lockEnrollment(client, enrollmentId);
    assertOwner(row, userId);
    assertActive(row);
    const approval = await client.query<{ state: string; expired: boolean }>(
      `SELECT state, (expires_at <= now()) AS expired FROM material_approvals
       WHERE id = $1 AND enrollment_id = $2 FOR UPDATE`,
      [approvalId, enrollmentId],
    );
    const item = approval.rows[0];
    if (!item) throw new HttpError(404, '未找到待确认的材料摘要', 'NOT_FOUND');
    if (item.state === 'APPROVED') return { ok: true as const };
    if (item.state !== 'PENDING' || item.expired) {
      if (item.expired && item.state === 'PENDING') {
        await client.query(`UPDATE material_approvals SET state = 'EXPIRED' WHERE id = $1`, [approvalId]);
      }
      throw new HttpError(409, '材料摘要已失效', 'DIGEST_REJECTED');
    }
    await client.query(
      `UPDATE material_approvals SET state = 'APPROVED', approved_at = now() WHERE id = $1`,
      [approvalId],
    );
    const user = await client.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [userId]);
    await insertAudit(client, {
      actorId: userId,
      actorName: user.rows[0]?.name ?? 'candidate',
      action: 'APPROVE_MATERIALS',
      enrollmentId,
      details: { approvalId },
    });
    return { ok: true as const };
  });
}

export async function readMaterials(ctx: AppContext, actor: PublicUser, enrollmentId: string) {
  if (actor.role !== 'ADMIN') throw new HttpError(403, '仅管理员可查看材料', 'FORBIDDEN');
  const owner = await ctx.pool.query<{ user_id: string }>('SELECT user_id FROM enrollments WHERE id = $1', [enrollmentId]);
  const who = owner.rows[0];
  if (!who) throw new HttpError(404, '未找到', 'NOT_FOUND');
  const found = await ctx.pool.query<{
    id: string; sha256: string; repo_sha: string; payload: MaterialPayload | null; received_at: Date;
    purged_at: Date | null; invalidated_at: Date | null;
  }>(
    `SELECT id, sha256, repo_sha, payload, received_at, purged_at, invalidated_at
     FROM materials WHERE enrollment_id = $1 ORDER BY received_at DESC LIMIT 1`,
    [enrollmentId],
  );
  const row = found.rows[0];
  if (!row) throw new HttpError(404, '尚未提交材料', 'NOT_FOUND');
  const stored = row.payload as unknown as {schemaVersion:number;files:Array<{id?:string;name:string}>} | null;
  const payload = row.purged_at ? purgedPayload(row.payload, row.repo_sha)
    : stored?.schemaVersion === 2 ? {...row.payload, files:stored.files.map(file=>({...file,downloadUrl:`/api/enrollments/${enrollmentId}/materials/files/${file.id}`}))} : row.payload;
  return {
    payload,
    receipt: {
      id: row.id,
      sha256: row.sha256,
      repoSha: row.repo_sha,
      receivedAt: new Date(row.received_at).toISOString(),
    },
    bound: !row.invalidated_at && !row.purged_at,
    purged: Boolean(row.purged_at),
  };
}

export async function finalizeExam(
  ctx: AppContext,
  userId: string,
  enrollmentId: string,
  repositoryId: string,
  materialsId: string,
): Promise<{ enrollment: Enrollment; receipt: { id: string; submittedAt: string; sha: string; materialsHash: string } }> {
  return withTx(ctx.pool, async (client) => {
    const row = await lockEnrollment(client, enrollmentId);
    assertOwner(row, userId);
    const existing = await client.query<{ id: string; repository_id: string; materials_id: string; sha: string; materials_hash: string; submitted_at: Date }>(
      'SELECT id, repository_id, materials_id, sha, materials_hash, submitted_at FROM finalize_receipts WHERE enrollment_id = $1',
      [enrollmentId],
    );
    const prior = existing.rows[0];
    if (row.finalized_at || prior) {
      if (prior && prior.repository_id === repositoryId && prior.materials_id === materialsId) {
        const viewed = await viewOf(client, enrollmentId, 'candidate');
        return { enrollment: viewed.enrollment, receipt: receiptOf(prior) };
      }
      throw new HttpError(409, '考核已交卷', 'FINALIZED');
    }
    assertActive(row);
    if (row.repository_id !== repositoryId) throw new HttpError(409, '请确认当前锁定的仓库版本', 'REPO_MISMATCH');
    const repo = await client.query<{ sha: string }>('SELECT sha FROM repositories WHERE id = $1 AND enrollment_id = $2 AND superseded_at IS NULL', [repositoryId, enrollmentId]);
    const materials = await client.query<{ sha256: string; repo_sha: string; invalidated_at: Date | null }>(
      'SELECT sha256, repo_sha, invalidated_at FROM materials WHERE id = $1 AND enrollment_id = $2',
      [materialsId, enrollmentId],
    );
    const repoRow = repo.rows[0];
    const materialRow = materials.rows[0];
    if (!repoRow || !materialRow || materialRow.invalidated_at || repoRow.sha !== materialRow.repo_sha) {
      throw new HttpError(409, '仓库 SHA 与 MCP 材料不一致', 'REPO_MISMATCH');
    }
    const inserted = await client.query<{ id: string; submitted_at: Date; sha: string; materials_hash: string; repository_id: string; materials_id: string }>(
      `INSERT INTO finalize_receipts (enrollment_id, repository_id, materials_id, sha, materials_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, submitted_at, sha, materials_hash, repository_id, materials_id`,
      [enrollmentId, repositoryId, materialsId, repoRow.sha, materialRow.sha256],
    );
    const receipt = inserted.rows[0];
    if (!receipt) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
    await client.query('UPDATE enrollments SET finalized_at = now(), updated_at = now() WHERE id = $1', [enrollmentId]);
    await client.query("UPDATE material_uploads SET status='SUPERSEDED' WHERE enrollment_id=$1 AND status IN ('AWAITING_FILES','UPLOADING')", [enrollmentId]);
    const user = await client.query<{ name: string }>('SELECT name FROM users WHERE id = $1', [userId]);
    await insertAudit(client, {
      actorId: userId,
      actorName: user.rows[0]?.name ?? 'candidate',
      action: 'FINALIZE',
      enrollmentId,
      details: { sha: repoRow.sha },
    });
    const viewed = await viewOf(client, enrollmentId, 'candidate');
    return { enrollment: viewed.enrollment, receipt: receiptOf(receipt) };
  });
}

export async function authenticateMcp(ctx: AppContext, rawToken: string): Promise<McpIdentity> {
  if (!rawToken || rawToken.length < 20 || rawToken.length > 200) {
    throw new HttpError(401, 'MCP 令牌无效', 'UNAUTHENTICATED');
  }
  const result = await ctx.pool.query<{ mcp_token_id: string; user_id: string; enrollment_id: string; finalized_at: Date | null; started_at: Date | null; expired: boolean; window_closed: boolean; grant_id: string | null; metadata: { redirect_uris: string[] } | null }>(
    `SELECT t.id AS mcp_token_id, e.user_id, t.enrollment_id, e.finalized_at, e.started_at, g.id AS grant_id, oc.metadata,
            (e.deadline IS NOT NULL AND e.deadline <= clock_timestamp()) AS expired,
            (b.start_closes_at <= clock_timestamp()) AS window_closed
     FROM mcp_tokens t
     JOIN enrollments e ON e.id = t.enrollment_id
     JOIN batches b ON b.id = e.batch_id
     LEFT JOIN oauth_grants g ON g.mcp_token_id=t.id
     LEFT JOIN oauth_clients oc ON oc.client_id=g.client_id
     WHERE t.revoked_at IS NULL AND t.expires_at > clock_timestamp() AND
       ((g.id IS NULL AND t.token_hash=$1) OR
        (g.revoked_at IS NULL AND g.resource=$2 AND EXISTS(SELECT 1 FROM oauth_access_tokens a
          WHERE a.grant_id=g.id AND a.token_hash=$1 AND a.expires_at>clock_timestamp())))`,
    [sha256Hex(rawToken), `${ctx.config.publicBaseUrl}/mcp`],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(401, 'MCP 令牌无效', 'UNAUTHENTICATED');
  if (row.finalized_at) throw new HttpError(401, '考核已交卷', 'FINALIZED');
  if (row.started_at && row.expired) throw new HttpError(401, '考核已截止', 'DEADLINE');
  if (!row.started_at && row.window_closed) throw new HttpError(401, '考核窗口已关闭', 'WINDOW_CLOSED');
  if (row.grant_id) await ctx.pool.query("UPDATE oauth_grants SET last_used_at=clock_timestamp() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<clock_timestamp()-interval '1 minute')", [row.grant_id]);
  return { userId: row.user_id, enrollmentId: row.enrollment_id, mcpTokenId: row.mcp_token_id, ...(row.metadata ? { oauthOrigins: row.metadata.redirect_uris.map((uri) => new URL(uri).origin) } : {}) };
}

async function requireIdentity(ctx: AppContext, identity: McpIdentity): Promise<void> {
  const result = await ctx.pool.query<{ user_id: string }>('SELECT user_id FROM enrollments WHERE id = $1', [identity.enrollmentId]);
  if (result.rows[0]?.user_id !== identity.userId) throw new HttpError(401, 'MCP 令牌无效', 'UNAUTHENTICATED');
}

export async function getMcpStatus(ctx: AppContext, identity: McpIdentity): Promise<{ enrollment: Enrollment; serverNow: string }> {
  await requireIdentity(ctx, identity);
  return viewOf(ctx.pool, identity.enrollmentId, 'candidate');
}

export async function probeMcp(ctx: AppContext, identity: McpIdentity): Promise<{ ok: true; enrollmentId: string; serverNow: string; mcpConnected: true }> {
  await requireIdentity(ctx, identity);
  await ctx.pool.query('UPDATE enrollments SET mcp_connected = true, updated_at = now() WHERE id = $1 AND user_id = $2', [
    identity.enrollmentId,
    identity.userId,
  ]);
  return {
    ok: true,
    enrollmentId: identity.enrollmentId,
    serverNow: (await dbNow(ctx.pool)).toISOString(),
    mcpConnected: true,
  };
}

export async function prepareMcpMaterials(
  ctx: AppContext,
  identity: McpIdentity,
  input: { manifest: MaterialManifest; payloadHash: string; repoSha: string },
): Promise<{ approvalId: string; approvalUrl: string; expiresAt: string }> {
  const prepared = validatePrepareInput(input);
  await assertRateLimit(ctx, ctx.pool, 'materials-prepare-user', identity.userId, 20, 600);
  return withTx(ctx.pool, async (client) => {
    const row = await lockEnrollment(client, identity.enrollmentId);
    if (!row || row.user_id !== identity.userId) throw new HttpError(401, 'MCP 令牌无效', 'UNAUTHENTICATED');
    assertActive(row);
    if (row.repository_id) {
      const repo = await client.query<{ sha: string }>('SELECT sha FROM repositories WHERE id = $1', [row.repository_id]);
      if (repo.rows[0] && repo.rows[0].sha !== prepared.repoSha) {
        throw new HttpError(409, '材料 SHA 与已确认的仓库不一致', 'REPO_MISMATCH');
      }
    }
    const recent = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM material_approvals
       WHERE enrollment_id = $1 AND created_at > clock_timestamp() - interval '1 hour'`,
      [identity.enrollmentId],
    );
    if ((recent.rows[0]?.n ?? 0) >= 30) {
      throw new HttpError(429, '材料确认次数过多，请稍后再试', 'RATE_LIMITED');
    }
    await client.query(
      `UPDATE material_approvals SET state = 'SUPERSEDED'
       WHERE enrollment_id = $1 AND state IN ('PENDING', 'APPROVED')`,
      [identity.enrollmentId],
    );
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO material_approvals (enrollment_id, manifest, payload_hash, repo_sha, state, expires_at)
       VALUES ($1, $2::jsonb, $3, $4, 'PENDING', now() + interval '30 minutes')
       RETURNING id, expires_at`,
      [identity.enrollmentId, JSON.stringify(prepared.manifest), prepared.payloadHash, prepared.repoSha],
    );
    const approval = inserted.rows[0];
    if (!approval) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
    return {
      approvalId: approval.id,
      approvalUrl: `${ctx.config.appOrigin}/recruitment/exam/${identity.enrollmentId}?approval=${approval.id}`,
      expiresAt: new Date(approval.expires_at).toISOString(),
    };
  });
}

export async function submitMcpMaterials(
  ctx: AppContext,
  identity: McpIdentity,
  input: { approvalId: string; payload: MaterialPayload },
): Promise<{ receipt: { id: string; sha256: string; repoSha: string; receivedAt: string }; status: string }> {
  const checked = validateSubmitPayload(input.payload);
  return withTx(ctx.pool, async (client) => {
    const row = await lockEnrollment(client, identity.enrollmentId);
    if (!row || row.user_id !== identity.userId) throw new HttpError(401, 'MCP 令牌无效', 'UNAUTHENTICATED');
    const approval = await client.query<{ state: string; payload_hash: string; repo_sha: string; manifest: unknown; expired: boolean }>(
      `SELECT state, payload_hash, repo_sha, manifest, (expires_at <= now()) AS expired
       FROM material_approvals WHERE id = $1 AND enrollment_id = $2 FOR UPDATE`,
      [input.approvalId, identity.enrollmentId],
    );
    const item = approval.rows[0];
    if (!item) throw new HttpError(404, '材料摘要不存在', 'NOT_FOUND');
    const existing = await client.query<{ id: string; sha256: string; repo_sha: string; received_at: Date }>(
      'SELECT id, sha256, repo_sha, received_at FROM materials WHERE approval_id = $1',
      [input.approvalId],
    );
    const prior = existing.rows[0];
    if (prior) {
      if (safeEqualHex(prior.sha256, checked.sha256)) {
        return { receipt: { id: prior.id, sha256: prior.sha256, repoSha: prior.repo_sha, receivedAt: new Date(prior.received_at).toISOString() }, status: 'received' };
      }
      throw new HttpError(409, '该摘要已用于不同内容', 'DIGEST_REJECTED');
    }
    assertActive(row);
    if (item.state !== 'APPROVED' || item.expired) {
      throw new HttpError(409, '材料尚未在网站确认或摘要已失效', 'APPROVAL_REQUIRED');
    }
    if (!safeEqualHex(item.payload_hash, checked.sha256) || item.repo_sha !== checked.payload.repoSha) {
      throw new HttpError(409, '材料摘要与提交内容不一致', 'DIGEST_REJECTED');
    }
    if (canonicalJson(item.manifest) !== canonicalJson(checked.payload.manifest)) {
      throw new HttpError(409, '材料清单与已确认摘要不一致', 'DIGEST_REJECTED');
    }
    const inserted = await client.query<{ id: string; received_at: Date }>(
      `INSERT INTO materials (enrollment_id, approval_id, sha256, repo_sha, payload, client_count, file_count, coverage)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id, received_at`,
      [identity.enrollmentId, input.approvalId, checked.sha256, checked.payload.repoSha, JSON.stringify(checked.payload), checked.clientCount, checked.fileCount, checked.coverage],
    );
    const saved = inserted.rows[0];
    if (!saved) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
    await client.query(`UPDATE material_approvals SET state = 'USED' WHERE id = $1`, [input.approvalId]);
    await client.query(
      `UPDATE materials SET invalidated_at = now() WHERE enrollment_id = $1 AND id <> $2 AND invalidated_at IS NULL`,
      [identity.enrollmentId, saved.id],
    );
    return {
      receipt: {
        id: saved.id,
        sha256: checked.sha256,
        repoSha: checked.payload.repoSha,
        receivedAt: new Date(saved.received_at).toISOString(),
      },
      status: 'received',
    };
  });
}

function receiptOf(row: { id: string; submitted_at: Date; sha: string; materials_hash: string }) {
  return {
    id: row.id,
    submittedAt: new Date(row.submitted_at).toISOString(),
    sha: row.sha,
    materialsHash: row.materials_hash,
  };
}

function purgedPayload(payload: MaterialPayload | null, repoSha: string) {
  const manifest = payload?.manifest;
  return {
    schemaVersion: 1 as const,
    repoSha,
    purged: true,
    manifest: manifest
      ? { ...manifest, projectSummary: '', collaborationSummary: '' }
      : { files: [], clients: [], projectSummary: '', collaborationSummary: '' },
    files: (payload?.files ?? []).map((file) => ({ name: file.name, content: '' })),
  };
}
