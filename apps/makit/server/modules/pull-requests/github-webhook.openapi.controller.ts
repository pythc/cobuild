import {
  Controller,
  Header,
  HttpCode,
  Injectable,
  Post,
  Req,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Public } from '@lark-apaas/fullstack-nestjs-core';
import { raw, type Request, type Response, type NextFunction } from 'express';
import { GitHubWebhookService } from './github-webhook.service';

export type GitHubRawRequest = Request & { githubRawBody?: Buffer };

/** Constructed during NestFactory.create, before configureApp installs its JSON parser. */
@Injectable()
export class GitHubWebhookRawBodyInstaller {
  constructor(adapterHost: HttpAdapterHost) {
    const prefix: string = (process.env.CLIENT_BASE_PATH || '').replace(
      /\/$/u,
      '',
    );
    let windowStart: number = Date.now();
    let received = 0;
    adapterHost.httpAdapter.use(
      [`${prefix}/openapi/github/webhook`, `${prefix}/api/github/webhook`],
      (_req: Request, res: Response, next: NextFunction): void => {
        if (Date.now() - windowStart >= 60000) {
          windowStart = Date.now();
          received = 0;
        }
        received += 1;
        if (received > 120) {
          res
            .status(429)
            .set('Retry-After', '60')
            .json({ message: '回调请求过于频繁' });
          return;
        }
        next();
      },
      raw({ type: 'application/json', limit: '2mb', inflate: false }),
      (req: GitHubRawRequest, _res: Response, next: NextFunction): void => {
        if (Buffer.isBuffer(req.body)) req.githubRawBody = req.body;
        next();
      },
    );
  }
}

// Deliberate machine callback exception: HMAC + repository/installation checks,
// never session identity. No other application route becomes public.
@Public()
@Controller(['openapi/github/webhook', 'api/github/webhook'])
export class GitHubWebhookController {
  constructor(private readonly webhook: GitHubWebhookService) {}
  @Header('Cache-Control', 'private, no-store')
  @HttpCode(200)
  @Post()
  async receive(
    @Req() req: GitHubRawRequest,
  ): Promise<{ duplicate: boolean; queued: number }> {
    return this.webhook.receive(req.githubRawBody, req.headers);
  }
}
