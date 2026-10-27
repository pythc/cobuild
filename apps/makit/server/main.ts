import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { join } from 'path';
import { __express as hbsExpressEngine } from 'hbs';

import type { NestExpressApplication } from '@nestjs/platform-express';
async function bootstrap() {
  // The retired deployment must not construct any old module or worker. Its
  // maintenance mode freezes all business writes before the final export.
  if (process.env.MAKIT_MANAGED_RETIRED === 'true') {
    const { startManagedRetirement } = await import('./managed-retirement');
    await startManagedRetirement();
    return;
  }
  const { configureApp } = await import('@lark-apaas/fullstack-nestjs-core');
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    abortOnError: process.env.NODE_ENV !== 'development',
  });
  await configureApp(app, {
    disableSwagger: true,
    // Relay sends up to 6 MiB of attachments as base64 JSON. Keep a bounded
    // parser limit above that envelope instead of the SDK's default 1 MiB.
    bodyLimit: '9mb',
  });
  const logger = new Logger('Bootstrap');
  const host = process.env.SERVER_HOST || 'localhost';
  const port = Number(process.env.SERVER_PORT || '3000');

  // 注册视图引擎, 渲染 client 目录下的 html 文件
  app.setBaseViewsDir(join(process.cwd(), 'dist/client'));
  app.setViewEngine('html');
  app.engine('html', hbsExpressEngine);

  await app.listen(port, host);
  logger.log(`Server running on ${host}:${port}`);
  logger.log(`API endpoints ready at http://${host}:${port}/api`);
}

bootstrap();
