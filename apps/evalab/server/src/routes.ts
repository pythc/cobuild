import { registerAdminDeletion } from './adminDeletion.js';
import { issueRegistrationChallenge } from './registrationProtection.js';
import { registerCandidateRisk } from './candidateRisk.js';
import { Router } from 'express';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { parseBody, requestEmailCode, registerAccount, loginAccount, resetPassword, logoutAccount } from './auth.js';
import {
  acceptConsent,
  approveMaterials,
  confirmRepository,
  createEnrollment,
  finalizeExam,
  getEnrollmentForActor,
  issueMcpToken,
  listBatches,
  listOwnEnrollments,
  previewRepository,
  readMaterials,
  startExam,
  updateEnrollment,
} from './assessment.js';
import {
  adminEnrollment,
  batchPatchSchema,
  batchSchema,
  createBatch,
  createQuestion,
  createRound,
  exportCsv,
  extendDeadline,
  listAdminBatches,
  listAudit,
  listCandidates,
  listQuestions,
  listRounds,
  overview,
  publishReview,
  questionPatchSchema,
  questionSchema,
  saveReview,
  updateBatch,
  updateQuestion,
} from './admin.js';
import { downloadMaterialFile } from './uploads.js';
import { CONSENT_TEXT, DIRECT_UPLOAD_VERSION } from './policy.js';
import { openAttachment, readMultipartFile, saveAttachment } from './files.js';
import { asyncHandler, clearSession, requireAdmin, requireUser, routeId, sendSession } from './http.js';
import { HttpError } from './errors.js';

const direction = z.enum(['PRODUCT', 'DEVELOPMENT_TEST']);

