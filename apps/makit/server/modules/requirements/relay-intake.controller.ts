import {
  BadRequestException,
  Body,
  Controller,
  Header,
  HttpCode,
  Post,
  Req,
  Get,
  Param,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { RequirementsQueryService } from './requirements-query.service';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { LabIdentityService } from './lab-identity.service';
import { McpPersonalTokenService } from './mcp-personal-token.service';
import { RelayIntakeService } from './relay-intake.service';
// Configure a route-scoped OpenAPI gateway key for these five routes.
// Every request additionally verifies a current Makit member identity, as MCP does.
@Controller('openapi/relay/tickets')
export class RelayIntakeController {
  constructor(
    private readonly identity: LabIdentityService,
    private readonly tokens: McpPersonalTokenService,
    private readonly service: RelayIntakeService,
  ) {}
  private async actor(req: Request) {
    const token = req.headers['x-requirement-mcp-token'];
    const grant = req.headers['x-lab-identity-token'];
    if (
      typeof token !== 'string' ||
      !token ||
      (grant !== undefined && typeof grant !== 'string')
    )
      throw new UnauthorizedException('缺少有效的需求平台身份');
    return typeof grant === 'string' && grant
      ? this.identity.verify(grant, token)
      : this.tokens.verify(token);
  }
  private conversation(body: unknown) {
    const parsed = z
      .object({ conversationId: z.string().regex(/^[\w.:/-]{1,128}$/) })
      .strict()
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('咨询标识无效');
    return parsed.data.conversationId;
  }
  @Post('members')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  async members(@Req() req: Request) {
    return this.service.members(await this.actor(req));
  }
  @Post('prepare')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  async prepare(@Req() req: Request) {
    await this.actor(req);
    return this.service.prepare();
  }
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  async create(@Req() req: Request, @Body() body: unknown) {
    return this.service.create(body, await this.actor(req));
  }
  @Post('lookup')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  async lookup(@Req() req: Request, @Body() body: unknown) {
    return this.service.get(this.conversation(body), await this.actor(req));
  }
  @Post('group')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  async group(@Req() req: Request, @Body() body: unknown) {
    return this.service.group(this.conversation(body), await this.actor(req));
  }
}

/** Shares the native app's normal signed-in read access; no extra ticket roles. */
@Controller('api/workspace/relay-context')
export class RelayContextController {
  constructor(
    private readonly service: RelayIntakeService,
    private readonly query: RequirementsQueryService,
  ) {}
  @NeedLogin()
  @Get(':marker')
  @Header('Cache-Control', 'no-store, private')
  async download(
    @Param('marker') marker: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const who = req.userContext;
    if (!who?.userId || who.userId === 'anonymous_user_id')
      throw new UnauthorizedException('请先登录需求平台');
    const actor = await this.query.currentUser({
      userId: who.userId,
      userName: who.userName || '',
      roles: who.roles,
      appId: who.appId,
    });
    const snapshot = await this.service.context(marker, actor);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="relay-context.json"',
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.send(JSON.stringify(snapshot, null, 2));
  }
}
