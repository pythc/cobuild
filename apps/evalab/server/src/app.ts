import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type Express } from 'express';
import type { AppContext } from './context.js';
import { cors, csrfGuard, errorHandler, originGuard, securityHeaders, sessionLoader } from './http.js';
import { apiRouter } from './routes.js';
import { registerOAuthPublic, oauthBrowserRouter } from './oauth.js';
import { registerMaterialUploads } from './uploads.js';
import { registerMcp } from './mcp.js';
import { registerPublicIdentity } from './publicIdentity.js';

export function createApp(ctx: AppContext): Express {
  const primary = createSingleOriginApp(ctx);
  if (!ctx.config.legacyAppOrigins?.length) return primary;
  const legacyApps = new Map<string, Express>();
  for (const origin of ctx.config.legacyAppOrigins) {
    // Preserve non-enumerable secrets; a spread of config would silently drop them.
    const config = Object.create(Object.getPrototypeOf(ctx.config), Object.getOwnPropertyDescriptors(ctx.config));
    config.appOrigin = origin;
    config.publicBaseUrl = origin;
    config.legacyAppOrigins = [];
    legacyApps.set(new URL(origin).host.toLowerCase(), createSingleOriginApp({ ...ctx, config }));
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Only configured Host values select a legacy origin. Never derive OAuth URLs
    // from arbitrary Host or X-Forwarded-Host values. Other hosts use the primary
    // app, including the internal container health probe.
    const originApp = legacyApps.get((req.headers.host ?? '').toLowerCase()) ?? primary;
    originApp(req, res, next);
  });
  return app;
}

function createSingleOriginApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  if (ctx.config.trustProxy) app.set('trust proxy', 1);
  app.use(securityHeaders(ctx));
  registerPublicIdentity(app, ctx);
  registerOAuthPublic(app, ctx);
  registerMcp(app, ctx);
  registerMaterialUploads(app, ctx);
  app.use(cors(ctx));
  app.use(originGuard(ctx));
  app.use('/api', express.json({ limit: '1mb' }));
  app.use(sessionLoader(ctx));
  app.use(csrfGuard);
  app.use('/api', apiRouter(ctx));
  app.use('/api', oauthBrowserRouter(ctx));
  if (ctx.config.nodeEnv !== 'test') {
    const clientDist = path.resolve(process.env.CLIENT_DIST?.trim() || path.join(process.cwd(), '../client/dist'));
    if (existsSync(path.join(clientDist, 'index.html'))) {
      app.use(express.static(clientDist, { index: false, fallthrough: true }));
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        if (req.path.startsWith('/api') || (req.path.startsWith('/mcp') && req.path !== '/mcp/connect')) return next();
        res.sendFile(path.join(clientDist, 'index.html'), (error) => {
          if (error) next();
        });
      });
    }
  }
  app.use(errorHandler);
  return app;
}
