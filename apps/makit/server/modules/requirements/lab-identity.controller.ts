import { Request } from 'express';
import { RequirementsQueryService } from './requirements-query.service';
import {
  Body,
  Controller,
  Post,
  Header,
  BadRequestException,
  Req,
} from '@nestjs/common';
import { Public, NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import { LabIdentityService } from './lab-identity.service';
@Controller('api/workspace/identity')
export class LabIdentityController {
  constructor(
    private identity: LabIdentityService,
    private query: RequirementsQueryService,
  ) {}
  @Public()
  @Post('ticket')
  @Header('Cache-Control', 'no-store, private')
  @Header('Referrer-Policy', 'no-referrer')
  async ticket(@Body() body: unknown) {
    return this.identity.ticket(body);
  }
  @NeedLogin()
  @Post('confirm')
  @Header('Cache-Control', 'no-store, private')
  @Header('Referrer-Policy', 'no-referrer')
  async confirm(@Body() body: any, @Req() req: Request) {
    if (
      !body ||
      Object.keys(body).length !== 1 ||
      typeof body.ticket !== 'string'
    )
      throw new BadRequestException();
    const c = req.userContext;
    const actor = await this.query.currentUser({
      userId: c?.userId || '',
      userName: c?.userName || '',
      roles: c?.roles || [],
      appId: c?.appId || process.env.REQUIREMENT_PLATFORM_APP_ID || '',
    });
    return this.identity.confirm(body.ticket, actor);
  }
  @Public()
  @Post('connect')
  @Header('Cache-Control', 'no-store, private')
  @Header('Referrer-Policy', 'no-referrer')
  async connect(@Body() body: unknown) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as any).token !== 'string'
    )
      throw new BadRequestException();
    return this.identity.connect((body as any).token);
  }
}

// Miaoda exposes /openapi only through a route-scoped transport key. Browser
// APIs remain behind the native login and must never be used as a back channel.
@Controller('openapi/identity')
export class LabIdentityOpenApiController {
  constructor(private identity: LabIdentityService) {}
  @Public()
  @Post('ticket')
  @Header('Cache-Control', 'no-store, private')
  @Header('Referrer-Policy', 'no-referrer')
  async ticket(@Body() body: unknown) {
    return this.identity.ticket(body);
  }
  @Public()
  @Post('connect')
  @Header('Cache-Control', 'no-store, private')
  @Header('Referrer-Policy', 'no-referrer')
  async connect(@Body() body: unknown) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as any).token !== 'string'
    )
      throw new BadRequestException();
    return this.identity.connect((body as any).token);
  }
}
