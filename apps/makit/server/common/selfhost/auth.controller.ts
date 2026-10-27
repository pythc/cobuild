import { Controller, Get, Post, Req, Res, Header, UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MakitSessionService } from './session.service';
import { NeedLogin } from './platform';
import { DrizzleDatabaseManager } from './database';
import type { MakitSessionProfile } from '../../../shared/selfhost-api';

@Controller()
export class MakitAuthController {
  constructor(private readonly sessions: MakitSessionService, private readonly database: DrizzleDatabaseManager) {}
  @Get('healthz')
  health() { return { status: 'ok', storage: 'postgres' }; }
  @Get('api/selfhost/config')
  config() { return {native:process.env.COBUILD_IDENTITY_MODE==='local',platform:process.env.COBUILD_IDENTITY_ORIGIN||'',relay:process.env.COBUILD_IDENTITY_MODE!=='local'}; }
  @Get('readyz')
  async ready() {
    await this.database.assertRuntimeRole();
    await this.database.client`SELECT 1 FROM makit_schema_migration LIMIT 1`;
    return { status: 'ready', storage: 'postgres' };
  }
  @Get('auth/start')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  begin(@Req() req: Request, @Res() res: Response) { return this.sessions.begin(req, res); }
  @Get('callback/110lab_requirements')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  callback(@Req() req: Request, @Res() res: Response) { return this.sessions.callback(req, res); }
  @Get('callback/110lab_requirements/embedded')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  embeddedCallback(@Req() req: Request, @Res() res: Response) { return this.sessions.callback(req, res, true); }
  @NeedLogin()
  @Get('api/selfhost/session')
  @Header('Cache-Control', 'private, no-store')
  async session(@Req() req: Request): Promise<MakitSessionProfile> {
    const profile = await this.sessions.authenticate(req);
    if (!profile) throw new UnauthorizedException('请先登录');
    return profile;
  }
  @NeedLogin()
  @Post('api/selfhost/logout')
  logout(@Req() req: Request, @Res() res: Response) { return this.sessions.logout(req, res); }
}
