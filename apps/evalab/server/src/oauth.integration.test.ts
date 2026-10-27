import { registrationProof, mergeCookies } from '../test/registration-proof.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { after, before, beforeEach, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Pool } from 'pg';
import { bootstrapAdmin } from './bootstrap.js';
import { closeContext, createContext, type AppContext } from './context.js';
import { createApp } from './app.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

type Json = Record<string, any>;

if (!databaseUrl) {
  test('oauth integration', { skip: 'set TEST_DATABASE_URL to a disposable database' }, () => {});
} else {
  const schema = `oauth_${process.pid}_${randomBytes(2).toString('hex')}`;
  let ctx: AppContext;
  let server: Server;
  let base = '';
  let mcpUrl: URL;
  let storage = '';
  let seq = 0;

  class Api {
    private readonly jar = new Map<string, string>();
    csrf = '';

    cookie(name: string): string {
      return this.jar.get(name) ?? '';
    }

    setCookie(name: string, value: string): void {
      this.jar.set(name, value);
    }

    clearCookie(name: string): void {
      this.jar.delete(name);
    }

    cookieHeader(): string {
      return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
    }

    absorb(res: Response): void {
      for (const item of res.headers.getSetCookie()) {
        const pair = item.split(';')[0] ?? '';
        const eq = pair.indexOf('=');
        if (eq > 0) this.jar.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
    }

    async fetch(urlPath: string, init: RequestInit = {}) {
      const headers = new Headers(init.headers);
      headers.set('origin', base);
      const cookie = this.cookieHeader();
      if (cookie) headers.set('cookie', cookie);
      const method = init.method ?? 'GET';
      if (this.csrf && method !== 'GET' && method !== 'HEAD') headers.set('x-csrf-token', this.csrf);
      if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
      const res = await fetch(base + urlPath, { ...init, headers });
      this.absorb(res);
      const text = await res.text();
      const type = res.headers.get('content-type') ?? '';
      const data = text && type.includes('json') ? JSON.parse(text) as Json : {};
      if (typeof data.csrfToken === 'string') this.csrf = data.csrfToken;
      return { status: res.status, data, text };
    }
  }

  class TestOAuthProvider implements OAuthClientProvider {
    authorizationUrl?: URL;
    private info?: OAuthClientInformationMixed;
    private saved?: OAuthTokens;
    private verifier = '';
    readonly stateValue = `st${randomBytes(8).toString('hex')}`;

    constructor(private readonly callback: string) {}

    get redirectUrl(): string {
      return this.callback;
    }

    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: '考核代理',
        redirect_uris: [this.callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: 'assessment',
      };
    }

    state(): string {
      return this.stateValue;
    }

    clientInformation(): OAuthClientInformationMixed | undefined {
      return this.info;
    }

    saveClientInformation(info: OAuthClientInformationMixed): void {
      this.info = info;
    }

    tokens(): OAuthTokens | undefined {
      return this.saved;
    }

    saveTokens(tokens: OAuthTokens): void {
      this.saved = tokens;
    }

    redirectToAuthorization(url: URL): void {
      this.authorizationUrl = url;
    }

    saveCodeVerifier(value: string): void {
      this.verifier = value;
    }

    codeVerifier(): string {
      return this.verifier;
    }
  }

  class BearerProvider implements OAuthClientProvider {
    constructor(private readonly accessToken: string, private readonly callback: string) {}

    get redirectUrl(): string {
      return this.callback;
    }

    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [this.callback],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      };
    }

    clientInformation(): OAuthClientInformationMixed {
      return { client_id: 'legacy-bearer' };
    }

    tokens(): OAuthTokens {
      return { access_token: this.accessToken, token_type: 'Bearer' };
    }

    saveTokens(): void {}

    redirectToAuthorization(): void {
      throw new Error('legacy bearer started an OAuth redirect');
    }

    saveCodeVerifier(): void {}

    codeVerifier(): string {
      return 'legacy-verifier-not-used';
    }
  }

  function pkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
  }

  function cookiePair(res: Response, name: string): string {
    const raw = res.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
    assert.ok(raw, `missing ${name}`);
    assert.match(raw, /HttpOnly/i);
    const pair = raw.split(';')[0] ?? '';
    return pair.slice(name.length + 1);
  }

  async function readJson(res: Response): Promise<{ status: number; data: Json; text: string }> {
    const text = await res.text();
    const type = res.headers.get('content-type') ?? '';
    const data = text && type.includes('json') ? JSON.parse(text) as Json : {};
    return { status: res.status, data, text };
  }

  async function registerClient(body: Json) {
    return readJson(await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    }));
  }

  function publicClient(redirects: string[], extra: Json = {}): Json {
    return {
      client_name: 'Test Agent',
      redirect_uris: redirects,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'assessment',
      ...extra,
    };
  }

  async function postToken(params: Record<string, string>) {
    return readJson(await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params),
    }));
  }

  async function postRevoke(clientId: string, tokenValue: string) {
    return readJson(await fetch(`${base}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ client_id: clientId, token: tokenValue }),
    }));
  }

  async function authorize(query: Record<string, string>, cookie = '') {
    const url = new URL('/oauth/authorize', base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    return fetch(url, { redirect: 'manual', headers });
  }

  async function mcpPost(tokenValue?: string) {
    const headers = new Headers({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    });
    if (tokenValue) headers.set('authorization', `Bearer ${tokenValue}`);
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'oauth-test', version: '0' },
        },
      }),
    });
    const text = await res.text();
    return { status: res.status, text, www: res.headers.get('www-authenticate') ?? '' };
  }

  async function openClient(provider: OAuthClientProvider): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
    const client = new Client({ name: 'exam-agent', version: '0.0.0' });
    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  function toolText(result: { isError?: boolean; content?: unknown }): string {
    assert.notEqual(result.isError, true);
    assert.ok(Array.isArray(result.content));
    const first = result.content[0] as { type?: string; text?: string };
    assert.equal(first?.type, 'text');
    assert.equal(typeof first.text, 'string');
    return first.text ?? '';
  }

  async function codeFor(email: string): Promise<string> {
    const row = await ctx.pool.query<{ body: string }>('SELECT body FROM email_outbox WHERE to_email = $1 ORDER BY created_at DESC LIMIT 1', [email]);
    const code = row.rows[0]?.body.match(/验证码是 (\d{6})/)?.[1];
    assert.ok(code);
    return code;
  }

  async function register(api: Api, email: string, studentNo: string) {
    const sent = await api.fetch('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email, purpose: 'REGISTER', registrationProof: await registrationProof(api, email) }) });
    assert.equal(sent.status, 200);
    assert.equal(sent.text.includes('验证码是'), false);
    const code = await codeFor(email);
    const created = await api.fetch('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: '考生甲', studentNo, college: '计算机', major: '软件工程', phone: '13800138000',
        email, password: 'Student-pass-1', challengeId: sent.data.challengeId, code, acceptedPolicy: true,
      }),
    });
    assert.equal(created.status, 200, created.text);
  }

  async function admin(): Promise<Api> {
    const api = new Api();
    const logged = await api.fetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account: 'admin@example.com', password: 'Admin-pass-123' }),
    });
    assert.equal(logged.status, 200, logged.text);
    return api;
  }

  async function openProduct(api: Api) {
    seq += 1;
    const round = await api.fetch('/api/admin/rounds', { method: 'POST', body: JSON.stringify({ name: `轮次${seq}` }) });
    assert.equal(round.status, 200, round.text);
    const batch = await api.fetch('/api/admin/batches', {
      method: 'POST',
      body: JSON.stringify({
        roundId: round.data.round.id,
        name: '第一批',
        description: '说明',
        opensAt: new Date(Date.now() - 3600_000).toISOString(),
        startClosesAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
        durationHours: 24,
        status: 'OPEN',
      }),
    });
    assert.equal(batch.status, 200, batch.text);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const boundary = '----labboundary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await api.fetch('/api/admin/attachments', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    assert.equal(uploaded.status, 200, uploaded.text);
    const question = await api.fetch('/api/admin/questions', {
      method: 'POST',
      body: JSON.stringify({
        batchId: batch.data.batch.id,
        direction: 'PRODUCT',
        title: `题目${seq}`,
        content: '题干',
        published: true,
        attachmentIds: [uploaded.data.attachment.id],
      }),
    });
    assert.equal(question.status, 200, question.text);
    return batch.data.batch.id as string;
  }

  async function enroll(api: Api, batchId: string, consent: boolean) {
    const enrolled = await api.fetch('/api/enrollments', {
      method: 'POST',
      body: JSON.stringify({ batchId, direction: 'PRODUCT' }),
    });
    assert.equal(enrolled.status, 200, enrolled.text);
    const id = enrolled.data.enrollment.id as string;
    if (consent) {
      const accepted = await api.fetch(`/api/enrollments/${id}/consent`, {
        method: 'POST',
        body: JSON.stringify({ version: 'assessment-consent-v1', accepted: true }),
      });
      assert.equal(accepted.status, 200, accepted.text);
    }
    return id;
  }

  async function beginConsent(api: Api, clientId: string, redirectUri: string, challenge: string, state: string): Promise<string> {
    const started = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      scope: 'assessment',
      resource: `${base}/mcp`,
    }, api.cookieHeader());
    const text = await started.text();
    assert.equal(started.status, 302, text);
    const flow = cookiePair(started, 'lab_oauth_flow');
    api.setCookie('lab_oauth_flow', flow);
    const location = new URL(started.headers.get('location') ?? '', base);
    assert.equal(`${location.origin}${location.pathname}`, `${base}/mcp/connect`);
    const requestId = location.searchParams.get('request');
    assert.ok(requestId);
    return requestId;
  }

  async function issueCode(api: Api, clientId: string, redirectUri: string, enrollmentId: string) {
    const { verifier, challenge } = pkcePair();
    const state = `s${randomBytes(6).toString('hex')}`;
    const requestId = await beginConsent(api, clientId, redirectUri, challenge, state);
    const decision = await api.fetch(`/api/oauth/requests/${requestId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ approved: true, enrollmentId }),
    });
    assert.equal(decision.status, 200, decision.text);
    const redirect = new URL(decision.data.redirectUrl as string);
    assert.equal(redirect.searchParams.get('state'), state);
    assert.equal(redirect.searchParams.get('error'), null);
    const code = redirect.searchParams.get('code');
    assert.ok(code);
    assert.equal(redirect.origin + redirect.pathname, new URL(redirectUri).origin + new URL(redirectUri).pathname);
    return { verifier, code, requestId };
  }

  function exchange(clientId: string, redirectUri: string, code: string, verifier: string, resource?: string) {
    const params: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
    };
    if (resource !== undefined) params.resource = resource;
    return postToken(params);
  }

  async function freePort(): Promise<number> {
    const probe = createNetServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => resolve());
    });
    const address = probe.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    if (!port) throw new Error('no port');
    return port;
  }

  describe('oauth integration', { concurrency: 1, timeout: 120_000 }, () => {
    before(async () => {
      if (!/^oauth_[0-9]+_[0-9a-f]{4}$/.test(schema)) throw new Error('refusing unsafe test schema');
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      mcpUrl = new URL('/mcp', base);
      storage = await mkdtemp(path.join(tmpdir(), 'lab-oauth-'));
      process.env.DATABASE_URL = databaseUrl;
      process.env.DB_SCHEMA = schema;
      process.env.NODE_ENV = 'test';
      process.env.APP_ORIGIN = base;
      process.env.PUBLIC_BASE_URL = base;
      process.env.SESSION_SECRET = 'test-session-secret-32chars-minimum';
      process.env.MAIL_TEST_SINK = 'true';
      process.env.ADMIN_EMAIL = 'admin@example.com';
      process.env.ADMIN_PASSWORD = 'Admin-pass-123';
      process.env.ADMIN_NAME = '管理员';
      process.env.STORAGE_DIR = storage;
      delete process.env.SEED_DEMO;
      delete process.env.SMTP_HOST;
      const prep = new Pool({ connectionString: databaseUrl });
      await prep.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await prep.end();
      ctx = await createContext();
      server = createServer(createApp(ctx));
      server.listen(port, '127.0.0.1');
      await once(server, 'listening');
    });

    after(async () => {
      if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
      if (ctx) await closeContext(ctx);
      if (databaseUrl && /^oauth_[0-9]+_[0-9a-f]{4}$/.test(schema)) {
        const prep = new Pool({ connectionString: databaseUrl });
        await prep.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await prep.end();
      }
      if (storage) await rm(storage, { recursive: true, force: true });
    });

    beforeEach(async () => {
      // Each case gets fresh middleware/rate-limit stores as well as fresh data.
      server.removeAllListeners('request');
      server.on('request', createApp(ctx));
      await ctx.pool.query(`TRUNCATE registration_challenges, registration_buckets, users, sessions, email_challenges, rate_limits, rounds, batches, attachments,
        questions, question_attachments, question_versions, enrollments, mcp_tokens, repository_previews,
        repositories, material_approvals, materials, finalize_receipts, reviews, audit_events, email_outbox,
        oauth_clients, oauth_requests, oauth_codes, oauth_grants, oauth_access_tokens, oauth_refresh_tokens
        RESTART IDENTITY CASCADE`);
      await bootstrapAdmin(ctx.pool, {
        adminEmail: 'admin@example.com',
        adminPassword: 'Admin-pass-123',
        adminName: '管理员',
        databaseUrl: databaseUrl ?? '',
      });
    });

    test('discovers metadata and rejects unsafe dynamic registration', async () => {
      const resource = await readJson(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`, {
        headers: { accept: 'application/json' },
      }));
      assert.equal(resource.status, 200, resource.text);
      assert.equal(resource.data.resource, `${base}/mcp`);
      assert.deepEqual(resource.data.authorization_servers, [base]);
      assert.deepEqual(resource.data.scopes_supported, ['assessment']);
      assert.equal(resource.data.resource_name, '110 实验室考核');

      const metadata = await readJson(await fetch(`${base}/.well-known/oauth-authorization-server`, {
        headers: { accept: 'application/json' },
      }));
      assert.equal(metadata.status, 200, metadata.text);
      assert.equal(metadata.data.issuer, base);
      assert.equal(metadata.data.authorization_endpoint, `${base}/oauth/authorize`);
      assert.equal(metadata.data.token_endpoint, `${base}/oauth/token`);
      assert.equal(metadata.data.registration_endpoint, `${base}/oauth/register`);
      assert.equal(metadata.data.revocation_endpoint, `${base}/oauth/revoke`);
      assert.deepEqual(metadata.data.code_challenge_methods_supported, ['S256']);
      assert.deepEqual(metadata.data.token_endpoint_auth_methods_supported, ['none']);
      assert.deepEqual(metadata.data.grant_types_supported, ['authorization_code', 'refresh_token']);
      assert.deepEqual(metadata.data.scopes_supported, ['assessment']);

      const unauthenticated = await mcpPost();
      assert.equal(unauthenticated.status, 401);
      assert.match(unauthenticated.www, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
      assert.match(unauthenticated.www, /scope="assessment"/);

      const rejectedRedirects = [
        publicClient(['http://203.0.113.10/callback']),
        publicClient(['http://user:pass@127.0.0.1/callback']),
        publicClient(['https://agent.example/cb#frag']),
        publicClient(['workbuddy://workbuddy/mcp/custom-mcp%3A110-lab-assessment/oauth/callback']),
      ];
      for (const body of rejectedRedirects) {
        const failed = await registerClient(body);
        assert.equal(failed.status, 400, failed.text);
        assert.equal(failed.data.error, 'invalid_redirect_uri');
      }
      const rejected = [
        publicClient(['https://agent.example/callback'], { token_endpoint_auth_method: 'client_secret_basic' }),
        publicClient(['https://agent.example/callback'], { scope: 'openid' }),
        publicClient(['https://agent.example/callback'], { grant_types: ['authorization_code', 'client_credentials'] }),
        publicClient([]),
        publicClient(Array.from({ length: 6 }, (_, index) => `https://agent.example/cb/${index}`)),
      ];
      for (const body of rejected) {
        const failed = await registerClient(body);
        assert.equal(failed.status, 400, failed.text);
        assert.equal(failed.data.error, 'invalid_client_metadata');
      }

      const created = await registerClient(publicClient(['http://127.0.0.1:9/callback']));
      assert.equal(created.status, 201, created.text);
      assert.equal(typeof created.data.client_id, 'string');
      assert.equal(created.data.client_secret, undefined);
      assert.equal(created.data.token_endpoint_auth_method, 'none');
      assert.equal(created.data.scope, 'assessment');
    });

    test('native fallback completes OAuth and reconnects with a new loopback port', async () => {
      const root = await admin();
      const batchId = await openProduct(root);
      const candidate = new Api();
      await register(candidate, 'oauth-loopback@example.com', '20261011');
      const enrollmentId = await enroll(candidate, batchId, true);
      const rejected = await registerClient(publicClient(['workbuddy://workbuddy/mcp/custom-mcp%3A110-lab-assessment/oauth/callback']));
      assert.equal(rejected.status, 400, rejected.text);
      assert.equal(rejected.data.error, 'invalid_redirect_uri');
      assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM oauth_clients')).rows[0]?.n, 0);

      for (const host of ['127.0.0.1', '[::1]', 'localhost']) {
        const registered = `http://${host}/oauth/callback?client=exam`;
        const created = await registerClient(publicClient([registered]));
        assert.equal(created.status, 201, created.text);
        const clientId = created.data.client_id as string;
        for (const port of [49152, 49153]) {
          const callback = `http://${host}:${port}/oauth/callback?client=exam`;
          const issued = await issueCode(candidate, clientId, callback, enrollmentId);
          const wrongPort = await exchange(clientId, `http://${host}:${port + 1}/oauth/callback?client=exam`, issued.code, issued.verifier, `${base}/mcp`);
          assert.equal(wrongPort.status, 400, wrongPort.text);
          assert.equal(wrongPort.data.error, 'invalid_grant');
          const wrongVerifier = await exchange(clientId, callback, issued.code, 'x'.repeat(43), `${base}/mcp`);
          assert.equal(wrongVerifier.status, 400, wrongVerifier.text);
          assert.equal(wrongVerifier.data.error, 'invalid_grant');
          const tokens = await exchange(clientId, callback, issued.code, issued.verifier, `${base}/mcp`);
          assert.equal(tokens.status, 200, tokens.text);
          const replay = await exchange(clientId, callback, issued.code, issued.verifier, `${base}/mcp`);
          assert.equal(replay.status, 400, replay.text);
          assert.equal(replay.data.error, 'invalid_grant');
          const refreshed = await postToken({ grant_type: 'refresh_token', client_id: clientId, refresh_token: tokens.data.refresh_token, resource: `${base}/mcp` });
          assert.equal(refreshed.status, 200, refreshed.text);
          const client = await openClient(new BearerProvider(refreshed.data.access_token as string, callback));
          try {
            const probe = JSON.parse(toolText(await client.callTool({ name: 'test_connection', arguments: {} }))) as Json;
            assert.equal(probe.ok, true);
            const status = JSON.parse(toolText(await client.callTool({ name: 'exam_status', arguments: {} }))) as Json;
            assert.equal(status.enrollment.id, enrollmentId);
            assert.equal(status.enrollment.state, 'READY');
            assert.equal(status.enrollment.startedAt, null);
            assert.equal(status.enrollment.materials, null);
          } finally { await client.close(); }
        }
      }
      // A new port reuses registration; no client row is silently rewritten.
      assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM oauth_clients')).rows[0]?.n, 3);
    });

    test('authorization port flexibility rejects all other callback changes without redirecting', async () => {
      const created = await registerClient(publicClient([
        'http://127.0.0.1:1111/oauth/callback?client=exam',
        'https://127.0.0.1:1111/callback',
        'https://agent.example/callback',
      ]));
      assert.equal(created.status, 201, created.text);
      const query = {
        client_id: created.data.client_id as string, response_type: 'code',
        code_challenge: pkcePair().challenge, code_challenge_method: 'S256', resource: `${base}/mcp`,
      };
      for (const uri of [
        'http://localhost:2222/oauth/callback?client=exam',
        'http://[::1]:2222/oauth/callback?client=exam',
        'http://127.0.0.1.evil.example:2222/oauth/callback?client=exam',
        'http://2130706433:2222/oauth/callback?client=exam',
        'http://127.0.0.1:2222/oauth/other?client=exam',
        'http://127.0.0.1:2222/other/../oauth/callback?client=exam',
        'http://127.0.0.1:2222/oauth/callback?client=other',
        'http://127.0.0.1:2222/oauth/callback?client=exam#fragment',
        'http://user:pass@127.0.0.1:2222/oauth/callback?client=exam',
        'https://127.0.0.1:2222/callback',
        'https://agent.example:8443/callback',
      ]) {
        for (const method of ['GET', 'POST']) {
          const params = { ...query, redirect_uri: uri };
          const response = method === 'GET' ? await authorize(params) : await fetch(`${base}/oauth/authorize`, {
            method, redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params),
          });
          assert.equal(response.headers.get('location'), null, uri);
          const failed = await readJson(response);
          assert.equal(failed.status, 400, `${uri}: ${failed.text}`);
          assert.equal(failed.data.error, 'invalid_request');
        }
      }
      assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM oauth_requests')).rows[0]?.n, 0);
    });

    test('requires S256 and the assessment resource and scope', async () => {
      const root = await admin();
      const batchId = await openProduct(root);
      const candidate = new Api();
      await register(candidate, 'oauth-pkce@example.com', '20261001');
      const enrollmentId = await enroll(candidate, batchId, true);
      const redirectUri = 'http://127.0.0.1:1111/callback';
      const created = await registerClient(publicClient([redirectUri, 'https://agent.example/callback']));
      assert.equal(created.status, 201, created.text);
      const clientId = created.data.client_id as string;
      const { verifier, challenge } = pkcePair();
      const baseQuery = {
        response_type: 'code',
        client_id: clientId,
        code_challenge: challenge,
        state: 'pkce-state',
      };

      const otherPort = await authorize({
        ...baseQuery,
        redirect_uri: 'http://127.0.0.1:2222/callback',
        code_challenge_method: 'S256',
        scope: 'assessment',
        resource: `${base}/mcp`,
      });
      assert.equal(otherPort.status, 302);
      assert.ok((otherPort.headers.get('location') ?? '').startsWith(`${base}/mcp/connect?request=`));
      await otherPort.body?.cancel();

      const mismatched = await authorize({
        ...baseQuery,
        redirect_uri: 'https://agent.example/other',
        code_challenge_method: 'S256',
        resource: `${base}/mcp`,
      });
      const mismatchedBody = await readJson(mismatched);
      assert.equal(mismatchedBody.status, 400, mismatchedBody.text);
      assert.equal(mismatchedBody.data.error, 'invalid_request');

      const plain = await authorize({
        ...baseQuery,
        redirect_uri: 'https://agent.example/callback',
        code_challenge_method: 'plain',
        scope: 'assessment',
        resource: `${base}/mcp`,
      });
      assert.equal(plain.status, 302);
      const plainError = new URL(plain.headers.get('location') ?? '', 'https://agent.example');
      assert.equal(plainError.searchParams.get('error'), 'invalid_request');
      await plain.body?.cancel();

      const badScope = await authorize({
        ...baseQuery,
        redirect_uri: 'https://agent.example/callback',
        code_challenge_method: 'S256',
        scope: 'assessment profile',
        resource: `${base}/mcp`,
      });
      assert.equal(badScope.status, 302);
      assert.equal(new URL(badScope.headers.get('location') ?? '', 'https://agent.example').searchParams.get('error'), 'invalid_scope');
      await badScope.body?.cancel();

      const badResource = await authorize({
        ...baseQuery,
        redirect_uri: 'https://agent.example/callback',
        code_challenge_method: 'S256',
        scope: 'assessment',
        resource: 'https://evil.example/mcp',
      });
      assert.equal(badResource.status, 302);
      assert.equal(new URL(badResource.headers.get('location') ?? '', 'https://agent.example').searchParams.get('error'), 'invalid_target');
      await badResource.body?.cancel();

      const missingResource = await authorize({
        ...baseQuery,
        redirect_uri: 'https://agent.example/callback',
        code_challenge_method: 'S256',
        scope: 'assessment',
      });
      assert.equal(missingResource.status, 302);
      assert.equal(new URL(missingResource.headers.get('location') ?? '', 'https://agent.example').searchParams.get('error'), 'invalid_target');
      await missingResource.body?.cancel();

      const { code, verifier: issuedVerifier } = await issueCode(candidate, clientId, redirectUri, enrollmentId);
      const wrongVerifier = await exchange(clientId, redirectUri, code, 'x'.repeat(43), `${base}/mcp`);
      assert.equal(wrongVerifier.status, 400, wrongVerifier.text);
      assert.equal(wrongVerifier.data.error, 'invalid_grant');
      const missingOnExchange = await exchange(clientId, redirectUri, code, issuedVerifier);
      assert.equal(missingOnExchange.status, 400, missingOnExchange.text);
      assert.equal(missingOnExchange.data.error, 'invalid_target');
      const wrongResource = await exchange(clientId, redirectUri, code, issuedVerifier, 'https://evil.example/mcp');
      assert.equal(wrongResource.status, 400, wrongResource.text);
      assert.equal(wrongResource.data.error, 'invalid_target');
      const issued = await exchange(clientId, redirectUri, code, issuedVerifier, `${base}/mcp`);
      assert.equal(issued.status, 200, issued.text);
      assert.equal(issued.data.token_type, 'Bearer');
      assert.equal(issued.data.scope, 'assessment');
      assert.ok(issued.data.expires_in > 0 && issued.data.expires_in <= 900);
      assert.equal(typeof issued.data.refresh_token, 'string');
      assert.notEqual(issued.data.refresh_token, issued.data.access_token);
    });

    test('binds consent to the session, CSRF token, and initiating browser', async () => {
      const root = await admin();
      const ownBatch = await openProduct(root);
      const hiddenBatch = await openProduct(root);
      const otherBatch = await openProduct(root);
      const candidate = new Api();
      await register(candidate, 'oauth-consent@example.com', '20261002');
      const enrollmentId = await enroll(candidate, ownBatch, true);
      const hiddenId = await enroll(candidate, hiddenBatch, false);
      const other = new Api();
      await register(other, 'oauth-other@example.com', '20261003');
      const otherId = await enroll(other, otherBatch, true);
      const redirectUri = 'http://127.0.0.1:3333/callback';
      const created = await registerClient(publicClient([redirectUri]));
      assert.equal(created.status, 201, created.text);
      const clientId = created.data.client_id as string;
      const { challenge } = pkcePair();
      const requestId = await beginConsent(candidate, clientId, redirectUri, challenge, 'consent-state');

      const pending = await ctx.pool.query<{ resolved_at: Date | null; seconds: string }>(
        `SELECT resolved_at, extract(epoch FROM (expires_at - clock_timestamp()))::text AS seconds FROM oauth_requests WHERE id = $1`,
        [requestId],
      );
      assert.equal(pending.rows[0]?.resolved_at, null);
      const remaining = Number(pending.rows[0]?.seconds);
      assert.ok(remaining > 590 && remaining <= 600);

      const view = await candidate.fetch(`/api/oauth/requests/${requestId}`);
      assert.equal(view.status, 200, view.text);
      assert.equal(view.data.request.id, requestId);
      assert.equal(view.data.request.clientName, 'Test Agent');
      assert.equal(view.data.request.redirectOrigin, 'http://127.0.0.1:3333');
      assert.deepEqual(view.data.request.scopes, ['assessment']);
      assert.equal(view.data.request.code, undefined);
      assert.equal(JSON.stringify(view.data).includes(challenge), false);
      const listed = view.data.request.enrollments as Json[];
      assert.deepEqual(listed.map((item) => item.id), [enrollmentId]);
      assert.equal(listed[0]?.state, 'READY');
      assert.equal(listed[0]?.direction, 'PRODUCT');
      assert.equal(view.text.includes(hiddenId), false);
      assert.equal(view.text.includes(otherId), false);

      const stillPending = async () => {
        const row = await ctx.pool.query<{ resolved_at: Date | null }>('SELECT resolved_at FROM oauth_requests WHERE id = $1', [requestId]);
        assert.equal(row.rows[0]?.resolved_at, null);
      };

      const wrongOwner = await candidate.fetch(`/api/oauth/requests/${requestId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: true, enrollmentId: otherId }),
      });
      assert.equal(wrongOwner.status, 409, wrongOwner.text);
      assert.equal(wrongOwner.data.code, 'ENROLLMENT_UNAVAILABLE');
      const hidden = await candidate.fetch(`/api/oauth/requests/${requestId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: true, enrollmentId: hiddenId }),
      });
      assert.equal(hidden.status, 409, hidden.text);
      await stillPending();

      const savedCsrf = candidate.csrf;
      candidate.csrf = '';
      const missingCsrf = await candidate.fetch(`/api/oauth/requests/${requestId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: true, enrollmentId }),
      });
      assert.equal(missingCsrf.status, 403, missingCsrf.text);
      assert.equal(missingCsrf.data.code, 'CSRF');
      candidate.csrf = savedCsrf;

      const savedFlow = candidate.cookie('lab_oauth_flow');
      candidate.setCookie('lab_oauth_flow', randomBytes(32).toString('base64url'));
      const wrongBrowser = await candidate.fetch(`/api/oauth/requests/${requestId}`);
      assert.equal(wrongBrowser.status, 403, wrongBrowser.text);
      assert.equal(wrongBrowser.data.code, 'OAUTH_BROWSER');
      candidate.clearCookie('lab_oauth_flow');
      const missingBrowser = await candidate.fetch(`/api/oauth/requests/${requestId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: false }),
      });
      assert.equal(missingBrowser.status, 403, missingBrowser.text);
      assert.equal(missingBrowser.data.code, 'OAUTH_BROWSER');
      candidate.setCookie('lab_oauth_flow', savedFlow);

      const anon = new Api();
      anon.setCookie('lab_oauth_flow', savedFlow);
      const anonymous = await anon.fetch(`/api/oauth/requests/${requestId}`);
      assert.equal(anonymous.status, 401, anonymous.text);

      root.setCookie('lab_oauth_flow', savedFlow);
      const asAdmin = await root.fetch(`/api/oauth/requests/${requestId}`);
      assert.equal(asAdmin.status, 403, asAdmin.text);
      assert.equal(asAdmin.data.code, 'CANDIDATE_REQUIRED');

      const evil = await fetch(`${base}/api/oauth/requests/${requestId}/decision`, {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          cookie: candidate.cookieHeader(),
          'content-type': 'application/json',
          'x-csrf-token': candidate.csrf,
        },
        body: JSON.stringify({ approved: true, enrollmentId }),
      });
      assert.equal(evil.status, 403);
      await evil.body?.cancel();
      await stillPending();

      const approved = await candidate.fetch(`/api/oauth/requests/${requestId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: true, enrollmentId }),
      });
      assert.equal(approved.status, 200, approved.text);
      const approvedUrl = new URL(approved.data.redirectUrl as string);
      assert.equal(approvedUrl.searchParams.get('state'), 'consent-state');
      assert.ok(approvedUrl.searchParams.get('code'));
      const repeat = await candidate.fetch(`/api/oauth/requests/${requestId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: true, enrollmentId }),
      });
      assert.equal(repeat.status, 410, repeat.text);
      assert.equal(repeat.data.code, 'OAUTH_EXPIRED');

      const denialId = await beginConsent(candidate, clientId, redirectUri, pkcePair().challenge, 'deny-state');
      const denied = await candidate.fetch(`/api/oauth/requests/${denialId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: false }),
      });
      assert.equal(denied.status, 200, denied.text);
      const deniedUrl = new URL(denied.data.redirectUrl as string);
      assert.equal(deniedUrl.searchParams.get('error'), 'access_denied');
      assert.equal(deniedUrl.searchParams.get('state'), 'deny-state');
      assert.equal(deniedUrl.searchParams.get('code'), null);
      const deniedAgain = await candidate.fetch(`/api/oauth/requests/${denialId}`);
      assert.equal(deniedAgain.status, 410, deniedAgain.text);

      const fresh = await beginConsent(candidate, clientId, redirectUri, pkcePair().challenge, 'expired-state');
      await ctx.pool.query(`UPDATE oauth_requests SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1`, [fresh]);
      const expired = await candidate.fetch(`/api/oauth/requests/${fresh}`);
      assert.equal(expired.status, 410, expired.text);
      assert.equal(expired.data.code, 'OAUTH_EXPIRED');
    });

    test('rejects expired, replayed, and concurrent authorization codes', async () => {
      const root = await admin();
      const batchId = await openProduct(root);
      const candidate = new Api();
      await register(candidate, 'oauth-code@example.com', '20261004');
      const enrollmentId = await enroll(candidate, batchId, true);
      const redirectUri = 'http://127.0.0.1:4444/callback';
      const created = await registerClient(publicClient([redirectUri]));
      assert.equal(created.status, 201, created.text);
      const clientId = created.data.client_id as string;

      const first = await issueCode(candidate, clientId, redirectUri, enrollmentId);
      const lifetime = await ctx.pool.query<{ seconds: string }>(
        `SELECT extract(epoch FROM (expires_at - clock_timestamp()))::text AS seconds FROM oauth_codes WHERE request_id = $1`,
        [first.requestId],
      );
      const codeSeconds = Number(lifetime.rows[0]?.seconds);
      assert.ok(codeSeconds > 100 && codeSeconds <= 120);
      const mismatched = await exchange(clientId, 'http://127.0.0.1:4555/callback', first.code, first.verifier, `${base}/mcp`);
      assert.equal(mismatched.status, 400, mismatched.text);
      assert.equal(mismatched.data.error, 'invalid_grant');
      const issued = await exchange(clientId, redirectUri, first.code, first.verifier, `${base}/mcp`);
      assert.equal(issued.status, 200, issued.text);
      const replay = await exchange(clientId, redirectUri, first.code, first.verifier, `${base}/mcp`);
      assert.equal(replay.status, 400, replay.text);
      assert.equal(replay.data.error, 'invalid_grant');
      assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM oauth_grants')).rows[0]?.n, 1);

      const expired = await issueCode(candidate, clientId, redirectUri, enrollmentId);
      await ctx.pool.query(`UPDATE oauth_codes SET expires_at = clock_timestamp() - interval '1 second' WHERE request_id = $1`, [expired.requestId]);
      const expiredExchange = await exchange(clientId, redirectUri, expired.code, expired.verifier, `${base}/mcp`);
      assert.equal(expiredExchange.status, 400, expiredExchange.text);
      assert.equal(expiredExchange.data.error, 'invalid_grant');

      const concurrent = await issueCode(candidate, clientId, redirectUri, enrollmentId);
      const [left, right] = await Promise.all([
        exchange(clientId, redirectUri, concurrent.code, concurrent.verifier, `${base}/mcp`),
        exchange(clientId, redirectUri, concurrent.code, concurrent.verifier, `${base}/mcp`),
      ]);
      const statuses = [left.status, right.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 400]);
      const loser = left.status === 400 ? left : right;
      assert.equal(loser.data.error, 'invalid_grant');
      assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM oauth_grants')).rows[0]?.n, 2);
      const winner = left.status === 200 ? left : right;
      const probe = await mcpPost(winner.data.access_token as string);
      assert.equal(probe.status, 200, probe.text);
      const third = await exchange(clientId, redirectUri, concurrent.code, concurrent.verifier, `${base}/mcp`);
      assert.equal(third.status, 400, third.text);
    });

    test('rotates refresh tokens and revokes the grant on replay', async () => {
      const root = await admin();
      const batchId = await openProduct(root);
      const candidate = new Api();
      await register(candidate, 'oauth-refresh@example.com', '20261005');
      const enrollmentId = await enroll(candidate, batchId, true);
      const redirectUri = 'http://127.0.0.1:5555/callback';
      const created = await registerClient(publicClient([redirectUri]));
      assert.equal(created.status, 201, created.text);
      const clientId = created.data.client_id as string;
      const issued = await issueCode(candidate, clientId, redirectUri, enrollmentId);
      const tokens = await exchange(clientId, redirectUri, issued.code, issued.verifier, `${base}/mcp`);
      assert.equal(tokens.status, 200, tokens.text);
      const original = tokens.data.refresh_token as string;

      const badScope = await postToken({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: original, scope: 'profile',
      });
      assert.equal(badScope.status, 400, badScope.text);
      assert.equal(badScope.data.error, 'invalid_scope');
      const badResource = await postToken({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: original, resource: 'https://evil.example/mcp',
      });
      assert.equal(badResource.status, 400, badResource.text);
      assert.equal(badResource.data.error, 'invalid_target');

      const withResource = await postToken({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: original, resource: `${base}/mcp`,
      });
      assert.equal(withResource.status, 200, withResource.text);
      const rotated = withResource.data.refresh_token as string;
      assert.notEqual(rotated, original);
      assert.notEqual(withResource.data.access_token, tokens.data.access_token);
      const omitted = await postToken({ grant_type: 'refresh_token', client_id: clientId, refresh_token: rotated });
      assert.equal(omitted.status, 200, omitted.text);
      const latest = omitted.data.refresh_token as string;
      assert.notEqual(latest, rotated);

      const replay = await postToken({ grant_type: 'refresh_token', client_id: clientId, refresh_token: rotated });
      assert.equal(replay.status, 400, replay.text);
      assert.equal(replay.data.error, 'invalid_grant');
      const revoked = await ctx.pool.query<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM oauth_grants');
      assert.equal(revoked.rows[0]?.revoked, true);
      assert.equal((await mcpPost(omitted.data.access_token as string)).status, 401);
      assert.equal((await mcpPost(withResource.data.access_token as string)).status, 401);
      const latestReplay = await postToken({ grant_type: 'refresh_token', client_id: clientId, refresh_token: latest });
      assert.equal(latestReplay.status, 400, latestReplay.text);
      assert.equal(latestReplay.data.error, 'invalid_grant');
    });

    test('revokes one grant without dropping the other, then clears the preflight flag', async () => {
      const root = await admin();
      const batchId = await openProduct(root);
      const candidate = new Api();
      await register(candidate, 'oauth-revoke@example.com', '20261006');
      const enrollmentId = await enroll(candidate, batchId, true);
      const redirectUri = 'http://127.0.0.1:6666/callback';
      const created = await registerClient(publicClient([redirectUri]));
      assert.equal(created.status, 201, created.text);
      const clientId = created.data.client_id as string;
      const firstCode = await issueCode(candidate, clientId, redirectUri, enrollmentId);
      const secondCode = await issueCode(candidate, clientId, redirectUri, enrollmentId);
      const first = await exchange(clientId, redirectUri, firstCode.code, firstCode.verifier, `${base}/mcp`);
      const second = await exchange(clientId, redirectUri, secondCode.code, secondCode.verifier, `${base}/mcp`);
      assert.equal(first.status, 200, first.text);
      assert.equal(second.status, 200, second.text);
      const client = await openClient(new BearerProvider(first.data.access_token as string, redirectUri));
      try {
        const probe = JSON.parse(toolText(await client.callTool({ name: 'test_connection', arguments: {} }))) as Json;
        assert.equal(probe.ok, true);
        assert.equal(probe.enrollmentId, enrollmentId);
      } finally {
        await client.close();
      }

      const listed = await candidate.fetch(`/api/enrollments/${enrollmentId}/connections`);
      assert.equal(listed.status, 200, listed.text);
      const connections = listed.data.connections as Json[];
      assert.equal(connections.length, 2);
      assert.equal(connections[0]?.clientName, 'Test Agent');
      assert.equal(typeof connections[0]?.id, 'string');
      assert.equal(typeof connections[0]?.createdAt, 'string');
      const stranger = new Api();
      await register(stranger, 'oauth-stranger@example.com', '20261007');
      const forbidden = await stranger.fetch(`/api/enrollments/${enrollmentId}/connections/${connections[0]?.id}`, { method: 'DELETE' });
      assert.equal(forbidden.status, 404, forbidden.text);
      const removed = await candidate.fetch(`/api/enrollments/${enrollmentId}/connections/${connections[0]?.id}`, { method: 'DELETE' });
      assert.equal(removed.status, 200, removed.text);
      assert.equal(removed.data.ok, true);
      const remaining = await candidate.fetch(`/api/enrollments/${enrollmentId}/connections`);
      assert.equal((remaining.data.connections as Json[]).length, 1);
      const afterOne = await candidate.fetch(`/api/enrollments/${enrollmentId}`);
      assert.equal(afterOne.data.enrollment.mcpConnected, true);
      const firstStatus = (await mcpPost(first.data.access_token as string)).status;
      const secondStatus = (await mcpPost(second.data.access_token as string)).status;
      assert.deepEqual([firstStatus, secondStatus].sort((left, right) => left - right), [200, 401]);
      const live = firstStatus === 200 ? first : second;

      const revoked = await postRevoke(clientId, live.data.refresh_token as string);
      assert.equal(revoked.status, 200, revoked.text);
      assert.equal((await mcpPost(second.data.access_token as string)).status, 401);
      assert.equal((await mcpPost(first.data.access_token as string)).status, 401);
      const empty = await candidate.fetch(`/api/enrollments/${enrollmentId}/connections`);
      assert.deepEqual(empty.data.connections, []);
      const cleared = await candidate.fetch(`/api/enrollments/${enrollmentId}`);
      assert.equal(cleared.data.enrollment.mcpConnected, false);
      const again = await postRevoke(clientId, second.data.refresh_token as string);
      assert.equal(again.status, 200, again.text);
    });

    test('rejects finalized and expired exams for access and refresh', async () => {
      const root = await admin();
      const activeBatch = await openProduct(root);
      const finalBatch = await openProduct(root);
      await ctx.pool.query('UPDATE batches SET duration_hours=48 WHERE id=$1', [activeBatch]);
      const candidate = new Api();
      await register(candidate, 'oauth-life@example.com', '20261008');
      const activeId = await enroll(candidate, activeBatch, true);
      const finalId = await enroll(candidate, finalBatch, true);
      const redirectUri = 'http://127.0.0.1:7777/callback';
      const created = await registerClient(publicClient([redirectUri]));
      assert.equal(created.status, 201, created.text);
      const clientId = created.data.client_id as string;

      const activeCode = await issueCode(candidate, clientId, redirectUri, activeId);
      const activeTokens = await exchange(clientId, redirectUri, activeCode.code, activeCode.verifier, `${base}/mcp`);
      assert.equal(activeTokens.status, 200, activeTokens.text);
      const connected = await openClient(new BearerProvider(activeTokens.data.access_token as string, redirectUri));
      try {
        assert.equal(JSON.parse(toolText(await connected.callTool({ name: 'test_connection', arguments: {} }))).ok, true);
      } finally {
        await connected.close();
      }
      const started = await candidate.fetch(`/api/enrollments/${activeId}/start`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, expectedDurationHours: 48 }),
      });
      assert.equal(started.status, 200, started.text);
      await ctx.pool.query("UPDATE batches SET status='CLOSED', start_closes_at=clock_timestamp()-interval '1 second' WHERE id=$1", [activeBatch]);
      const continued = await postToken({grant_type:'refresh_token',client_id:clientId,refresh_token:activeTokens.data.refresh_token as string});
      assert.equal(continued.status, 200, continued.text);
      assert.equal((await mcpPost(continued.data.access_token as string)).status, 200);
      await ctx.pool.query(`UPDATE enrollments SET deadline = clock_timestamp() - interval '1 second' WHERE id = $1`, [activeId]);
      assert.equal((await mcpPost(activeTokens.data.access_token as string)).status, 401);
      const expiredRefresh = await postToken({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: continued.data.refresh_token as string,
      });
      assert.equal(expiredRefresh.status, 400, expiredRefresh.text);
      assert.equal(expiredRefresh.data.error, 'invalid_grant');

      const finalCode = await issueCode(candidate, clientId, redirectUri, finalId);
      const finalTokens = await exchange(clientId, redirectUri, finalCode.code, finalCode.verifier, `${base}/mcp`);
      assert.equal(finalTokens.status, 200, finalTokens.text);
      const finalClient = await openClient(new BearerProvider(finalTokens.data.access_token as string, redirectUri));
      try { assert.ok(!(await finalClient.callTool({name:'test_connection', arguments:{}})).isError); }
      finally { await finalClient.close(); }
      const finalStart = await candidate.fetch(`/api/enrollments/${finalId}/start`, {method:'POST',body:JSON.stringify({confirmed:true,expectedDurationHours:24})});
      assert.equal(finalStart.status,200,finalStart.text);
      await ctx.pool.query(`UPDATE enrollments SET finalized_at = clock_timestamp() WHERE id = $1`, [finalId]);
      assert.equal((await mcpPost(finalTokens.data.access_token as string)).status, 401);
      const finalRefresh = await postToken({
        grant_type: 'refresh_token', client_id: clientId, refresh_token: finalTokens.data.refresh_token as string, resource: `${base}/mcp`,
      });
      assert.equal(finalRefresh.status, 400, finalRefresh.text);
      assert.equal(finalRefresh.data.error, 'invalid_grant');
    });

    test('keeps legacy bearer MCP working and ignores the browser session', async () => {
      const root = await admin();
      const batchId = await openProduct(root);
      const candidate = new Api();
      await register(candidate, 'oauth-legacy@example.com', '20261009');
      const enrollmentId = await enroll(candidate, batchId, true);
      const legacy = await candidate.fetch(`/api/enrollments/${enrollmentId}/mcp-token`, { method: 'POST', body: '{}' });
      assert.equal(legacy.status, 200, legacy.text);
      const legacyToken = legacy.data.token as string;
      const callback = 'http://127.0.0.1:8888/callback';
      const legacyClient = await openClient(new BearerProvider(legacyToken, callback));
      try {
        const tools = await legacyClient.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === 'test_connection'));
        const probe = JSON.parse(toolText(await legacyClient.callTool({ name: 'test_connection', arguments: {} }))) as Json;
        assert.equal(probe.mcpConnected, true);
        assert.equal(probe.enrollmentId, enrollmentId);
      } finally {
        await legacyClient.close();
      }

      const cookieOnly = await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          cookie: candidate.cookieHeader(),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'oauth-test', version: '0' } },
        }),
      });
      assert.equal(cookieOnly.status, 401);
      assert.match(cookieOnly.headers.get('www-authenticate') ?? '', /oauth-protected-resource/);
      await cookieOnly.body?.cancel();

      const created = await registerClient(publicClient([callback]));
      assert.equal(created.status, 201, created.text);
      const clientId = created.data.client_id as string;
      const code = await issueCode(candidate, clientId, callback, enrollmentId);
      const oauthTokens = await exchange(clientId, callback, code.code, code.verifier, `${base}/mcp`);
      assert.equal(oauthTokens.status, 200, oauthTokens.text);
      assert.equal((await mcpPost(legacyToken)).status, 200);
      assert.equal((await mcpPost(oauthTokens.data.access_token as string)).status, 200);
      const connections = await candidate.fetch(`/api/enrollments/${enrollmentId}/connections`);
      assert.equal((connections.data.connections as Json[]).length, 1);

      const rotated = await candidate.fetch(`/api/enrollments/${enrollmentId}/mcp-token`, { method: 'POST', body: '{}' });
      assert.equal(rotated.status, 200, rotated.text);
      assert.equal((await mcpPost(legacyToken)).status, 401);
      assert.equal((await mcpPost(oauthTokens.data.access_token as string)).status, 401);
      const replacement = await openClient(new BearerProvider(rotated.data.token as string, callback));
      try {
        const tools = await replacement.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === 'exam_status'));
      } finally {
        await replacement.close();
      }
    });

    test('completes the official SDK OAuth handshake and calls MCP tools', async () => {
      const root = await admin();
      const firstBatch = await openProduct(root);
      const secondBatch = await openProduct(root);
      const candidate = new Api();
      await register(candidate, 'oauth-sdk@example.com', '20261010');
      const firstId = await enroll(candidate, firstBatch, true);
      const secondId = await enroll(candidate, secondBatch, true);
      const callback = 'http://127.0.0.1:9999/callback';
      const provider = new TestOAuthProvider(callback);
      const redirected = await auth(provider, { serverUrl: mcpUrl });
      assert.equal(redirected, 'REDIRECT');
      const authorizationUrl = provider.authorizationUrl;
      assert.ok(authorizationUrl);
      assert.equal(authorizationUrl.origin, base);
      assert.equal(authorizationUrl.pathname, '/oauth/authorize');
      assert.equal(authorizationUrl.searchParams.get('response_type'), 'code');
      assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorizationUrl.searchParams.get('scope'), 'assessment');
      assert.equal(authorizationUrl.searchParams.get('resource'), `${base}/mcp`);
      assert.equal(authorizationUrl.searchParams.get('redirect_uri'), callback);
      assert.equal(authorizationUrl.searchParams.get('state'), provider.stateValue);
      assert.match(authorizationUrl.searchParams.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
      const clientId = provider.clientInformation()?.client_id;
      assert.equal(authorizationUrl.searchParams.get('client_id'), clientId);

      const started = await fetch(authorizationUrl, { redirect: 'manual' });
      assert.equal(started.status, 302);
      candidate.setCookie('lab_oauth_flow', cookiePair(started, 'lab_oauth_flow'));
      const requestId = new URL(started.headers.get('location') ?? '', base).searchParams.get('request');
      assert.ok(requestId);
      await started.body?.cancel();
      const view = await candidate.fetch(`/api/oauth/requests/${requestId}`);
      assert.equal(view.status, 200, view.text);
      const ids = (view.data.request.enrollments as Json[]).map((item) => item.id).sort();
      assert.deepEqual(ids, [firstId, secondId].sort());
      const unresolved = await ctx.pool.query('SELECT resolved_at FROM oauth_requests WHERE id = $1', [requestId]);
      assert.equal(unresolved.rows[0]?.resolved_at, null);

      const decision = await candidate.fetch(`/api/oauth/requests/${requestId}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approved: true, enrollmentId: firstId }),
      });
      assert.equal(decision.status, 200, decision.text);
      const redirectUrl = new URL(decision.data.redirectUrl as string);
      assert.equal(redirectUrl.searchParams.get('state'), provider.stateValue);
      const code = redirectUrl.searchParams.get('code');
      assert.ok(code);
      const authorized = await auth(provider, { serverUrl: mcpUrl, authorizationCode: code });
      assert.equal(authorized, 'AUTHORIZED');
      const tokens = provider.tokens();
      assert.equal(tokens?.token_type, 'Bearer');
      assert.equal(tokens?.scope, 'assessment');
      assert.equal(typeof tokens?.access_token, 'string');
      assert.equal(typeof tokens?.refresh_token, 'string');

      const client = await openClient(provider);
      try {
        const tools = await client.listTools();
        const names = tools.tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, ['exam_status', 'submit_materials', 'test_connection']);
        const probe = JSON.parse(toolText(await client.callTool({ name: 'test_connection', arguments: {} }))) as Json;
        assert.equal(probe.ok, true);
        assert.equal(probe.enrollmentId, firstId);
        const status = JSON.parse(toolText(await client.callTool({ name: 'exam_status', arguments: {} }))) as Json;
        assert.equal(status.enrollment.id, firstId);
        assert.notEqual(status.enrollment.id, secondId);
      } finally {
        await client.close();
      }

      const startedExam = await candidate.fetch(`/api/enrollments/${firstId}/start`, {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, expectedDurationHours: 24 }),
      });
      assert.equal(startedExam.status, 200, startedExam.text);
      assert.match(startedExam.data.enrollment.question.title, /^题目/);
      const connections = await candidate.fetch(`/api/enrollments/${firstId}/connections`);
      assert.equal((connections.data.connections as Json[]).length, 1);
      assert.equal(connections.data.connections[0]?.clientName, '考核代理');
      assert.equal(typeof connections.data.connections[0]?.lastUsedAt, 'string');
      const otherConnections = await candidate.fetch(`/api/enrollments/${secondId}/connections`);
      assert.deepEqual(otherConnections.data.connections, []);
    });
  });
}
