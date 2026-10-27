import { randomBytes, randomUUID } from 'node:crypto';
import { Router, type Express, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { CustomOAuthError, InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AppContext } from './context.js';
import { withTx } from './db.js';
import { sha256Hex, safeEqualString } from './security.js';
import { asyncHandler, readCookie, requireUser, routeId } from './http.js';
import { parseBody } from './auth.js';
import { HttpError } from './errors.js';
import { CONSENT_VERSION } from './policy.js';
import { insertAudit } from './audit.js';
import { authenticateMcp } from './assessment.js';

const SCOPE = 'assessment';
const FLOW_COOKIE = 'lab_oauth_flow';
const token = (prefix: string) => prefix + randomBytes(32).toString('base64url');
export const mcpResource = (ctx: AppContext) => `${ctx.config.publicBaseUrl}/mcp`;

function scopesValid(scopes?: string[]) {
  if (scopes && scopes.some((scope) => scope !== SCOPE)) throw new InvalidScopeError('Only the assessment scope is supported');
}
function resourceValid(ctx: AppContext, resource?: URL) {
  if (!resource || resource.href !== mcpResource(ctx)) throw new InvalidTargetError('The resource must be this assessment MCP endpoint');
}
export function validOAuthRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    return raw.length <= 2048 && !/[\\\u0000-\u0020\u007f#]/.test(raw) && !url.username && !url.password &&
      (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)));
  } catch { return false; }
}

// RFC 8252 permits only the loopback HTTP port to vary at authorization time.
// Compare the remaining original bytes: URL normalization must not broaden the
// exception to different hosts, paths, query strings, fragments or credentials.
export function matchesOAuthRedirect(requested: string, registered: string): boolean {
  if (!validOAuthRedirect(requested) || !validOAuthRedirect(registered)) return false;
  if (requested === registered) return true;
  const loopback = /^(http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost))(?::\d+)?([/?].*)?$/;
  const request = loopback.exec(requested), registration = loopback.exec(registered);
  return !!request && !!registration && request[1] === registration[1] && request[2] === registration[2];
}

type Pending = { id: string; client_id: string; browser_hash: string; redirect_uri: string; code_challenge: string; state: string | null; resource: string; expires_at: Date; resolved_at: Date | null; valid: boolean };

// Lock enrollment before connection rows, matching start/finalize/token-rotation ordering.
async function eligibleEnrollment(db: PoolClient, id: string, userId: string) {
  const row = (await db.query<{ id: string; expires_at: Date; eligible: boolean }>(
    `SELECT e.id, coalesce(e.deadline,b.start_closes_at) AS expires_at,
       (e.user_id=$2 AND e.finalized_at IS NULL AND e.consent_version=$3 AND e.consent_accepted_at IS NOT NULL AND
       ((e.started_at IS NOT NULL AND e.deadline>clock_timestamp()) OR
        (e.started_at IS NULL AND b.status='OPEN' AND b.start_closes_at>clock_timestamp()))) AS eligible
     FROM enrollments e JOIN batches b ON b.id=e.batch_id WHERE e.id=$1 FOR UPDATE OF e`, [id, userId, CONSENT_VERSION])).rows[0];
  if (!row?.eligible) throw new InvalidGrantError('Enrollment is unavailable or consent is missing');
  return row;
}

