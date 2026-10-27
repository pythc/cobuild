import {
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AuthNPaasService } from '@lark-apaas/fullstack-nestjs-core';
import { RequestContextService } from '@lark-apaas/nestjs-common';
import { withSelfhostActor } from '../../common/selfhost/context';
import { FeishuService } from './feishu.service';
import { RequirementPlatformRoleService } from './requirement-platform-role.service';
import { RequirementAccessService } from './requirement-access.service';
import {
  openTicket,
  sealTicket,
  validTicketInput,
} from './lab-identity-ticket';
import { CurrentUserSummary } from '@shared/api.interface';
import { McpPersonalTokenService } from './mcp-personal-token.service';
import type { VerifiedMcpUser } from './mcp-auth.types';
const ISSUER = 'https://internal.110-lab.cn';
@Injectable()
export class LabIdentityService {
  constructor(
    private feishu: FeishuService,
    private authn: AuthNPaasService,
    private context: RequestContextService,
    private roles: RequirementPlatformRoleService,
    private access: RequirementAccessService,
    private tokens: McpPersonalTokenService,
  ) {}
  async profile(token: string, audience: 'requirements' | 'relay' = 'requirements') {
    if (process.env.LAB_IDENTITY_ENABLED !== 'true')
      throw new ServiceUnavailableException('统一认证尚未启用');
    if (!/^[\w-]{43}$/.test(token || '')) throw new UnauthorizedException();
    let r: Response;
    try {
      r = await fetch(ISSUER + '/api/identity/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audience, token }),
        redirect: 'error',
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new ServiceUnavailableException('暂时无法核对统一身份');
    }
    if (!r.ok) {
      await r.body?.cancel();
      if ([401, 403].includes(r.status))
        throw new UnauthorizedException('统一登录已失效');
      throw new ServiceUnavailableException('暂时无法核对统一身份');
    }
    let n = 0,
      parts: Uint8Array[] = [];
    const reader = r.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if ((n += value.length) > 8192) {
          await reader.cancel();
          throw new UnauthorizedException();
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    let p: any;
    try {
      p = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw new UnauthorizedException();
    }
    if (
      p.issuer !== ISSUER ||
      p.audience !== audience ||
      p.tenantKey !== process.env.LAB_IDENTITY_TENANT_KEY ||
      !/^on_[\w-]{10,100}$/.test(p.unionId || '') ||
      p.subject !== p.tenantKey + ':' + p.unionId ||
      !Number.isFinite(Date.parse(p.expiresAt)) ||
      Date.parse(p.expiresAt) <= Date.now() ||
      Date.parse(p.expiresAt) > Date.now() + 30 * 86400000 + 5000
    )
      throw new UnauthorizedException('统一身份无效');
    return p;
  }
  async actor(token: string, audience: 'requirements' | 'relay' = 'requirements') {
    const p = await this.profile(token, audience),
      member = await this.feishu.getUserByUnionId(p.unionId),
      appId =
        process.env.REQUIREMENT_PLATFORM_APP_ID ||
        process.env.MIAODA_APP_ID ||
        '';
    if (!appId) throw new ServiceUnavailableException();
    const [userId] = await this.context.run({ appId }, () =>
      this.authn.getBatchMiaodaUserIds([member.employeeId]),
    );
    if (!userId) throw new UnauthorizedException('此成员尚未获准访问需求平台');
    const [employeeId] = await this.context.run({ appId, userId }, () =>
      this.authn.getBatchLarkUserIds([userId]),
    );
    if (employeeId !== member.employeeId)
      throw new UnauthorizedException('平台身份不一致');
    const roleIds = await this.roles.currentRoles(userId, appId);
    return this.access.decorate({
      miaodaUserId: userId,
      employeeId: member.employeeId,
      openId: member.openId,
      name: member.name,
      platformAppId: appId,
      platformRoleIds: roleIds,
    });
  }
  async ticket(input: any) {
    const v = validTicketInput(input);
    await this.profile(v.token);
    const ticket = sealTicket(v);
    const url = new URL(process.env.MCP_PUBLIC_ENDPOINT || '');
    url.pathname = url.pathname.replace(/\/openapi\/mcp$/, '/connect/110lab');
    url.search = new URLSearchParams({ ticket }).toString();
    return { url: url.href };
  }
  async confirm(ticket: string, current: CurrentUserSummary) {
    const v = openTicket(ticket),
      p = await this.profile(v.token),
      member = await this.feishu.getUserByUnionId(p.unionId);
    if (
      current.employeeId !== member.employeeId ||
      !current.miaodaUserId ||
      current.miaodaUserId === 'anonymous_user_id'
    )
      throw new UnauthorizedException('请使用同一飞书账号连接');
    const credential = await this.tokens.issueEncrypted(
      current,
      v.publicKey,
      v.requestNonce,
    );
    return {
      encrypted: credential,
      state: v.state,
      redirectUri: v.redirectUri,
    };
  }
  async connect(token: string) {
    const actor = await this.actor(token);
    return withSelfhostActor(actor, () => this.tokens.issueForLabIdentity(actor));
  }
  async verify(token: string, personalToken: string): Promise<VerifiedMcpUser> {
    const [actor, verified] = await Promise.all([
      this.actor(token),
      this.tokens.verify(personalToken),
    ]);
    if (
      actor.miaodaUserId !== verified.miaodaUserId ||
      actor.employeeId !== verified.employeeId
    )
      throw new UnauthorizedException('请使用同一个实验室账号重新连接');
    return { ...actor, mcpWriteProof: verified.mcpWriteProof };
  }
}
