import type { NextFunction, Request, Response } from 'express';
import { HttpError } from './errors.js';
import type { AppContext } from './context.js';
import { clearSessionCookie, loadSession, setSessionCookie, type SessionAuth } from './auth.js';
import { safeEqualString } from './security.js';
import { EMBED_SESSION_COOKIE, usesEmbeddingSession } from './embedding.js';

declare global {
  namespace Express {
    interface Request {
      auth?: SessionAuth;
    }
  }
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CSRF_EXEMPT = new Set([
  '/api/auth/email-code',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/reset-password',
]);

export function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function securityHeaders(ctx: AppContext) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const ancestors = ctx.config.embeddingOrigins ?? [];
    if (!ancestors.length) res.setHeader('X-Frame-Options', 'DENY');
    else res.removeHeader('X-Frame-Options');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors " + (ancestors.length ? ancestors.join(' ') : "'none'"),
    );
    next();
  };
}

export function cors(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.header('origin');
    if (origin && origin === ctx.config.appOrigin) {
      res.setHeader('Access-Control-Allow-Origin', ctx.config.appOrigin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  };
}

export function originGuard(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!UNSAFE.has(req.method)) return next();
    const origin = req.header('origin');
    if ((origin && origin !== ctx.config.appOrigin) || req.header('sec-fetch-site') === 'cross-site') {
      res.status(403).json({ message: '请求来源不被允许', code: 'ORIGIN' });
      return;
    }
    next();
  };
}

export function sessionLoader(ctx: AppContext) {
  return asyncHandler(async (req, _res, next) => {
    if (req.path === '/mcp') return next(); // MCP authenticates its scoped bearer token.
    const embedded = usesEmbeddingSession(ctx.config, req);
    const cookie = embedded ? readCookie(req, EMBED_SESSION_COOKIE) : readCookie(req, 'lab_session');
    if (cookie) req.auth = (await loadSession(ctx, cookie)) ?? undefined;
    next();
  });
}

export function csrfGuard(req: Request, res: Response, next: NextFunction): void {
  if (!UNSAFE.has(req.method) || !req.auth || CSRF_EXEMPT.has(req.path)) return next();
  const header = req.header('x-csrf-token') ?? '';
  if (!safeEqualString(header, req.auth.csrfToken)) {
    res.status(403).json({ message: '缺少或无效的 CSRF 令牌', code: 'CSRF' });
    return;
  }
  next();
}

export function requireUser(req: Request): SessionAuth {
  if (!req.auth) throw new HttpError(401, '未登录', 'UNAUTHENTICATED');
  return req.auth;
}

export function requireAdmin(req: Request): SessionAuth {
  const auth = requireUser(req);
  if (auth.user.role !== 'ADMIN') throw new HttpError(403, '需要管理员权限', 'FORBIDDEN');
  return auth;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof HttpError) {
    const retry = 'retryAfterSeconds' in err ? Number(err.retryAfterSeconds) : NaN;
    const retryAfterSeconds = Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : undefined;
    if (retryAfterSeconds) res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(err.status).json({ message: err.message, code: err.code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ message: '请求体不是有效的 JSON', code: 'VALIDATION' });
    return;
  }
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as { status?: number }).status) : 0;
  const type = typeof err === 'object' && err && 'type' in err ? String((err as { type?: string }).type) : '';
  if (status === 413 || type === 'entity.too.large') {
    res.status(413).json({ message: '请求体过大', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  console.error(JSON.stringify({
    status: 500,
    path: req.path,
    name: err instanceof Error ? err.name : 'Error',
  }));
  res.status(500).json({ message: '服务器内部错误', code: 'INTERNAL' });
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.header('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function sendSession(res: Response, ctx: AppContext, sessionId: string, req: Request): void {
  setSessionCookie(res, ctx, sessionId, usesEmbeddingSession(ctx.config, req));
}

export function clearSession(res: Response, ctx: AppContext, req: Request): void {
  clearSessionCookie(res, ctx, usesEmbeddingSession(ctx.config, req));
}

export function routeId(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new HttpError(400, '请求参数不正确', 'VALIDATION');
  }
  return raw;
}
