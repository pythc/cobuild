import {verifyService} from './suite-channel';
import { Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { MakitSessionService } from './session.service';

export function transportAllowed(req: Request): boolean {
  const rules: Array<{ path: RegExp; variable: string }> = [
    { path: /^\/openapi\/(mcp|relay\/tickets(?:\/(members|prepare|lookup|group))?)\/?$/, variable: 'MCP_TRANSPORT_API_KEY' },
    { path: /^\/openapi\/identity\/(ticket|connect)\/?$/, variable: 'MAKIT_IDENTITY_TRANSPORT_KEY' },
    { path: /^\/openapi\/workspace\/projects\/(catalog|lookup|sync)\/?$/, variable: 'MAKIT_PROJECT_SYNC_TRANSPORT_KEY' },
    { path: /^\/openapi\/iteration-bot\/records\/?$/, variable: 'MAKIT_ITERATION_BOT_TOKEN' },
  ];
  const rule = rules.find((rule) => rule.path.test(req.path));
  if (!rule) return false;
  const expected = process.env[rule.variable] || '';
  const provided = req.headers.authorization;
  return expected.length >= 32 && typeof provided === 'string' &&
    Buffer.byteLength(provided) === Buffer.byteLength(`Bearer ${expected}`) &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(`Bearer ${expected}`));
}

@Injectable()
export class MakitAccessGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly sessions: MakitSessionService) {}
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const handler = context.getHandler(), controller = context.getClass();
    const login = this.reflector.getAllAndOverride<boolean>('makit:login', [handler, controller]);
    const publicRoute = this.reflector.getAllAndOverride<boolean>('makit:public', [handler, controller]);
    if(process.env.COBUILD_IDENTITY_MODE==='local'&&/^\/openapi\/workspace\/projects\/(lookup|sync)\/?$/.test(req.path)){
      if(req.method!=='POST')throw new UnauthorizedException('请求无效');
      try{const payload=verifyService(req.headers,req.body,req.path,process.env.COBUILD_SERVICE_KEY_FILE!);
        if(payload.organizationId!==process.env.LAB_IDENTITY_TENANT_KEY)throw Error();req.body=payload.input;return true;
      }catch{throw new UnauthorizedException('服务接入凭据无效');}
    }
    // Native Relay and GitHub endpoints verify their dedicated signatures in
    // their controllers. No gateway key can grant browser administrative access.
    if (/^\/openapi\/relay-native\/?$/.test(req.path)) return true;
    // These exact endpoints validate the dedicated worker token themselves.
    if (req.method === 'POST' && /^\/openapi\/workflow-deliveries\/(reconcile|ingest|claim|result)\/?$/.test(req.path)) return true;
    if (req.path.startsWith('/openapi/') && !req.path.startsWith('/openapi/github/webhook')) {
      if (!transportAllowed(req)) throw new UnauthorizedException('服务接入凭据无效');
      if (!login) return true;
    }
    if (publicRoute) return true;
    if (req.path === '/api/selfhost/config' || req.path === '/healthz' || req.path === '/readyz' || req.path === '/auth/start' ||
      req.path === '/callback/110lab_requirements' || req.path === '/callback/110lab_requirements/embedded') return true;
    if (req.path.startsWith('/api/') || login) {
      if (!req.userContext?.userId) throw new UnauthorizedException('请先登录');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) this.sessions.assertOrigin(req);
    }
    return true;
  }
}