export function createOAuthProvider(ctx: AppContext): OAuthServerProvider {
  const clientsStore = {
    async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
      if (clientId.length > 200) return undefined;
      return (await ctx.pool.query<{ metadata: OAuthClientInformationFull }>('SELECT metadata FROM oauth_clients WHERE client_id=$1', [clientId])).rows[0]?.metadata;
    },
    async registerClient(input: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> {
      if (input.token_endpoint_auth_method !== 'none') {
        throw new InvalidClientMetadataError('Only public clients with token_endpoint_auth_method=none are supported');
      }
      if (!input.redirect_uris.length || input.redirect_uris.length > 5) {
        throw new InvalidClientMetadataError('Register between 1 and 5 redirect_uris');
      }
      if (input.redirect_uris.some((uri) => !validOAuthRedirect(uri))) {
        // Use the RFC 7591 code so native clients can retry with a loopback
        // callback without interpreting an English error description.
        throw new CustomOAuthError('invalid_redirect_uri', 'Unsupported redirect_uri; use HTTPS or loopback HTTP without credentials or fragments');
      }
      if (input.grant_types?.some((grant) => !['authorization_code', 'refresh_token'].includes(grant)) || input.response_types?.some((response) => response !== 'code')) {
        throw new InvalidClientMetadataError('Only authorization_code and refresh_token are supported');
      }
      if (input.scope && input.scope !== SCOPE) throw new InvalidClientMetadataError('Unsupported scope');
      const metadata: OAuthClientInformationFull = {
        client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: (input.client_name || 'MCP 客户端').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120),
        redirect_uris: input.redirect_uris, token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE,
      };
      await ctx.pool.query('INSERT INTO oauth_clients(client_id,metadata) VALUES($1,$2::jsonb)', [metadata.client_id, JSON.stringify(metadata)]);
      return metadata;
    },
  };
  return {
    clientsStore,
    async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
      // The SDK permits loopback port changes. Apply the stricter local policy
      // before persisting a flow, and never redirect to an invalid callback.
      if (!client.redirect_uris.some((uri) => matchesOAuthRedirect(params.redirectUri, uri))) {
        res.status(400).json(new InvalidRequestError('Unregistered or invalid redirect_uri').toResponseObject());
        return;
      }
      scopesValid(params.scopes); resourceValid(ctx, params.resource);
      if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length ?? 0) > 1024) throw new InvalidRequestError('Invalid PKCE challenge or state');
      const existing = readCookie(res.req, FLOW_COOKIE);
      const browser = existing && /^[A-Za-z0-9_-]{43}$/.test(existing) ? existing : randomBytes(32).toString('base64url');
      res.cookie(FLOW_COOKIE, browser, { httpOnly: true, sameSite: 'lax', secure: ctx.config.cookieSecure, maxAge: 600_000, path: '/' });
      const row = (await ctx.pool.query<{ id: string }>(
        'INSERT INTO oauth_requests(client_id,browser_hash,redirect_uri,code_challenge,state,resource) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [client.client_id, sha256Hex(browser), params.redirectUri, params.codeChallenge, params.state ?? null, mcpResource(ctx)])).rows[0]!;
      res.redirect(302, `${ctx.config.appOrigin}/mcp/connect?request=${row.id}`);
    },
    async challengeForAuthorizationCode(client, code) {
      if (code.length > 200) throw new InvalidGrantError('Invalid authorization code');
      const row = (await ctx.pool.query<{ code_challenge: string }>(
        `SELECT r.code_challenge FROM oauth_codes c JOIN oauth_requests r ON r.id=c.request_id
         WHERE c.code_hash=$1 AND r.client_id=$2 AND c.used_at IS NULL AND c.expires_at>clock_timestamp()`, [sha256Hex(code), client.client_id])).rows[0];
      if (!row) throw new InvalidGrantError('Invalid authorization code');
      return row.code_challenge;
    },
    async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
      resourceValid(ctx, resource);
      return withTx(ctx.pool, async (db) => {
        const c = (await db.query<{ enrollment_id: string; user_id: string; redirect_uri: string }>(
          `SELECT c.enrollment_id,c.user_id,r.redirect_uri FROM oauth_codes c JOIN oauth_requests r ON r.id=c.request_id
           WHERE c.code_hash=$1 AND r.client_id=$2 AND c.used_at IS NULL AND c.expires_at>clock_timestamp() FOR UPDATE OF c`, [sha256Hex(code), client.client_id])).rows[0];
        // Port flexibility applies to client registration, not to this code:
        // exchange must repeat the exact callback used for its authorization.
        if (!c || c.redirect_uri !== redirectUri) throw new InvalidGrantError('Invalid authorization code or redirect URI');
        const enrollment = await eligibleEnrollment(db, c.enrollment_id, c.user_id);
        await db.query('UPDATE oauth_codes SET used_at=clock_timestamp() WHERE code_hash=$1', [sha256Hex(code)]);
        const anchor = (await db.query<{ id: string }>('INSERT INTO mcp_tokens(enrollment_id,token_hash,expires_at) VALUES($1,$2,$3) RETURNING id', [c.enrollment_id, sha256Hex(token('anchor_')), enrollment.expires_at])).rows[0]!;
        const grant = (await db.query<{ id: string }>('INSERT INTO oauth_grants(client_id,mcp_token_id,resource) VALUES($1,$2,$3) RETURNING id', [client.client_id, anchor.id, mcpResource(ctx)])).rows[0]!;
        await insertAudit(db, { actorId: c.user_id, actorName: 'candidate', action: 'MCP_CONNECT', enrollmentId: c.enrollment_id, details: { clientName: client.client_name, connectionId: grant.id } });
        return issueTokens(db, grant.id, enrollment.expires_at);
      });
    },
    async exchangeRefreshToken(client, refresh, scopes, resource) {
      scopesValid(scopes); if (resource) resourceValid(ctx, resource);
      if (refresh.length > 200) throw new InvalidGrantError('Invalid refresh token');
      const result = await withTx(ctx.pool, async (db) => {
        const found = (await db.query<{ grant_id: string; enrollment_id: string; user_id: string }>(
          `SELECT g.id AS grant_id,t.enrollment_id,e.user_id FROM oauth_refresh_tokens r JOIN oauth_grants g ON g.id=r.grant_id
           JOIN mcp_tokens t ON t.id=g.mcp_token_id JOIN enrollments e ON e.id=t.enrollment_id WHERE r.token_hash=$1 AND g.client_id=$2`, [sha256Hex(refresh), client.client_id])).rows[0];
        if (!found) throw new InvalidGrantError('Invalid refresh token');
        const enrollment = await eligibleEnrollment(db, found.enrollment_id, found.user_id);
        const grant = await liveGrant(db, found.grant_id, client.client_id);
        const row = (await db.query<{ used_at: Date | null }>('SELECT used_at FROM oauth_refresh_tokens WHERE token_hash=$1 FOR UPDATE', [sha256Hex(refresh)])).rows[0]!;
        if (row.used_at) {
          await revokeGrant(db, grant.id);
          return null; // Commit replay revocation before returning an OAuth error.
        }
        await db.query('UPDATE oauth_refresh_tokens SET used_at=clock_timestamp() WHERE token_hash=$1', [sha256Hex(refresh)]);
        return issueTokens(db, grant.id, enrollment.expires_at);
      });
      if (!result) throw new InvalidGrantError('Refresh token was already used; reconnect');
      return result;
    },
    async verifyAccessToken(raw) {
      try {
        const identity = await authenticateMcp(ctx, raw);
        const row = (await ctx.pool.query<{ client_id: string; expires_at: Date }>(
          'SELECT g.client_id,a.expires_at FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id WHERE a.token_hash=$1', [sha256Hex(raw)])).rows[0];
        if (!row) throw new InvalidTokenError('Invalid access token');
        return { token: raw, clientId: row.client_id, scopes: [SCOPE], expiresAt: Math.floor(row.expires_at.getTime() / 1000), resource: new URL(mcpResource(ctx)), extra: identity };
      } catch { throw new InvalidTokenError('Invalid access token'); }
    },
    async revokeToken(client, request) {
      if (request.token.length > 200) return;
      await withTx(ctx.pool, async (db) => {
        const found = (await db.query<{ id: string }>(
          `SELECT g.id FROM oauth_grants g WHERE g.client_id=$2 AND (g.id IN (SELECT grant_id FROM oauth_access_tokens WHERE token_hash=$1)
           OR g.id IN (SELECT grant_id FROM oauth_refresh_tokens WHERE token_hash=$1))`, [sha256Hex(request.token), client.client_id])).rows[0];
        if (found) await revokeGrant(db, found.id);
      });
    },
  };
}

