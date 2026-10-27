import express, { type Express } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AppContext } from './context.js';
import { loadSession } from './auth.js';
import { asyncHandler, readCookie } from './http.js';
import { HttpError } from './errors.js';
import { safeEqualString, sha256Hex } from './security.js';
import { withTx } from './db.js';
import { assertRateLimit } from './rateLimit.js';

export type IdentityClient = { id: string; secret: string; redirectUri: string };
export function identityClients(env: NodeJS.ProcessEnv): IdentityClient[] {
  if (!env.PUBLIC_IDENTITY_CLIENTS) return [];
  const clients = z.array(z.object({ id: z.string().regex(/^[a-z0-9_-]{1,64}$/), secret: z.string().min(32), redirectUri: z.string().url() }).strict()).max(10).parse(JSON.parse(env.PUBLIC_IDENTITY_CLIENTS));
  if (new Set(clients.map(c => c.id)).size !== clients.length) throw new Error('Duplicate identity client');
  for (const c of clients) {
    const u = new URL(c.redirectUri);
    if (u.username || u.password || u.hash || u.search || (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)))) throw new Error('Invalid identity callback');
  }
  return clients;
}
const authorizeInput = z.object({ client_id: z.string(), redirect_uri: z.string(), state: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), code_challenge_method: z.literal('S256'), prompt: z.literal('login').optional() }).strict();
const tokenInput = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{43}$/), redirect_uri: z.string(), code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/) }).strict();

/** Disabled unless explicitly configured; unrelated to candidate MCP OAuth. */
export function registerPublicIdentity(app: Express, ctx: AppContext, clients = identityClients(process.env)): void {
  if (!clients.length) return;
  const root = '/api/public-identity';
  app.use(root, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.get(`${root}/authorize`, asyncHandler(async (req, res) => {
    const parsed = authorizeInput.safeParse(req.query);
    if (!parsed.success) throw new HttpError(400, '账号连接参数不正确', 'IDENTITY_REQUEST');
    const p = parsed.data;
    const client = clients.find(c => c.id === p.client_id && c.redirectUri === p.redirect_uri);
    if (!client) throw new HttpError(400, '账号回调地址未登记', 'IDENTITY_CLIENT');
    const sessionId = readCookie(req, 'lab_session') || '';
    const auth = z.string().uuid().safeParse(sessionId).success ? await loadSession(ctx, sessionId) : null;
    if (!auth || p.prompt === 'login') {
      const params = new URLSearchParams(Object.entries(p).filter(([key, value]) => key !== 'prompt' && typeof value === 'string') as [string, string][]);
      res.redirect(`/login?${p.prompt === 'login' ? 'switch=1&' : ''}redirect=${encodeURIComponent(root + '/authorize?' + params)}`);
      return;
    }
    await assertRateLimit(ctx, ctx.pool, 'identity-authorize', auth.user.id, 60, 600);
    await ctx.pool.query('DELETE FROM public_identity_codes WHERE expires_at<now()');
    await ctx.pool.query('DELETE FROM public_identity_tokens WHERE expires_at<now()');
    const code = randomBytes(32).toString('base64url');
    await ctx.pool.query(`INSERT INTO public_identity_codes(code_hash,client_id,redirect_uri,challenge,session_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '60 seconds')`, [sha256Hex(code), client.id, client.redirectUri, p.code_challenge, auth.sessionId]);
    const target = new URL(client.redirectUri);
    target.searchParams.set('code', code); target.searchParams.set('state', p.state);
    res.redirect(target.href);
  }));
  // Back-channel endpoints authenticate the configured confidential client. No
  // browser cookies, arbitrary origins, exam scopes, or dynamic registration.
  app.use(root, express.json({ limit: '8kb' }), (req, _res, next) => {
    const client = clients.find(c => safeEqualString(req.header('x-identity-client') || '', c.id) && safeEqualString(req.header('x-identity-secret') || '', c.secret));
    if (!client) return next(new HttpError(401, '应用认证失败', 'IDENTITY_CLIENT'));
    if (req.header('origin')) return next(new HttpError(403, '仅允许服务端连接', 'IDENTITY_ORIGIN'));
    resClient.set(req, client); next();
  });
  app.post(`${root}/token`, asyncHandler(async (req, res) => {
    const parsed = tokenInput.safeParse(req.body);
    if (!parsed.success) throw new HttpError(400, '连接参数不正确', 'IDENTITY_REQUEST');
    const p = parsed.data, client = resClient.get(req)!;
    const verifier = createHash('sha256').update(p.code_verifier).digest('base64url');
    const token = randomBytes(32).toString('base64url');
    const result = await withTx(ctx.pool, async db => {
      const code = (await db.query(`SELECT c.* FROM public_identity_codes c JOIN sessions s ON s.id=c.session_id WHERE c.code_hash=$1 AND c.expires_at>now() AND s.expires_at>now() FOR UPDATE OF c`, [sha256Hex(p.code)])).rows[0];
      if (!code || code.client_id !== client.id || code.redirect_uri !== client.redirectUri || p.redirect_uri !== client.redirectUri || !safeEqualString(verifier, code.challenge)) throw new HttpError(400, '连接已失效，请重新登录', 'IDENTITY_CODE');
      await db.query('DELETE FROM public_identity_codes WHERE code_hash=$1', [sha256Hex(p.code)]);
      return (await db.query(`INSERT INTO public_identity_tokens(token_hash,client_id,session_id,expires_at) SELECT $1,$2,id,LEAST(expires_at,now()+interval '7 days') FROM sessions WHERE id=$3 AND expires_at>now() RETURNING expires_at`, [sha256Hex(token), client.id, code.session_id])).rows[0];
    });
    if (!result) throw new HttpError(401, '登录已失效', 'IDENTITY_SESSION');
    res.json({ access_token: token, token_type: 'Bearer', expires_at: result.expires_at });
  }));
  app.post(`${root}/session`, asyncHandler(async (req, res) => {
    const client = resClient.get(req)!;
    const input = z.object({ token: z.string().max(100) }).strict().safeParse(req.body);
    if (!input.success) throw new HttpError(400, '连接参数不正确', 'IDENTITY_REQUEST');
    const row = (await ctx.pool.query(`SELECT u.id,u.name,u.college,u.major FROM public_identity_tokens t JOIN sessions s ON s.id=t.session_id JOIN users u ON u.id=s.user_id WHERE t.token_hash=$1 AND t.client_id=$2 AND t.expires_at>now() AND s.expires_at>now()`, [sha256Hex(input.data.token), client.id])).rows[0];
    res.json(row ? { active: true, user: row } : { active: false });
  }));
  app.post(`${root}/revoke`, asyncHandler(async (req, res) => {
    const p = z.object({ token: z.string().max(100) }).strict().safeParse(req.body);
    if (!p.success) throw new HttpError(400, '连接参数不正确', 'IDENTITY_REQUEST');
    await ctx.pool.query('DELETE FROM public_identity_tokens WHERE token_hash=$1 AND client_id=$2', [sha256Hex(p.data.token), resClient.get(req)!.id]);
    res.json({ ok: true });
  }));
}
const resClient = new WeakMap<object, IdentityClient>();
