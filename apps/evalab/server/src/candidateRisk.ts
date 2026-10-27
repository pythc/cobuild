import { createHmac } from 'node:crypto';
import type { Request, Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { insertAudit } from './audit.js';
import { withTx } from './db.js';
import { HttpError } from './errors.js';
import { usesEmbeddingSession } from './embedding.js';
import { asyncHandler, requireAdmin, routeId } from './http.js';
import {
  readSignupBrowserId,
  registrationBrowserHash,
  registrationIpHash,
} from './registrationProtection.js';

const BROWSER_FLAG = 'BROWSER_3_ACCOUNTS_DAY';
const IP_FLAG = 'IP_30_ACCOUNTS_DAY';
const UUID_LIST = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const patchSchema = z.object({
  action: z.enum(['RESTRICT_START', 'ALLOW_START', 'CLEAR_FLAG']),
  reason: z.string().trim().min(1).max(500).refine((value) => !/[\u0000-\u001f]/.test(value)),
}).strict();

export type RegistrationRiskView = {
  userId: string;
  reasons: string[];
  reviewState: 'PENDING' | 'CLEARED';
  startRestricted: boolean;
  restrictionReason: string | null;
};

type RiskRow = {
  user_id: string;
  risk_reasons: unknown;
  review_state: 'PENDING' | 'CLEARED';
  start_restricted: boolean;
  restriction_reason: string | null;
};

function clientIp(req: Request): string {
  return (req.ip || req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '').slice(0, 64);
}

function manualHash(sessionSecret: string, userId: string): string {
  return createHmac('sha256', sessionSecret).update(`registration-manual-v1\n${userId}`).digest('hex');
}

function asReasons(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string' && item.length <= 80);
}

function toView(row: RiskRow): RegistrationRiskView {
  return {
    userId: row.user_id,
    reasons: asReasons(row.risk_reasons),
    reviewState: row.review_state,
    startRestricted: row.start_restricted,
    restrictionReason: row.restriction_reason,
  };
}

function clearedView(userId: string): RegistrationRiskView {
  return {
    userId,
    reasons: [],
    reviewState: 'CLEARED',
    startRestricted: false,
    restrictionReason: null,
  };
}

export async function recordRegistrationRisk(
  client: PoolClient,
  ctx: AppContext,
  userId: string,
  req: Request,
): Promise<void> {
  const secret = ctx.config.sessionSecret;
  const ipHash = registrationIpHash(secret, clientIp(req));
  const browserId = readSignupBrowserId(secret, req, usesEmbeddingSession(ctx.config, req));
  const browserHash = browserId
    ? registrationBrowserHash(secret, browserId)
    : createHmac('sha256', secret).update(`registration-browser-missing-v1\n${userId}`).digest('hex');
  const locks = [`b:${browserHash}`, `i:${ipHash}`].sort();
  for (const key of locks) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [key]);
  }
  const browserCount = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM user_registration_risk
     WHERE browser_hash = $1 AND created_at > clock_timestamp() - interval '1 day'`,
    [browserHash],
  );
  const ipCount = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM user_registration_risk
     WHERE ip_hash = $1 AND created_at > clock_timestamp() - interval '1 day'`,
    [ipHash],
  );
  const reasons: string[] = [];
  if ((browserCount.rows[0]?.n ?? 0) + 1 >= 3) reasons.push(BROWSER_FLAG);
  if ((ipCount.rows[0]?.n ?? 0) + 1 >= 30) reasons.push(IP_FLAG);
  await client.query(
    `INSERT INTO user_registration_risk
       (user_id, ip_hash, browser_hash, risk_reasons, review_state, start_restricted)
     VALUES ($1, $2, $3, $4::jsonb, $5, false)`,
    [userId, ipHash, browserHash, JSON.stringify(reasons), reasons.length > 0 ? 'PENDING' : 'CLEARED'],
  );
}

/**
 * Call inside the same transaction as a new exam start, after the caller has
 * locked the user, then enrollment, and observed started_at IS NULL. Already-started exams
 * must return without calling this. Locks the user row, then the risk row.
 */
export async function assertCandidateCanStart(client: PoolClient, userId: string): Promise<void> {
  const user = await client.query('SELECT id FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId]);
  if ((user.rowCount ?? 0) === 0) throw new HttpError(404, '未找到', 'NOT_FOUND');
  const risk = await client.query<{ start_restricted: boolean }>(
    `SELECT start_restricted FROM user_registration_risk WHERE user_id = $1 FOR UPDATE`,
    [userId],
  );
  if (risk.rows[0]?.start_restricted) {
    throw new HttpError(403, '当前账号暂不可开始考核', 'START_RESTRICTED');
  }
}

export function registerCandidateRisk(router: Router, ctx: AppContext): void {
  router.get('/admin/registration-risk', asyncHandler(async (req, res) => {
    requireAdmin(req);
    res.json({ risks: await listRegistrationRisk(ctx, req.query.ids) });
  }));

  router.patch('/admin/candidates/:id/registration-risk', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const id = routeId(req.params.id);
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw new HttpError(400, '请求参数不正确', 'VALIDATION');
    const risk = await reviewRegistrationRisk(ctx, { id: auth.user.id, name: auth.user.name }, id, parsed.data.action, parsed.data.reason);
    res.json({ risk });
  }));
}

