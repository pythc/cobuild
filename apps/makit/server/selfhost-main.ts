// Dedicated entry point. The managed release entry remains available only for
// the pre-cutover service; selfhost builds replace its SDK DI imports locally.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { HttpException, Module, Logger, UnauthorizedException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded, static as serveStatic } from 'express';
import type { ErrorRequestHandler } from 'express';
import { join } from 'node:path';
import { __express as hbsExpressEngine } from 'hbs';
import { RequestContextService } from './common/selfhost/platform';
import { SelfhostPlatformModule } from './modules/selfhost/selfhost-platform.module';
import { DrizzleDatabaseManager } from './common/selfhost/database';
import { MakitWebModule } from './modules/selfhost/selfhost-web.module';
import { MakitAccessGuard } from './common/selfhost/access.guard';
import { MakitSessionService } from './common/selfhost/session.service';
import { RequirementsModule } from './modules/requirements/requirements.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PullRequestsModule } from './modules/pull-requests/pull-requests.module';
import { WorkspaceMcpModule } from './modules/workspace-mcp/workspace-mcp.module';
import { OperationsModule } from './modules/operations/operations.module';
import { WorkspaceViewsModule } from './modules/workspace-views/workspace-views.module';
import { OperationsTelemetryModule } from './modules/operations/operations-telemetry.module';
import { OperationsInsightsModule } from './modules/operations/operations-insights.module';
import { NotificationDeliveryApiModule } from './modules/notifications/notification-delivery-api.module';
import { ViewModule } from './modules/view/view.module';
import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { configureSuiteCollections, initializeSuiteCollections } from './common/selfhost/suite-collections';
import { gatewayAllowed } from './common/selfhost/gateway';

@Module({
  imports: [SelfhostPlatformModule, MakitWebModule, RequirementsModule, NotificationsModule,
    PullRequestsModule, WorkspaceMcpModule, OperationsModule, WorkspaceViewsModule,
    OperationsTelemetryModule, OperationsInsightsModule, NotificationDeliveryApiModule, ViewModule],
})
class MakitSelfhostModule {}

export async function startSelfhost() {
  if(process.env.COBUILD_IDENTITY_MODE==='local'&&process.env.COBUILD_MODULE_ENABLED!=='true')throw new Error('Makit module is disabled');
  if(process.env.COBUILD_IDENTITY_MODE==='local'&&(process.env.MAKIT_WORKERS_ENABLED!=='false'||process.env.MAKIT_EXTERNAL_WRITES_ENABLED!=='false'))throw new Error('Suite external workers and delivery are not configured');
  if (process.env.MAKIT_STORAGE !== 'postgres' || !['true', 'false'].includes(process.env.MAKIT_WORKERS_ENABLED || '')) {
    throw new Error('Explicit PostgreSQL and worker configuration required');
  }
  configureSuiteCollections();
  const app = await NestFactory.create<NestExpressApplication>(MakitSelfhostModule, { bodyParser: false });
  const database = app.get(DrizzleDatabaseManager);
  await database.assertRuntimeRole();
  await initializeSuiteCollections(database.client);
  const sessions = app.get(MakitSessionService), context = app.get(RequestContextService);
  app.use(json({ limit: '9mb', strict: true }));
  app.use(urlencoded({ limit: '32kb', extended: false }));
  app.use(async (req, res, next) => {
    try {
      if (!gatewayAllowed(req)) throw new UnauthorizedException('服务入口校验失败');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      // Drop inherited/forged platform fields. Only our HttpOnly session may
      // establish browser identity. Machine endpoints perform their own checks.
      delete req.userContext;
      const publicAsset = /^\/(assets|brand)\//.test(req.path) || ['/healthz', '/readyz', '/api/selfhost/config', '/auth/start', '/callback/110lab_requirements', '/callback/110lab_requirements/embedded'].includes(req.path);
      const user = !publicAsset && (req.path.startsWith('/api/') || !req.path.startsWith('/openapi/'))
        ? await sessions.authenticate(req) : null;
      const identity = user ? { userId: user.user_id, userName: user.name.zh_cn,
        roles: user.roles, appId: process.env.REQUIREMENT_PLATFORM_APP_ID, employeeId: user.employeeId } : {};
      req.userContext = identity;
      context.run(identity, () => next());
    } catch (error) { next(error); }
  });
  const middlewareError: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    res.status(status).json({ statusCode: status,
      message: error instanceof HttpException ? error.message : '服务暂时不可用，请稍后重试' });
  };
  app.use(middlewareError);
  app.useGlobalGuards(app.get(MakitAccessGuard));
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.use('/assets', serveStatic(join(process.cwd(), 'dist/client/assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
  app.use('/brand', serveStatic(join(process.cwd(), 'dist/client/brand'), { maxAge: '1h', fallthrough: false }));
  app.setBaseViewsDir(join(process.cwd(), 'dist/client'));
  app.setViewEngine('html'); app.engine('html', hbsExpressEngine);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.SERVER_PORT || '5450'), process.env.SERVER_HOST || '127.0.0.1');
  return app;
}
if (require.main === module) startSelfhost().catch(() => { new Logger('Bootstrap').error('Makit startup failed; see redacted diagnostics.'); process.exitCode = 1; });