async function liveGrant(db: PoolClient, id: string, clientId: string) {
  const row = (await db.query<{ id: string }>(
    `SELECT g.id FROM oauth_grants g JOIN mcp_tokens t ON t.id=g.mcp_token_id WHERE g.id=$1 AND g.client_id=$2
     AND g.revoked_at IS NULL AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp() FOR UPDATE OF g`, [id, clientId])).rows[0];
  if (!row) throw new InvalidGrantError('Connection expired or revoked');
  return row;
}
async function issueTokens(db: PoolClient, grantId: string, deadline: Date): Promise<OAuthTokens> {
  const access = token('loa_'), refresh = token('lor_');
  const time = await db.query<{ seconds: number }>(
    `SELECT least(900, floor(extract(epoch FROM ($1::timestamptz - clock_timestamp()))))::int AS seconds`,
    [deadline],
  );
  const expires = time.rows[0]?.seconds ?? 0;
  if (expires <= 0) throw new InvalidGrantError('Enrollment expired');
  await db.query("INSERT INTO oauth_access_tokens(token_hash,grant_id,expires_at) VALUES($1,$2,clock_timestamp()+$3*interval '1 second')", [sha256Hex(access), grantId, expires]);
  await db.query('INSERT INTO oauth_refresh_tokens(token_hash,grant_id) VALUES($1,$2)', [sha256Hex(refresh), grantId]);
  return { access_token: access, token_type: 'Bearer', expires_in: expires, refresh_token: refresh, scope: SCOPE };
}
async function revokeGrant(db: PoolClient, id: string) {
  await db.query('SELECT e.id FROM enrollments e JOIN mcp_tokens t ON t.enrollment_id=e.id JOIN oauth_grants g ON g.mcp_token_id=t.id WHERE g.id=$1 FOR UPDATE OF e', [id]);
  await db.query('UPDATE oauth_grants SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=$1', [id]);
  await db.query('UPDATE mcp_tokens SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE id=(SELECT mcp_token_id FROM oauth_grants WHERE id=$1)', [id]);
  await db.query(`UPDATE enrollments e SET mcp_connected=false WHERE e.started_at IS NULL AND e.id=(SELECT t.enrollment_id FROM oauth_grants g JOIN mcp_tokens t ON t.id=g.mcp_token_id WHERE g.id=$1)
    AND NOT EXISTS(SELECT 1 FROM mcp_tokens t WHERE t.enrollment_id=e.id AND t.revoked_at IS NULL AND t.expires_at>clock_timestamp())`, [id]);
}