async function listRegistrationRisk(ctx: AppContext, raw: unknown): Promise<RegistrationRiskView[]> {
  if (typeof raw !== 'string' || raw.length > 4000) throw new HttpError(400, '请求参数不正确', 'VALIDATION');
  const ids = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length) {
    throw new HttpError(400, '请求参数不正确', 'VALIDATION');
  }
  if (ids.some((id) => !UUID_LIST.test(id))) throw new HttpError(400, '请求参数不正确', 'VALIDATION');
  const found = await ctx.pool.query<RiskRow>(
    `SELECT u.id AS user_id,
            COALESCE(r.risk_reasons, '[]'::jsonb) AS risk_reasons,
            COALESCE(r.review_state, 'CLEARED') AS review_state,
            COALESCE(r.start_restricted, false) AS start_restricted,
            r.restriction_reason
     FROM users u
     LEFT JOIN user_registration_risk r ON r.user_id = u.id
     WHERE u.role = 'CANDIDATE' AND u.id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(found.rows.map((row) => [row.user_id, toView(row)]));
  return ids.filter((id) => byId.has(id)).map((id) => byId.get(id) ?? clearedView(id));
}

async function reviewRegistrationRisk(
  ctx: AppContext,
  actor: { id: string; name: string },
  userId: string,
  action: 'RESTRICT_START' | 'ALLOW_START' | 'CLEAR_FLAG',
  reason: string,
): Promise<RegistrationRiskView> {
  return withTx(ctx.pool, async (client) => {
    const user = await client.query<{ role: 'CANDIDATE' | 'ADMIN'; name: string }>(
      `SELECT role, name FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    const target = user.rows[0];
    if (!target) throw new HttpError(404, '未找到', 'NOT_FOUND');
    if (target.role === 'ADMIN') throw new HttpError(403, '不能对管理员执行该操作', 'FORBIDDEN');
    const existing = await client.query<RiskRow>(
      `SELECT user_id, risk_reasons, review_state, start_restricted, restriction_reason
       FROM user_registration_risk WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const current = existing.rows[0];
    if (action === 'RESTRICT_START') {
      if (current) {
        await client.query(
          `UPDATE user_registration_risk
           SET start_restricted = true,
               restriction_reason = $2,
               restricted_at = CASE WHEN start_restricted THEN restricted_at ELSE clock_timestamp() END,
               reviewed_at = clock_timestamp()
           WHERE user_id = $1`,
          [userId, reason],
        );
      } else {
        const hash = manualHash(ctx.config.sessionSecret, userId);
        await client.query(
          `INSERT INTO user_registration_risk
             (user_id, ip_hash, browser_hash, risk_reasons, review_state, start_restricted, restriction_reason, restricted_at, reviewed_at)
           VALUES ($1, $2, $2, '[]'::jsonb, 'CLEARED', true, $3, clock_timestamp(), clock_timestamp())`,
          [userId, hash, reason],
        );
      }
    } else if (action === 'ALLOW_START') {
      if (current?.start_restricted) {
        await client.query(
          `UPDATE user_registration_risk
           SET start_restricted = false, restriction_reason = NULL, restricted_at = NULL, reviewed_at = clock_timestamp()
           WHERE user_id = $1`,
          [userId],
        );
      }
    } else if (current && (current.review_state !== 'CLEARED' || asReasons(current.risk_reasons).length > 0)) {
      await client.query(
        `UPDATE user_registration_risk
         SET review_state = 'CLEARED', risk_reasons = '[]'::jsonb, reviewed_at = clock_timestamp()
         WHERE user_id = $1`,
        [userId],
      );
    }
    await insertAudit(client, {
      actorId: actor.id,
      actorName: actor.name,
      action: action === 'RESTRICT_START'
        ? 'REGISTRATION_RESTRICT_START'
        : action === 'ALLOW_START'
          ? 'REGISTRATION_ALLOW_START'
          : 'REGISTRATION_CLEAR_FLAG',
      details: { targetUserId: userId, action, reason },
    });
    const next = await client.query<RiskRow>(
      `SELECT user_id, risk_reasons, review_state, start_restricted, restriction_reason
       FROM user_registration_risk WHERE user_id = $1`,
      [userId],
    );
    return next.rows[0] ? toView(next.rows[0]) : clearedView(userId);
  });
}
