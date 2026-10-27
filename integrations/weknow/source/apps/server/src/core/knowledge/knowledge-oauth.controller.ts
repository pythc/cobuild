import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Req,
  Res,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import { SkipThrottle, Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  ALL_NAMED_THROTTLERS_SKIPPED,
  AUTH_THROTTLER,
} from '../../integrations/throttle/throttler-names';
import { SkipTransform } from '../../common/decorators/skip-transform.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequireSessionAuth } from '../../common/decorators/require-session-auth.decorator';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { KnowledgeOAuthService } from './knowledge-oauth.service';
import { assertBrowserOrigin, OAuthError } from './knowledge-policy';

@Controller()
export class KnowledgeDiscoveryController {
  constructor(private oauth: KnowledgeOAuthService) {}
  @SkipTransform() @Get('.well-known/oauth-authorization-server') metadata() {
    return this.oauth.metadata;
  }
  @SkipTransform() @Get('.well-known/oauth-protected-resource') resource() {
    return this.oauth.resourceMetadata;
  }
  @SkipTransform()
  @Get('.well-known/oauth-protected-resource/mcp')
  mcpResource() {
    return this.oauth.resourceMetadata;
  }
}
@Controller('knowledge/oauth')
@UseGuards(ThrottlerGuard)
@SkipThrottle({ ...ALL_NAMED_THROTTLERS_SKIPPED, [AUTH_THROTTLER]: false })
@Throttle({ [AUTH_THROTTLER]: { limit: 30, ttl: 60000 } })
export class KnowledgeOAuthController {
  constructor(private oauth: KnowledgeOAuthService) {}
  @SkipTransform()
  @Post('register')
  @Throttle({ [AUTH_THROTTLER]: { limit: 5, ttl: 60000 } })
  async register(
    @Body() body: any,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    res.header('Cache-Control', 'no-store');
    return this.oauth.register(body);
  }
  @SkipTransform()
  @Get('authorize')
  async authorize(
    @Query() query: any,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    res.header('Cache-Control', 'no-store');
    res.header('Referrer-Policy', 'no-referrer');
    const flow = await this.oauth.authorize(
      query,
      req.cookies[this.oauth.cookieName],
    );
    res.setCookie(this.oauth.cookieName, flow.binding, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: this.oauth.secure,
      maxAge: 600,
    });
    return res.redirect(flow.url, 302);
  }
  private body(req: FastifyRequest, body: any) {
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    if (
      req.headers['content-type']?.startsWith(
        'application/x-www-form-urlencoded',
      )
    )
      return Object.fromEntries(
        new URLSearchParams(typeof body === 'string' ? body : ''),
      );
    return body;
  }
  @SkipTransform()
  @Post('token')
  @HttpCode(200)
  async token(
    @Req() req: FastifyRequest,
    @Body() body: any,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    res.header('Cache-Control', 'no-store');
    res.header('Pragma', 'no-cache');
    return this.oauth.token(this.body(req, body));
  }
  @SkipTransform()
  @Post('revoke')
  @HttpCode(200)
  async revoke(
    @Req() req: FastifyRequest,
    @Body() body: any,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    res.header('Cache-Control', 'no-store');
    return this.oauth.revokeToken(this.body(req, body));
  }
  @Get('requests/:id')
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  preview(@Param('id') id: string, @Req() req: any, @AuthUser() user: any) {
    return this.oauth.preview(id, req.cookies[this.oauth.cookieName], user);
  }
  @Post('requests/:id/resolve')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  resolve(
    @Param('id') id: string,
    @Body() body: any,
    @Req() req: any,
    @AuthUser() user: any,
  ) {
    assertBrowserOrigin(req.headers.origin, this.oauth.origin);
    if (typeof body?.approve !== 'boolean')
      throw new OAuthError(
        'invalid_request',
        'Explicit consent decision required',
      );
    return this.oauth.resolve(
      id,
      req.cookies[this.oauth.cookieName],
      user,
      req.raw.sessionId,
      body.approve,
      body.scopes,
    );
  }
  @Get('connections')
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  connections(@AuthUser() user: any) {
    return this.oauth.connections(user);
  }
  @Post('connections/:id/revoke')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @RequireSessionAuth()
  disconnect(
    @Param('id') id: string,
    @Req() req: FastifyRequest,
    @AuthUser() user: any,
  ) {
    assertBrowserOrigin(req.headers.origin, this.oauth.origin);
    return this.oauth.disconnect(id, user);
  }
}
