import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  GitHubWebhookController,
  GitHubWebhookRawBodyInstaller,
} from '../../server/modules/pull-requests/github-webhook.openapi.controller';
import { GitHubWebhookService } from '../../server/modules/pull-requests/github-webhook.service';

describe('isolated callback HTTP parsing (no real app or providers)', () => {
  it('preserves original bytes under the configured app prefix before general JSON parsing', async () => {
    const old = process.env.CLIENT_BASE_PATH;
    process.env.CLIENT_BASE_PATH = '/app/test';
    const receive = jest
      .fn()
      .mockResolvedValue({ duplicate: false, queued: 0 });
    @Module({
      controllers: [GitHubWebhookController],
      providers: [
        GitHubWebhookRawBodyInstaller,
        { provide: GitHubWebhookService, useValue: { receive } },
      ],
    })
    class IsolatedWebhookModule {}
    const app = await NestFactory.create(IsolatedWebhookModule, {
      bodyParser: false,
      logger: false,
    });
    try {
      // Match real NestFactory lifecycle, before the SDK's generic JSON parser.
      app.setGlobalPrefix('/app/test');
      app.use(json());
      await app.listen(0, '127.0.0.1');
      const raw = '{ "hello" : "世界", "n": 1 }';
      const address = app.getHttpServer().address() as AddressInfo;
      const response = await new Promise<{ status: number; body: string }>(
        (resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port: address.port,
              path: '/app/test/api/github/webhook',
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(raw),
              },
            },
            (res) => {
              let body = '';
              res.on('data', (chunk) => (body += chunk));
              res.on('end', () => resolve({ status: res.statusCode!, body }));
            },
          );
          req.on('error', reject);
          req.end(raw);
        },
      );
      expect(response.status).toBe(200);
      expect(receive.mock.calls[0][0]).toEqual(Buffer.from(raw));
    } finally {
      await app.close();
      if (old === undefined) delete process.env.CLIENT_BASE_PATH;
      else process.env.CLIENT_BASE_PATH = old;
    }
  });
});