export function apiRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/health', asyncHandler(async (_req, res) => {
    try {
      await ctx.pool.query('SELECT 1');
      res.json({ status: 'ok', database: 'ok' });
    } catch {
      res.status(503).json({ message: '数据库不可用', code: 'DB_UNAVAILABLE' });
    }
  }));

  router.get('/consent-policy', (_req, res) => {
    res.json({ version: DIRECT_UPLOAD_VERSION, text: CONSENT_TEXT });
  });

  router.post('/auth/email-code', asyncHandler(async (req, res) => {
    res.json(await requestEmailCode(ctx, req));
  }));
  router.get('/auth/registration-challenge', asyncHandler(async (req, res) => {
    res.json(await issueRegistrationChallenge(ctx, req, res));
  }));
  router.post('/auth/register', asyncHandler(async (req, res) => {
    const result = await registerAccount(ctx, req);
    sendSession(res, ctx, result.sessionId, req);
    res.json({ user: result.user, csrfToken: result.csrfToken });
  }));
  router.post('/auth/login', asyncHandler(async (req, res) => {
    const result = await loginAccount(ctx, req);
    sendSession(res, ctx, result.sessionId, req);
    res.json({ user: result.user, csrfToken: result.csrfToken });
  }));
  router.get('/auth/me', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    res.json({ user: auth.user, csrfToken: auth.csrfToken });
  }));
  router.post('/auth/logout', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    await logoutAccount(ctx, auth);
    clearSession(res, ctx, req);
    res.json({ ok: true });
  }));
  router.post('/auth/reset-password', asyncHandler(async (req, res) => {
    res.json(await resetPassword(ctx, req));
  }));

  router.get('/batches', asyncHandler(async (req, res) => {
    res.json(await listBatches(ctx, req.auth?.user.id));
  }));

  router.get('/enrollments', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    res.json(await listOwnEnrollments(ctx, auth.user.id));
  }));
  router.post('/enrollments', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    const body = parseBody(z.object({ batchId: z.string().uuid(), direction }).strict(), req.body);
    res.json({ enrollment: await createEnrollment(ctx, auth.user.id, body.batchId, body.direction) });
  }));
  router.patch('/enrollments/:id', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    const body = parseBody(z.object({ batchId: z.string().uuid().optional(), direction: direction.optional() }).strict(), req.body);
    res.json({ enrollment: await updateEnrollment(ctx, auth.user.id, routeId(req.params.id), body) });
  }));
  router.get('/enrollments/:id', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    res.json(await getEnrollmentForActor(ctx, auth.user, routeId(req.params.id)));
  }));
  router.post('/enrollments/:id/consent', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    const body = parseBody(z.object({ version: z.enum(['assessment-consent-v1', 'assessment-materials-v2']), accepted: z.literal(true) }).strict(), req.body);
    res.json({ enrollment: await acceptConsent(ctx, auth.user.id, routeId(req.params.id), body.version === 'assessment-materials-v2') });
  }));
  router.post('/enrollments/:id/mcp-token', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(await issueMcpToken(ctx, auth.user.id, routeId(req.params.id)));
  }));
  router.post('/enrollments/:id/start', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    const body = parseBody(z.object({ confirmed: z.literal(true), expectedDurationHours: z.union([z.literal(24), z.literal(48)]) }).strict(), req.body);
    res.json(await startExam(ctx, auth.user.id, routeId(req.params.id), body.expectedDurationHours));
  }));
  router.post('/enrollments/:id/repository/preview', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    const body = parseBody(z.object({ url: z.string().trim().min(8).max(500), branch: z.string().trim().max(200).optional() }).strict(), req.body);
    res.json(await previewRepository(ctx, auth.user.id, routeId(req.params.id), body.url, body.branch));
  }));
  router.post('/enrollments/:id/repository/confirm', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    const body = parseBody(z.object({ previewId: z.string().uuid() }).strict(), req.body);
    res.json({ enrollment: await confirmRepository(ctx, auth.user.id, routeId(req.params.id), body.previewId) });
  }));
  router.post('/enrollments/:id/approvals/:approvalId/approve', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    parseBody(z.object({ approved: z.literal(true) }).strict(), req.body);
    res.json(await approveMaterials(ctx, auth.user.id, routeId(req.params.id), routeId(req.params.approvalId)));
  }));
  router.get('/enrollments/:id/materials/files/:fileId', asyncHandler(async (req, res, next) => {
    await downloadMaterialFile(ctx, requireAdmin(req).user, routeId(req.params.id), routeId(req.params.fileId), res, next);
  }));
  router.get('/enrollments/:id/materials', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    res.json(await readMaterials(ctx, auth.user, routeId(req.params.id)));
  }));
  router.post('/enrollments/:id/finalize', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    const body = parseBody(z.object({
      repositoryId: z.string().uuid(),
      materialsId: z.string().uuid(),
      confirmed: z.literal(true),
    }).strict(), req.body);
    res.json(await finalizeExam(ctx, auth.user.id, routeId(req.params.id), body.repositoryId, body.materialsId));
  }));

  router.get('/attachments/:id', asyncHandler(async (req, res) => {
    const auth = requireUser(req);
    const file = await openAttachment(ctx, auth.user, routeId(req.params.id));
    const ascii = file.name.replace(/[^\w.\- ()]+/g, '_').slice(0, 80) || 'attachment';
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    file.stream.on('error', () => {
      if (!res.headersSent) res.status(404).json({ message: '未找到', code: 'NOT_FOUND' });
      else res.destroy();
    });
    file.stream.pipe(res);
  }));

  router.get('/admin/overview', asyncHandler(async (req, res) => {
    requireAdmin(req);
    res.json(await overview(ctx));
  }));
  router.get('/admin/rounds', asyncHandler(async (req, res) => {
    requireAdmin(req);
    res.json(await listRounds(ctx));
  }));
  router.post('/admin/rounds', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const body = parseBody(z.object({ name: z.string().trim().min(1).max(80) }).strict(), req.body);
    res.json(await createRound(ctx, auth.user, body.name));
  }));
  router.get('/admin/batches', asyncHandler(async (req, res) => {
    requireAdmin(req);
    res.json(await listAdminBatches(ctx));
  }));
  router.post('/admin/batches', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const body = parseBody(batchSchema, req.body);
    res.json(await createBatch(ctx, auth.user, { ...body, description: body.description ?? '' }));
  }));
  router.patch('/admin/batches/:id', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    res.json(await updateBatch(ctx, auth.user, routeId(req.params.id), parseBody(batchPatchSchema, req.body)));
  }));
  router.get('/admin/questions', asyncHandler(async (req, res) => {
    requireAdmin(req);
    const batchId = typeof req.query.batchId === 'string' && req.query.batchId ? routeId(req.query.batchId) : undefined;
    res.json(await listQuestions(ctx, batchId));
  }));
  router.post('/admin/questions', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const body = parseBody(questionSchema, req.body);
    const created = await createQuestion(ctx, auth.user, { ...body, attachmentIds: body.attachmentIds ?? [] });
    if (!created.question) throw new HttpError(500, '服务器内部错误', 'INTERNAL');
    res.json({ question: created.question });
  }));
  router.patch('/admin/questions/:id', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    res.json(await updateQuestion(ctx, auth.user, routeId(req.params.id), parseBody(questionPatchSchema, req.body)));
  }));
  router.post('/admin/attachments', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const file = await readMultipartFile(req);
    res.json({ attachment: await saveAttachment(ctx, auth.user.id, file) });
  }));
  router.get('/admin/candidates', asyncHandler(async (req, res) => {
    requireAdmin(req);
    const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 80) : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const batchId = typeof req.query.batchId === 'string' && req.query.batchId ? routeId(req.query.batchId) : undefined;
    const offset = Math.min(10000, Math.max(0, Number(req.query.offset ?? 0) || 0));
    if (state && !['READY', 'ACTIVE', 'FINALIZED', 'EXPIRED'].includes(state)) {
      throw new HttpError(400, '请求参数不正确', 'VALIDATION');
    }
    const risk = req.query.risk;
    if (risk !== undefined && risk !== 'PENDING' && risk !== 'RESTRICTED') throw new HttpError(400, '请求参数不正确', 'VALIDATION');
    res.json(await listCandidates(ctx, { search, state, batchId, offset, risk }));
  }));
  router.get('/admin/enrollments/:id', asyncHandler(async (req, res) => {
    requireAdmin(req);
    res.json(await adminEnrollment(ctx, routeId(req.params.id)));
  }));
  router.post('/admin/enrollments/:id/extend', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const body = parseBody(z.object({ minutes: z.number().int().min(1).max(10080), reason: z.string().min(1).max(500) }).strict(), req.body);
    res.json(await extendDeadline(ctx, auth.user, routeId(req.params.id), body.minutes, body.reason));
  }));
  router.post('/admin/enrollments/:id/review', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const body = parseBody(z.object({ score: z.number().int().min(0).max(100), feedback: z.string().trim().min(1).max(5000) }).strict(), req.body);
    res.json(await saveReview(ctx, auth.user, routeId(req.params.id), body.score, body.feedback));
  }));
  router.post('/admin/enrollments/:id/publish', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    parseBody(z.object({}).strict(), req.body ?? {});
    res.json(await publishReview(ctx, auth.user, routeId(req.params.id)));
  }));
  router.get('/admin/export', asyncHandler(async (req, res) => {
    const auth = requireAdmin(req);
    const csv = await exportCsv(ctx, auth.user);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="candidates.csv"');
    res.send(csv);
  }));
  router.get('/admin/audit', asyncHandler(async (req, res) => {
    requireAdmin(req);
    res.json(await listAudit(ctx));
  }));

  registerAdminDeletion(router, ctx);
  registerCandidateRisk(router, ctx);
  return router;
}
