import {LabIdentityService} from './lab-identity.service';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ALL_NAMED_THROTTLERS_SKIPPED, AUTH_THROTTLER } from '../../../integrations/throttle/throttler-names';
import {
  Controller,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { FeishuService } from './feishu.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
@Controller('auth/feishu')
export class FeishuController {
  constructor(
    private feishu: FeishuService,
    private unified:LabIdentityService,
    private env: EnvironmentService,
  ) {}
  @Get('status') status() {
    return { enabled: this.feishu.enabled };
  }
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({...ALL_NAMED_THROTTLERS_SKIPPED,[AUTH_THROTTLER]:false})
  @Throttle({[AUTH_THROTTLER]:{limit:30,ttl:60000}})
  @Get('login') async login(
    @Query('redirect') redirect: unknown,
    @Res() res: FastifyReply,
  ) {
    res.header('Cache-Control', 'no-store');
    if(this.unified.enabled)return res.redirect('/api/auth/identity/login?'+new URLSearchParams({redirect:typeof redirect==='string'?redirect:'/home'}),302);
    try {
      const flow = await this.feishu.begin(redirect);
      res.setCookie(this.feishu.cookieName(flow.state), flow.binding, {
        httpOnly: true,
        secure: this.feishu.secure,
        sameSite: 'lax',
        path: '/api/auth/feishu',
        maxAge: 600,
      });
      return res.redirect(flow.url, 302);
    } catch {
      return res.redirect('/login?error=unavailable', 302);
    }
  }
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({...ALL_NAMED_THROTTLERS_SKIPPED,[AUTH_THROTTLER]:false})
  @Throttle({[AUTH_THROTTLER]:{limit:30,ttl:60000}})
  @Get('callback') async callback(
    @Query() query: Record<string, unknown>,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    res.header('Cache-Control', 'no-store');
    res.header('Referrer-Policy', 'no-referrer');
    const state = typeof query.state === 'string' ? query.state : '';
    const name = this.feishu.cookieName(state);
    const binding = req.cookies[name];
    res.clearCookie(name, { path: '/api/auth/feishu' });
    if (query.error) return res.redirect('/login?error=denied', 302);
    try {
      const result = await this.feishu.complete(state, query.code, binding);
      res.setCookie('authToken', result.authToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.feishu.secure,
        path: '/',
        expires: this.env.getCookieExpiresIn(),
      });
      return res.redirect(result.redirect, 302);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      return res.redirect(
        '/login?error=' +
          (['organization', 'disabled'].includes(msg) ? msg : 'failed'),
        302,
      );
    }
  }
  @UseGuards(JwtAuthGuard)
  @Get('configuration')
  configuration(@AuthUser() user: User) {
    if (!['owner', 'admin'].includes(user.role)) throw new ForbiddenException();
    return {
      enabled: this.feishu.enabled,
      tenantKey: this.feishu.tenant,
      callbackUrl: this.feishu.callbackUrl,
    };
  }
}