async function pendingRequest(ctx: AppContext, req: Request, db: AppContext['pool'] | PoolClient, lock = false): Promise<Pending> {
  const auth = requireUser(req);
  if (auth.user.role !== 'CANDIDATE') throw new HttpError(403, '请使用考生账号授权', 'CANDIDATE_REQUIRED');
  const id = routeId(req.params.id);
  const row = (await db.query<Pending>(`SELECT *,expires_at>clock_timestamp() AS valid FROM oauth_requests WHERE id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])).rows[0];
  const browser = readCookie(req, FLOW_COOKIE) ?? '';
  if (!row || !safeEqualString(row.browser_hash, sha256Hex(browser))) throw new HttpError(403, '请在发起连接的浏览器中完成授权', 'OAUTH_BROWSER');
  if (!row.valid || row.resolved_at) throw new HttpError(410, '授权请求已失效，请从客户端重新连接', 'OAUTH_EXPIRED');
  return row;
}

export function oauthBrowserRouter(ctx: AppContext): Router {
  const router = Router();
  router.get('/oauth/requests/:id', asyncHandler(async (req, res) => {
    const flow = await pendingRequest(ctx, req, ctx.pool);
    const client = (await ctx.pool.query<{ metadata: OAuthClientInformationFull }>('SELECT metadata FROM oauth_clients WHERE client_id=$1', [flow.client_id])).rows[0]!.metadata;
    const enrollments = (await ctx.pool.query(
      `SELECT e.id,r.name AS "roundName",b.name AS "batchName",e.direction,CASE WHEN e.started_at IS NULL THEN 'READY' ELSE 'ACTIVE' END AS state,e.deadline
       FROM enrollments e JOIN batches b ON b.id=e.batch_id JOIN rounds r ON r.id=e.round_id
       WHERE e.user_id=$1 AND e.consent_version=$2 AND e.consent_accepted_at IS NOT NULL AND e.finalized_at IS NULL AND
       ((e.started_at IS NOT NULL AND e.deadline>clock_timestamp()) OR (e.started_at IS NULL AND b.status='OPEN' AND b.start_closes_at>clock_timestamp())) ORDER BY e.created_at DESC`, [req.auth!.user.id, CONSENT_VERSION])).rows;
    res.json({ request: { id: flow.id, clientName: client.client_name, redirectOrigin: new URL(flow.redirect_uri).origin, expiresAt: flow.expires_at.toISOString(), scopes: [SCOPE], enrollments } });
  }));
  router.post('/oauth/requests/:id/decision', asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ approved: z.boolean(), enrollmentId: z.string().uuid().optional() }).strict(), req.body);
    const redirectUrl = await withTx(ctx.pool, async (db) => {
      const flow = await pendingRequest(ctx, req, db, true);
      const redirect = new URL(flow.redirect_uri);
      if (flow.state !== null) redirect.searchParams.set('state', flow.state);
      if (body.approved) {
        if (!body.enrollmentId) throw new HttpError(400, '请选择考核', 'VALIDATION');
        try { await eligibleEnrollment(db, body.enrollmentId, req.auth!.user.id); }
        catch { throw new HttpError(409, '该考核不可授权，请刷新后重试', 'ENROLLMENT_UNAVAILABLE'); }
        const code = token('loc_');
        await db.query('INSERT INTO oauth_codes(code_hash,request_id,enrollment_id,user_id) VALUES($1,$2,$3,$4)', [sha256Hex(code), flow.id, body.enrollmentId, req.auth!.user.id]);
        redirect.searchParams.set('code', code);
      } else redirect.searchParams.set('error', 'access_denied');
      await db.query('UPDATE oauth_requests SET resolved_at=clock_timestamp() WHERE id=$1', [flow.id]);
      return redirect.href;
    });
    res.json({ redirectUrl });
  }));
  router.get('/enrollments/:id/connections', asyncHandler(async (req, res) => {
    const user = requireUser(req).user;
    const id = routeId(req.params.id);
    if (!(await ctx.pool.query('SELECT 1 FROM enrollments WHERE id=$1 AND user_id=$2', [id, user.id])).rowCount) throw new HttpError(404, '未找到', 'NOT_FOUND');
    const connections = (await ctx.pool.query(
      `SELECT g.id,c.metadata->>'client_name' AS "clientName",g.created_at AS "createdAt",g.last_used_at AS "lastUsedAt"
       FROM oauth_grants g JOIN oauth_clients c ON c.client_id=g.client_id JOIN mcp_tokens t ON t.id=g.mcp_token_id
       WHERE t.enrollment_id=$1 AND t.revoked_at IS NULL AND g.revoked_at IS NULL AND t.expires_at>clock_timestamp() ORDER BY g.created_at DESC`, [id])).rows;
    res.json({ connections });
  }));
  router.delete('/enrollments/:id/connections/:connectionId', asyncHandler(async (req, res) => {
    const user = requireUser(req).user, id = routeId(req.params.id), grantId = routeId(req.params.connectionId);
    await withTx(ctx.pool, async (db) => {
      if (!(await db.query('SELECT 1 FROM enrollments WHERE id=$1 AND user_id=$2 FOR UPDATE', [id, user.id])).rowCount) throw new HttpError(404, '未找到', 'NOT_FOUND');
      if (!(await db.query('SELECT 1 FROM oauth_grants g JOIN mcp_tokens t ON t.id=g.mcp_token_id WHERE g.id=$1 AND t.enrollment_id=$2', [grantId, id])).rowCount) throw new HttpError(404, '未找到', 'NOT_FOUND');
      await revokeGrant(db, grantId);
      await insertAudit(db, { actorId: user.id, actorName: user.name, action: 'MCP_DISCONNECT', enrollmentId: id, details: { connectionId: grantId } });
    });
    res.json({ ok: true });
  }));
  return router;
}

export function registerOAuthPublic(app: Express, ctx: AppContext) {
  const provider = createOAuthProvider(ctx), base = ctx.config.publicBaseUrl;
  app.use('/oauth/authorize', authorizationHandler({ provider }));
  app.use('/oauth/register', clientRegistrationHandler({ clientsStore: provider.clientsStore }));
  app.use('/oauth/token', tokenHandler({ provider, rateLimit: { windowMs: 60_000, max: 100 } }));
  app.use('/oauth/revoke', revocationHandler({ provider }));
  const oauthMetadata = {
    issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: [SCOPE],
  };
  app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: new URL(mcpResource(ctx)), scopesSupported: [SCOPE], resourceName: '110 实验室考核' }));
}

// Short-lived credentials are not audit records; keep only live grants and a brief retry window.
export async function purgeOAuthCredentials(ctx: AppContext): Promise<void> {
  await withTx(ctx.pool, async (db) => {
    await db.query("DELETE FROM oauth_codes WHERE expires_at<clock_timestamp()-interval '1 day'");
    await db.query("DELETE FROM oauth_requests r WHERE expires_at<clock_timestamp()-interval '1 day' AND NOT EXISTS(SELECT 1 FROM oauth_codes c WHERE c.request_id=r.id)");
    await db.query("DELETE FROM oauth_access_tokens WHERE expires_at<clock_timestamp()-interval '1 day'");
    await db.query(`DELETE FROM oauth_grants g USING mcp_tokens t WHERE t.id=g.mcp_token_id AND
      (t.expires_at<clock_timestamp()-interval '1 day' OR g.revoked_at<clock_timestamp()-interval '1 day')`);
    await db.query(`DELETE FROM oauth_clients c WHERE created_at<clock_timestamp()-interval '30 days'
      AND NOT EXISTS(SELECT 1 FROM oauth_grants g WHERE g.client_id=c.client_id)
      AND NOT EXISTS(SELECT 1 FROM oauth_requests r WHERE r.client_id=c.client_id)`);
  });
}
