// Express 4 is callable CommonJS; retain its shape in both managed tsc and Jest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import express = require('express');
import type { Request, Response } from 'express';

const TARGET = 'https://makit.110-lab.cn';
const PREFIX = '/app/app_17b6pxwde0x';
const REQUEST_HEADERS = ['accept', 'authorization', 'content-type', 'idempotency-key',
  'mcp-protocol-version', 'mcp-session-id', 'x-requirement-mcp-token', 'x-lab-identity-token',
  'x-relay-native-key', 'x-workflow-worker-token', 'x-github-delivery', 'x-github-event', 'x-hub-signature-256'];

/** No business modules, SDK, database, worker, or automatic mutation retry. */
export function managedRetirementApp(mode: string, forward: typeof fetch = fetch) {
  if (!['maintenance', 'forward'].includes(mode)) throw new Error('Explicit retirement mode required');
  const app = express();
  app.disable('x-powered-by');
  app.use(express.raw({ type: () => true, limit: '9mb' }));
  app.use(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const original = req.originalUrl.startsWith(PREFIX + '/') ? req.originalUrl.slice(PREFIX.length) : req.originalUrl;
    if (original === '/healthz') { res.json({ service: 'makit-retired-entry', mode, workers: false }); return; }
    if (mode === 'maintenance') {
      res.setHeader('Retry-After', '30');
      res.status(503).json({ message: '需求平台正在迁移，请稍后重试。' }); return;
    }
    // Only the fixed owned origin is used. A browser's old platform cookie and
    // platform identity headers must never establish native server identity.
    const destination = new URL(TARGET + original);
    if (destination.origin !== TARGET || /[\\\x00-\x1f]/u.test(original)) {
      res.status(400).json({ message: '请求地址无效' }); return;
    }
    if (!destination.pathname.startsWith('/openapi/')) {
      if (['GET', 'HEAD'].includes(req.method)) res.redirect(302, destination.href);
      else res.status(410).json({ message: '请重新打开需求平台后操作。', url: TARGET });
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === 'string') headers[name] = value;
    }
    try {
      const response = await forward(destination.href, { method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
        redirect: 'error', signal: AbortSignal.timeout(45000) });
      const chunks: Uint8Array[] = []; let size = 0;
      if (response.body) for await (const chunk of response.body) {
        if ((size += chunk.length) > 16 * 1024 * 1024) throw new Error('Response too large');
        chunks.push(chunk);
      }
      for (const name of ['content-type', 'mcp-session-id', 'retry-after']) {
        const value = response.headers.get(name); if (value) res.setHeader(name, value);
      }
      res.status(response.status).end(Buffer.concat(chunks));
    } catch {
      // A timeout may follow a successful core write. Preserve mutation IDs;
      // never retry here or turn an unknown result into a fresh operation.
      res.status(502).json({ message: '暂时无法连接需求平台；写入结果请使用原操作编号查询。' });
    }
  });
  return app;
}

export async function startManagedRetirement() {
  const app = managedRetirementApp(process.env.MAKIT_COMPATIBILITY_MODE || '');
  const port = Number(process.env.SERVER_PORT || '3000'), host = process.env.SERVER_HOST || 'localhost';
  return app.listen(port, host);
}
