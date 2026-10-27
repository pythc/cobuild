import { issueWidgetGrant } from './widget-grant';
import {
  All,
  Body,
  Controller,
  ForbiddenException,
  Injectable,
  Req,
  Res,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  UseFilters,
  GoneException,
} from '@nestjs/common';
import { RelayExceptionFilter } from './relay-exception.filter';
import { NeedLogin } from '@lark-apaas/fullstack-nestjs-core';
import type { Request, Response } from 'express';
import type { CurrentUserSummary } from '../../../shared/api.interface';
import { RequirementsQueryService } from '../requirements/requirements-query.service';
import { RelayChatwootService } from './relay-chatwoot.service';
@Injectable()
export class RelayDispatcher {
  constructor(private readonly service: RelayChatwootService) {}
  async dispatch(
    path: string,
    req: Request,
    res: Response,
    body: unknown,
    a: CurrentUserSummary,
  ) {
    res.setHeader('Cache-Control', 'no-store, private');
    const key = String(req.headers['idempotency-key'] || '');
    const method = req.method;
    if (!['GET', 'HEAD'].includes(method))
      throw new GoneException('Relay 已迁移，请重新打开客服窗口后操作');
    if (path === '/relay/profile' && method === 'GET')
      return res.json(await this.service.profile(a));
    if (path === '/support/profile' && method === 'GET')
      return res.json(await this.service.profile(a));
    if (path === '/support/members' && method === 'GET')
      return res.json(await this.service.members(a));
    if (path === '/relay/state' && method === 'GET')
      return res.json(
        await this.service.state(
          a,
          req.query.view === 'operator' ? 'operator' : 'customer',
        ),
      );
    if (path === '/relay/conversations' && method === 'POST') {
      if (
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).some((k) => k !== 'app')
      )
        throw new BadRequestException();
      return res.json(
        await this.service.begin(
          a,
          String(('app' in body ? body.app : undefined) || 'makit'),
          key,
        ),
      );
    }
    if (path === '/support/tickets' && method === 'POST')
      return res.json(await this.service.create(a, body));
    if (path === '/support/tickets' && method === 'GET')
      return res.json(await this.service.tickets(a));
    if (path === '/support/project' && method === 'GET')
      return res.json({ id: 'relay-support', name: '工单', kind: 'support' });
    let m = path.match(
      /^\/support\/context-by-marker\/(relay_v1:[a-f0-9]{64})$/,
    );
    if (m && method === 'GET') {
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="relay-context.json"',
      );
      return res.json(await this.service.contextByMarker(m[1], a));
    }
    m = path.match(/^\/support\/context\/([\w-]+)$/);
    if (m && method === 'GET')
      return res.json(await this.service.context(m[1], a));
    m = path.match(/^\/relay\/conversations\/([\w-]+)\/(messages|resolve)$/);
    if (m && method === 'POST') {
      return res.json(
        m[2] === 'messages'
          ? await this.service.send(
              m[1],
              a,
              body,
              key,
              req.query.view === 'operator',
            )
          : await this.service.resolve(m[1], a, key, body),
      );
    }
    m = path.match(/^\/support\/tickets\/([\w-]+)(\/group)?$/);
    if (m) {
      if (m[2] && method === 'POST')
        return res.json(await this.service.group(m[1], a));
      if (!m[2] && method === 'GET')
        return res.json(await this.service.tickets(a, m[1]));
      if (!m[2] && method === 'PATCH')
        return res.json(await this.service.update(m[1], a, body, key));
    }
    m = path.match(/^\/relay\/(?:native-)?attachments\/([\w-]+)\/(\d+)$/);
    if (m && method === 'GET') {
      const f = await this.service.attachment(
        m[1],
        m[2],
        a,
        req.query.view === 'operator' || req.query.client === 'relay',
        path.startsWith('/relay/native-attachments/'),
      );
      res.setHeader('Content-Type', f.mime);
      res.setHeader(
        'Content-Disposition',
        (/^image\/(png|jpeg|gif|webp)(;|$)/i.test(f.mime)
          ? 'inline'
          : 'attachment') + `; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      );
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
      return res.send(f.bytes);
    }
    throw new NotFoundException('接口不存在');
  }
}
@UseFilters(RelayExceptionFilter)
@Controller('api')
export class RelayController {
  constructor(
    private readonly dispatcher: RelayDispatcher,
    private readonly query: RequirementsQueryService,
  ) {}
  @NeedLogin()
  @All(['relay/*', 'support/*'])
  async route(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: unknown,
  ) {
    const c = req.userContext;
    if (!c?.userId || c.userId === 'anonymous_user_id')
      throw new UnauthorizedException('请先登录');
    const a = await this.query.currentUser({
      userId: c.userId,
      userName: c.userName || '',
      roles: c.roles,
      appId: c.appId,
    });
    if (req.path.endsWith('/relay/widget-grant') && req.method === 'POST') {
      if (
        req.headers.origin !== (process.env.MAKIT_STORAGE === 'postgres'
          ? process.env.MAKIT_PUBLIC_URL : 'https://fcncvoyreb8p.feishuapp.com') ||
        !body ||
        typeof body !== 'object' ||
        Object.keys(body).sort().join(',') !== 'app,challenge' ||
        !('app' in body) ||
        body.app !== 'makit' ||
        !('challenge' in body)
      )
        throw new ForbiddenException('请求来源无效');
      res.setHeader('Cache-Control', 'no-store, private');
      return res.json(
        issueWidgetGrant(
          { subject: a.employeeId, name: a.name },
          body.challenge,
        ),
      );
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      const origin = req.headers.origin;
      const expected = process.env.RELAY_PUBLIC_ORIGIN;
      if (!expected || origin !== new URL(expected).origin)
        throw new ForbiddenException('请求来源无效');
    }
    const path = req.path.match(/\/api\/(relay|support)\/(.*)$/);
    if (!path) throw new NotFoundException('接口不存在');
    await this.dispatcher.dispatch(
      '/' + path[1] + '/' + path[2],
      req,
      res,
      body,
      a,
    );
  }
}
