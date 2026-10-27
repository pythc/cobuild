import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from './config.js';
import { parseEmbeddingOrigins } from './embedding.js';
import { createApp } from './app.js';
import { createContext, closeContext } from './context.js';

const sandbox = 'codex-sandbox://mcp-app-fixture.web-sandbox.oaiusercontent.com';
const appOrigin = 'https://assessment.example.test';
const env = {DATABASE_URL: 'postgres://localhost/fixture', NODE_ENV: 'test', APP_ORIGIN: appOrigin};

test('embedding is off by default and accepts only a bounded exact origin list over HTTPS', () => {
  assert.deepEqual(loadConfig(env).config.embeddingOrigins, []);
  assert.deepEqual(parseEmbeddingOrigins(`${sandbox}, ${appOrigin}, ${sandbox}`), [sandbox, appOrigin]);
  for (const entry of ['*', 'https://*.example.test', 'http://example.test', 'https://a.test/path',
    'https://a.test?q=1', 'https://a.test#x', 'https://u:p@a.test', 'codex-sandbox://other.test',
    'https://a.test;script-src']) {
    assert.throws(() => parseEmbeddingOrigins(entry), entry);
  }
  assert.throws(() => parseEmbeddingOrigins(Array.from({length: 9}, (_, i) => `https://a${i}.test`).join(',')));
  assert.throws(() => loadConfig({...env, EMBEDDING_ORIGINS: sandbox, COOKIE_SECURE: 'false'}));
  assert.throws(() => loadConfig({...env, APP_ORIGIN: 'http://localhost', EMBEDDING_ORIGINS: sandbox}));
});

test('embedded login has a separate partitioned session and preserves origin, CSRF, and ordinary sessions',
  {skip: !process.env.TEST_DATABASE_URL && 'needs a disposable PostgreSQL database', timeout: 30_000}, async () => {
    const databaseUrl = process.env.TEST_DATABASE_URL!;
    const schema = `assessment_embed_${process.pid}`;
    const storage = await mkdtemp(path.join(tmpdir(), 'assessment-embed-'));
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl, DB_SCHEMA: schema, NODE_ENV: 'test',
      APP_ORIGIN: appOrigin, PUBLIC_BASE_URL: appOrigin, COOKIE_SECURE: 'true',
      EMBEDDING_ORIGINS: sandbox, SESSION_SECRET: 'fictional-fixture-secret-with-32-characters',
      MAIL_TEST_SINK: 'true', ADMIN_EMAIL: 'fixture@example.test', ADMIN_PASSWORD: 'Fictional-fixture-123',
      STORAGE_DIR: storage,
    });
    delete process.env.SMTP_HOST;
    delete process.env.SEED_DEMO;
    const ctx = await createContext();
    const server = createServer(createApp(ctx));
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const request = (pathname: string, init: RequestInit = {}) => fetch(base + pathname, {
        ...init, headers: {origin: appOrigin, 'content-type': 'application/json', ...init.headers},
      });
      const body = JSON.stringify({account: 'fixture@example.test', password: 'Fictional-fixture-123'});
      const normal = await request('/api/auth/login', {method: 'POST', body});
      assert.equal(normal.status, 200);
      const normalCookie = normal.headers.getSetCookie()[0]!;
      assert.match(normalCookie, /^lab_session=/);
      assert.match(normalCookie, /SameSite=Lax/);
      assert.doesNotMatch(normalCookie, /Partitioned/);
      const regularToken = (await normal.json()).csrfToken;
      const embedded = await request('/api/auth/login', {method: 'POST', body, headers: {'x-lab-embedded': '1'}});
      assert.equal(embedded.status, 200);
      assert.match(embedded.headers.get('content-security-policy')!, new RegExp(`frame-ancestors ${sandbox.replaceAll('.', '\\.')}$`));
      assert.equal(embedded.headers.get('x-frame-options'), null);
      const embeddedCookie = embedded.headers.getSetCookie()[0]!;
      assert.match(embeddedCookie, /^lab_embedded_session=/);
      for (const attribute of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned']) assert.ok(embeddedCookie.includes(attribute));
      const embeddedToken = (await embedded.json()).csrfToken;
      const normalPair = normalCookie.split(';')[0]!;
      const embeddedPair = embeddedCookie.split(';')[0]!;
      assert.equal((await request('/api/auth/me', {headers: {cookie: normalPair, 'x-lab-embedded': '1'}})).status, 401);
      assert.equal((await request('/api/auth/me', {headers: {cookie: embeddedPair}})).status, 401);
      const valid = {cookie: embeddedPair, 'x-lab-embedded': '1'};
      assert.equal((await request('/api/auth/me', {headers: valid})).status, 200);
      assert.equal((await request('/api/auth/logout', {method: 'POST', body: '{}', headers: valid})).status, 403);
      assert.equal((await request('/api/auth/logout', {method: 'POST', body: '{}', headers: {...valid, 'x-csrf-token': regularToken}})).status, 403);
      assert.equal((await request('/api/auth/logout', {method: 'POST', body: '{}', headers: {...valid, 'x-csrf-token': embeddedToken, origin: 'https://untrusted.example.test'}})).status, 403);
      const logout = await request('/api/auth/logout', {method: 'POST', body: '{}', headers: {...valid, 'x-csrf-token': embeddedToken}});
      assert.equal(logout.status, 200);
      assert.match(logout.headers.getSetCookie()[0]!, /lab_embedded_session=;.*Max-Age=0; Secure; Partitioned/);
      assert.equal((await request('/api/auth/me', {headers: valid})).status, 401);
      assert.equal((await request('/api/auth/me', {headers: {cookie: normalPair}})).status, 200);
      ctx.config.embeddingOrigins = [];
      const disabled = await request('/api/auth/login', {method: 'POST', body, headers: {'x-lab-embedded': '1'}});
      assert.equal(disabled.status, 403);
      assert.equal(disabled.headers.get('x-frame-options'), 'DENY');
      assert.match(disabled.headers.get('content-security-policy')!, /frame-ancestors 'none'$/);
      // The deployed entrypoint has its own static HTML middleware. Exercise it
      // against the same isolated database so it cannot reintroduce DENY.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const entrypoint = fileURLToPath(new URL('../../runtime.mjs', import.meta.url));
      const child = spawn(process.execPath, [entrypoint], {
        cwd: path.dirname(entrypoint), env: {...process.env, PORT: String(address.port)},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('runtime readiness timeout')), 8_000);
          child.stdout.on('data', (chunk) => {
            if (String(chunk).includes('assessment-ready')) { clearTimeout(timer); resolve(); }
          });
          child.once('error', (error) => { clearTimeout(timer); reject(error); });
          child.once('exit', () => { clearTimeout(timer); reject(new Error('runtime exited: ' + stderr)); });
        });
        const html = await request('/');
        assert.equal(html.status, 200);
        assert.match(await html.text(), /<html/);
        assert.equal(html.headers.get('x-frame-options'), null);
        assert.ok(html.headers.get('content-security-policy')!.endsWith(`frame-ancestors ${sandbox}`));
        assert.match(html.headers.get('content-security-policy')!, /form-action 'self'/);
      } finally {
        if (child.exitCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
          try { await exited; } finally { clearTimeout(timer); }
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeContext(ctx);
      const pool = new Pool({connectionString: databaseUrl});
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
      await rm(storage, {recursive: true, force: true});
    }
  });
