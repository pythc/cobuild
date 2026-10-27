import { randomUUID } from 'node:crypto';
import { IdentityLoginError } from './lab-identity-diagnostics';
import { Logger, HttpException, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../../integrations/throttle/throttler-names';
import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { FastifyReply, FastifyRequest } from 'fastify';
import { LabIdentityService } from './lab-identity.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { LAB_ISSUER } from './lab-identity-policy';
@UseGuards(ThrottlerGuard)
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@Throttle({ [AUTH_THROTTLER]: { limit: 30, ttl: 60000 } })
@Controller('auth/identity')
export class LabIdentityController {
  private readonly logger = new Logger(LabIdentityController.name);
  constructor(
    private service: LabIdentityService,
    private env: EnvironmentService,
  ) {}
  @Get('home') home(@Res() res: FastifyReply) { return res.redirect(this.service.issuer+'/workbench',302); }
  @Get('status') status() {
    return { enabled: this.service.enabled, provider: process.env.COBUILD_IDENTITY_MODE === 'local' ? 'local' : 'feishu' };
  }
  @Get('login') async login(
    @Query('redirect') redirect: unknown,
    @Res() res: FastifyReply,
  ) {
    res.header('Cache-Control', 'no-store');
    try {
      const f = await this.service.begin(redirect);
      res.setCookie(this.service.cookieName(f.state), f.binding, {
        httpOnly: true,
        secure: this.service.secure,
        sameSite: 'lax',
        path: '/api/auth/identity',
        maxAge: 600,
      });
      return res.redirect(f.url, 302);
    } catch {
      return res.redirect('/login?error=unavailable', 302);
    }
  }
  @Get('callback') async callback(
    @Query() q: Record<string, unknown>,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    res
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer');
    const state = typeof q.state === 'string' ? q.state : '',
      name = this.service.cookieName(state),
      binding = req.cookies[name];
    res.clearCookie(name, { path: '/api/auth/identity' });
    const requestId = randomUUID();
    res.header('X-Request-Id', requestId);
    try {
      if (
        q.iss !== this.service.issuer ||
        Object.keys(q).some((k) => !['state', 'code', 'iss'].includes(k))
      )
        throw new IdentityLoginError('callback_parameters');
      const r = await this.service.complete(q.state, q.code, binding);
      res.setCookie('authToken', r.authToken, {
        httpOnly: true,
        secure: this.service.secure,
        sameSite: 'lax',
        path: '/',
        expires: this.env.getCookieExpiresIn(),
      });
      return res.redirect(r.redirect, 302);
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 500;
      this.logger.warn(
        JSON.stringify({
          event: 'identity_callback_failed',
          requestId,
          stage: error instanceof IdentityLoginError ? error.stage : 'complete',
          status,
        }),
      );
      return res.redirect(
        '/login?error=' + (status >= 500 ? 'unavailable' : 'failed'),
        302,
      );
    }
  }
}
