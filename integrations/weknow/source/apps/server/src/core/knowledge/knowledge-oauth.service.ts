import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { ConfigService } from '@nestjs/config';
import { randomUUID, createHash } from 'node:crypto';
import { NativeSessionService } from '../session/native-session.service';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { JwtType } from '../auth/dto/jwt-payload';
import {
  SCOPES,
  SCOPE_LABELS,
  KnowledgeScope,
  hash,
  secret,
  same,
  OAuthError,
  parseScopes,
  validRedirect,
  redirectMatches,
  canonicalOrigin,
  hasScope,
} from './knowledge-policy';

export interface KnowledgePrincipal {
  user: any;
  workspace: any;
  grant: any;
  scopes: KnowledgeScope[];
  rawToken: string;
  authType: JwtType;
  oauth: { provider: string; scopes: KnowledgeScope[] };
}
const json = (v: any) => sql`${JSON.stringify(v)}::text::jsonb`;
@Injectable()
export class KnowledgeOAuthService {
  readonly cookieName = 'kb_oauth_flow';
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private config: ConfigService,
    private native: NativeSessionService,
    private workspaces: WorkspaceRepo,
    private sessions: UserSessionRepo,
  ) {}
  get origin() {
    return canonicalOrigin(this.config.get('APP_URL', 'http://127.0.0.1:5840'));
  }
  get resource() {
    return this.origin + '/mcp';
  }
  get secure() {
    return this.origin.startsWith('https:');
  }
  get metadata() {
    return {
      issuer: this.origin,
      authorization_endpoint: this.origin + '/api/knowledge/oauth/authorize',
      token_endpoint: this.origin + '/api/knowledge/oauth/token',
      registration_endpoint: this.origin + '/api/knowledge/oauth/register',
      revocation_endpoint: this.origin + '/api/knowledge/oauth/revoke',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: SCOPES,
    };
  }
  get resourceMetadata() {
    return {
      resource: this.resource,
      resource_name: '110lab 知识库',
      authorization_servers: [this.origin],
      scopes_supported: SCOPES,
      bearer_methods_supported: ['header'],
    };
  }
  challenge() {
    return `Bearer resource_metadata="${this.origin}/.well-known/oauth-protected-resource/mcp"`;
  }
  private resourceCheck(value: unknown) {
    if (value !== this.resource)
      throw new OAuthError('invalid_target', 'Use this knowledge MCP resource');
  }
  private async client(id: any, trx: Kysely<any> = this.db) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))
      throw new OAuthError('invalid_client', 'Invalid client', 401);
    const c = await trx
      .selectFrom('knowledgeOAuthClients')
      .selectAll()
      .where('clientId', '=', id)
      .executeTakeFirst();
    if (!c) throw new OAuthError('invalid_client', 'Unknown client', 401);
    // Kysely's CamelCasePlugin also transforms nested JSONB keys on reads.
    return {
      client_id: c.clientId,
      client_name: c.metadata.clientName ?? c.metadata.client_name,
      redirect_uris: c.metadata.redirectUris ?? c.metadata.redirect_uris,
      scope: c.metadata.scope,
    };
  }
  async register(input: any) {
    if (
      !input ||
      !Array.isArray(input.redirect_uris) ||
      !input.redirect_uris.length ||
      input.redirect_uris.length > 5 ||
      input.redirect_uris.some((u: any) => !validRedirect(u))
    )
      throw new OAuthError(
        'invalid_redirect_uri',
        'Use HTTPS, loopback HTTP or the reviewed WorkBuddy callback',
      );
    if (
      input.token_endpoint_auth_method !== undefined &&
      input.token_endpoint_auth_method !== 'none'
    )
      throw new OAuthError(
        'invalid_client_metadata',
        'Public clients must use none authentication',
      );
    if (
      input.grant_types !== undefined &&
      (!Array.isArray(input.grant_types) ||
        input.grant_types.some(
          (v: any) => !['authorization_code', 'refresh_token'].includes(v),
        ))
    )
      throw new OAuthError('invalid_client_metadata', 'Unsupported grant type');
    if (
      input.response_types !== undefined &&
      (!Array.isArray(input.response_types) ||
        input.response_types.some((v: any) => v !== 'code'))
    )
      throw new OAuthError(
        'invalid_client_metadata',
        'Only code response is supported',
      );
    const scopes =
      input.scope === undefined ? [...SCOPES] : parseScopes(input.scope);
    const client = {
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name:
        (typeof input.client_name === 'string'
          ? input.client_name
          : 'MCP 客户端'
        )
          .replace(/[\u0000-\u001f\u007f]/g, '')
          .trim()
          .slice(0, 100) || 'MCP 客户端',
      redirect_uris: [...new Set(input.redirect_uris)],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: scopes.join(' '),
    };
    // Anonymous DCR cannot create an unbounded database. The HTTP layer also applies IP limits.
    await this.db.transaction().execute(async (t) => {
      await sql`select pg_advisory_xact_lock(hashtext('110lab:knowledge:dcr'))`.execute(
        t,
      );
      const count = await t
        .selectFrom('knowledgeOAuthClients')
        .select(sql<number>`count(*)::int`.as('n'))
        .where('createdAt', '>', new Date(Date.now() - 86400000))
        .executeTakeFirst();
      if (count.n >= 200)
        throw new OAuthError(
          'temporarily_unavailable',
          'Registration limit reached',
          429,
        );
      await t
        .insertInto('knowledgeOAuthClients')
        .values({ clientId: client.client_id, metadata: json(client) })
        .execute();
    });
    return client;
  }
  async authorize(query: any, existing: unknown) {
    const client = await this.client(query.client_id);
    this.resourceCheck(query.resource);
    if (
      query.response_type !== 'code' ||
      query.code_challenge_method !== 'S256' ||
      typeof query.code_challenge !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)
    )
      throw new OAuthError(
        'invalid_request',
        'Authorization code and S256 PKCE required',
      );
    if (
      !validRedirect(query.redirect_uri) ||
      !client.redirect_uris.some((u: string) =>
        redirectMatches(query.redirect_uri, u),
      )
    )
      throw new OAuthError('invalid_redirect_uri', 'Unregistered callback');
    const scopes = parseScopes(query.scope);
    if (scopes.some((s) => !client.scope.split(' ').includes(s)))
      throw new OAuthError('invalid_scope', 'Scope not registered');
    if (
      query.state !== undefined &&
      (typeof query.state !== 'string' || query.state.length > 1024)
    )
      throw new OAuthError('invalid_request', 'Invalid state');
    const binding =
      typeof existing === 'string' && /^[A-Za-z0-9_-]{43}$/.test(existing)
        ? existing
        : secret('');
    const id = randomUUID();
    await this.db
      .insertInto('knowledgeOAuthRequests')
      .values({
        id,
        clientId: client.client_id,
        browserHash: hash(binding),
        redirectUri: query.redirect_uri,
        challenge: query.code_challenge,
        state: query.state ?? null,
        scopes: json(scopes),
        resource: this.resource,
        expiresAt: new Date(Date.now() + 600000),
      })
      .execute();
    return { binding, url: this.origin + '/connect/knowledge?request=' + id };
  }
  private async pending(
    id: string,
    binding: string,
    t: Kysely<any> = this.db,
    lock = false,
  ) {
    if (!/^[a-f0-9-]{36}$/.test(id))
      throw new OAuthError('invalid_request', 'Invalid request');
    let q = t
      .selectFrom('knowledgeOAuthRequests')
      .selectAll()
      .where('id', '=', id);
    if (lock) q = q.forUpdate();
    const r = await q.executeTakeFirst();
    if (!r || !binding || !same(r.browserHash, hash(binding)))
      throw new OAuthError(
        'invalid_request',
        'Use the browser that initiated this connection',
        403,
      );
    if (r.resolvedAt || new Date(r.expiresAt).getTime() <= Date.now())
      throw new OAuthError(
        'invalid_request',
        'Authorization request expired',
        410,
      );
    return r;
  }
  async preview(id: string, binding: string, user: any) {
    const r = await this.pending(id, binding);
    const c = await this.client(r.clientId);
    return {
      requestId: r.id,
      clientName: c.client_name,
      callbackOrigin: new URL(r.redirectUri).origin,
      user: { id: user.id, name: user.name, avatarUrl: user.avatarUrl },
      scopes: r.scopes.map((s: KnowledgeScope) => ({
        id: s,
        label: SCOPE_LABELS[s],
      })),
      expiresAt: r.expiresAt,
    };
  }
  async resolve(
    id: string,
    binding: string,
    user: any,
    sessionId: string,
    approve: boolean,
    selected: unknown,
  ) {
    await this.native.validate(user.id, user.workspaceId, sessionId);
    return this.db.transaction().execute(async (t) => {
      const r = await this.pending(id, binding, t, true);
      const callback = new URL(r.redirectUri);
      if (r.state !== null) callback.searchParams.set('state', r.state);
      if (!approve) {
        await t
          .updateTable('knowledgeOAuthRequests')
          .set({ resolvedAt: new Date() })
          .where('id', '=', id)
          .execute();
        callback.searchParams.set('error', 'access_denied');
        return { redirectUrl: callback.href };
      }
      if (
        !Array.isArray(selected) ||
        !selected.length ||
        selected.some((s) => !r.scopes.includes(s))
      )
        throw new OAuthError(
          'invalid_scope',
          'Select only requested permissions',
        );
      const code = secret('kb_c_');
      await t
        .updateTable('knowledgeOAuthRequests')
        .set({
          resolvedAt: new Date(),
          scopes: json([...new Set(selected)]),
          codeHash: hash(code),
          codeExpiresAt: new Date(Date.now() + 180000),
          userId: user.id,
          workspaceId: user.workspaceId,
          sessionId,
        })
        .where('id', '=', id)
        .execute();
      callback.searchParams.set('code', code);
      callback.searchParams.set('iss', this.origin);
      return { redirectUrl: callback.href };
    });
  }
  async token(input: any) {
    const client = await this.client(input?.client_id);
    if (input?.client_secret)
      throw new OAuthError('invalid_client', 'This is a public client');
    this.resourceCheck(input?.resource);
    if (input?.grant_type === 'authorization_code') {
      if (
        typeof input.code !== 'string' ||
        input.code.length > 200 ||
        typeof input.code_verifier !== 'string' ||
        !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier)
      )
        throw new OAuthError('invalid_grant', 'Invalid authorization code');
      return this.db.transaction().execute(async (t) => {
        const r = await t
          .selectFrom('knowledgeOAuthRequests')
          .selectAll()
          .where('codeHash', '=', hash(input.code))
          .where('clientId', '=', client.client_id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !r ||
          !r.resolvedAt ||
          r.usedAt ||
          !r.userId ||
          new Date(r.codeExpiresAt).getTime() <= Date.now() ||
          r.redirectUri !== input.redirect_uri ||
          r.resource !== this.resource ||
          !same(
            r.challenge,
            createHash('sha256')
              .update(input.code_verifier)
              .digest('base64url'),
          )
        )
          throw new OAuthError(
            'invalid_grant',
            'Invalid authorization code, PKCE or callback',
          );
        await this.native.validate(r.userId, r.workspaceId, r.sessionId);
        const expiresAt = new Date(Date.now() + 30 * 86400000),
          session = await this.sessions.insertSession(
            {
              userId: r.userId,
              workspaceId: r.workspaceId,
              deviceName: 'MCP · ' + client.client_name,
              expiresAt,
            },
            t as any,
          );
        await this.native.inherit(r.sessionId,session.id,t);
        const grant = {
          id: randomUUID(),
          clientId: client.client_id,
          userId: r.userId,
          workspaceId: r.workspaceId,
          sessionId: session.id,
          resource: this.resource,
          scopes: r.scopes,
          expiresAt,
        };
        await t
          .insertInto('knowledgeOAuthGrants')
          .values({ ...grant, scopes: json(grant.scopes) })
          .execute();
        await t
          .updateTable('knowledgeOAuthRequests')
          .set({ usedAt: new Date() })
          .where('id', '=', r.id)
          .execute();
        return this.issue(t, grant);
      });
    }
    if (input?.grant_type === 'refresh_token') {
      if (
        typeof input.refresh_token !== 'string' ||
        input.refresh_token.length > 200
      )
        throw new OAuthError('invalid_grant', 'Invalid refresh token');
      const result = await this.db.transaction().execute(async (t) => {
        const token = await t
          .selectFrom('knowledgeOAuthTokens')
          .selectAll()
          .where('tokenHash', '=', hash(input.refresh_token))
          .where('kind', '=', 'refresh')
          .forUpdate()
          .executeTakeFirst();
        if (!token)
          throw new OAuthError('invalid_grant', 'Invalid refresh token');
        const grant = await t
          .selectFrom('knowledgeOAuthGrants')
          .selectAll()
          .where('id', '=', token.grantId)
          .where('clientId', '=', client.client_id)
          .forUpdate()
          .executeTakeFirst();
        if (
          !grant ||
          grant.revokedAt ||
          new Date(grant.expiresAt).getTime() <= Date.now() ||
          new Date(token.expiresAt).getTime() <= Date.now()
        )
          throw new OAuthError('invalid_grant', 'Connection expired');
        if (token.usedAt) {
          await this.revokeGrant(grant, t);
          return null;
        }
        await this.native.validate(
          grant.userId,
          grant.workspaceId,
          grant.sessionId,
        );
        if (input.scope !== undefined) {
          const requested = parseScopes(input.scope);
          if (requested.some((s) => !grant.scopes.includes(s)))
            throw new OAuthError('invalid_scope', 'Refresh cannot widen scope');
          if (JSON.stringify([...requested].sort()) !== JSON.stringify([...grant.scopes].sort()))
            throw new OAuthError(
              'invalid_scope',
              'Reconnect to change granted scopes',
            );
        }
        await t
          .updateTable('knowledgeOAuthTokens')
          .set({ usedAt: new Date() })
          .where('tokenHash', '=', token.tokenHash)
          .execute();
        return this.issue(t, grant);
      });
      if (!result)
        throw new OAuthError(
          'invalid_grant',
          'Refresh replay revoked this connection',
        );
      return result;
    }
    throw new OAuthError(
      'unsupported_grant_type',
      'Use authorization_code or refresh_token',
    );
  }
  private async issue(t: Kysely<any>, g: any) {
    const access = secret('kb_a_'),
      refresh = secret('kb_r_');
    const expires = Math.min(
      900,
      Math.floor((new Date(g.expiresAt).getTime() - Date.now()) / 1000),
    );
    if (expires <= 0)
      throw new OAuthError('invalid_grant', 'Expired connection');
    await t
      .insertInto('knowledgeOAuthTokens')
      .values([
        {
          tokenHash: hash(access),
          kind: 'access',
          grantId: g.id,
          expiresAt: new Date(Date.now() + expires * 1000),
        },
        {
          tokenHash: hash(refresh),
          kind: 'refresh',
          grantId: g.id,
          expiresAt: g.expiresAt,
        },
      ])
      .execute();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: expires,
      refresh_token: refresh,
      scope: g.scopes.join(' '),
    };
  }
  async verify(rawToken: string): Promise<KnowledgePrincipal> {
    if (
      typeof rawToken !== 'string' ||
      !/^kb_a_[A-Za-z0-9_-]{43}$/.test(rawToken)
    )
      throw new UnauthorizedException('Invalid knowledge token');
    const token = await this.db
      .selectFrom('knowledgeOAuthTokens')
      .selectAll()
      .where('tokenHash', '=', hash(rawToken))
      .where('kind', '=', 'access')
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    if (!token) throw new UnauthorizedException('Expired knowledge token');
    const grant = await this.db
      .selectFrom('knowledgeOAuthGrants')
      .selectAll()
      .where('id', '=', token.grantId)
      .where('revokedAt', 'is', null)
      .where('expiresAt', '>', new Date())
      .executeTakeFirst();
    if (!grant || grant.resource !== this.resource)
      throw new UnauthorizedException('Invalid knowledge resource');
    const user = await this.native.validate(
      grant.userId,
      grant.workspaceId,
      grant.sessionId,
    );
    const workspace = await this.workspaces.findById(grant.workspaceId);
    if (!workspace) throw new UnauthorizedException();
    return {
      user,
      workspace,
      grant,
      scopes: grant.scopes,
      rawToken,
      authType: JwtType.OAUTH_ACCESS,
      oauth: { provider: '110lab-knowledge', scopes: grant.scopes },
    };
  }
  require(p: KnowledgePrincipal, scope: KnowledgeScope) {
    if (!hasScope(p.scopes, scope))
      throw new ForbiddenException('insufficient_scope: ' + scope);
  }
  async revokeToken(input: any) {
    const client = await this.client(input?.client_id);
    if (typeof input.token !== 'string' || input.token.length > 200) return {};
    await this.db.transaction().execute(async (t) => {
      const tok = await t
        .selectFrom('knowledgeOAuthTokens')
        .select('grantId')
        .where('tokenHash', '=', hash(input.token))
        .executeTakeFirst();
      if (tok) {
        const g = await t
          .selectFrom('knowledgeOAuthGrants')
          .selectAll()
          .where('id', '=', tok.grantId)
          .where('clientId', '=', client.client_id)
          .forUpdate()
          .executeTakeFirst();
        if (g) await this.revokeGrant(g, t);
      }
    });
    return {};
  }
  private async revokeGrant(g: any, t: Kysely<any>) {
    await t
      .updateTable('knowledgeOAuthGrants')
      .set({ revokedAt: new Date() })
      .where('id', '=', g.id)
      .execute();
    await t
      .updateTable('userSessions')
      .set({ revokedAt: new Date() })
      .where('id', '=', g.sessionId)
      .execute();
  }
  async connections(user: any) {
    const rows = await this.db
      .selectFrom('knowledgeOAuthGrants as g')
      .innerJoin('knowledgeOAuthClients as c', 'c.clientId', 'g.clientId')
      .select([
        'g.id',
        'g.scopes',
        'g.createdAt',
        'g.expiresAt',
        'g.revokedAt',
        'c.metadata',
      ])
      .where('g.userId', '=', user.id)
      .where('g.workspaceId', '=', user.workspaceId)
      .orderBy('g.createdAt', 'desc')
      .limit(100)
      .execute();
    return rows.map((row) => ({
      ...row,
      metadata: {
        client_name: row.metadata.clientName ?? row.metadata.client_name,
      },
    }));
  }
  async disconnect(id: string, user: any) {
    await this.db.transaction().execute(async (t) => {
      const g = await t
        .selectFrom('knowledgeOAuthGrants')
        .selectAll()
        .where('id', '=', id)
        .where('userId', '=', user.id)
        .where('workspaceId', '=', user.workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!g)
        throw new OAuthError('invalid_request', 'Connection not found', 404);
      await this.revokeGrant(g, t);
    });
    return { revoked: true };
  }
}
