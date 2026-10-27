import {
  Injectable,
  UnauthorizedException,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import Redis from 'ioredis';
import { InjectKysely } from 'nestjs-kysely';
import { sql, Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';
import { SignupService } from '../services/signup.service';
import { SessionService } from '../../session/session.service';
import {
  equalSecret,
  hashState,
  identityAllowed,
  safeReturnPath,
  splitIds,
} from './feishu-policy';
import { isUserDisabled } from '../../../common/helpers';
import { FeishuDirectoryService } from '../../feishu/feishu-directory.service';
import {
  assertDirectoryAccess,
  directoryEnabled,
  safeFeishuAvatar,
} from '../../feishu/feishu-directory-policy';

interface Identity {
  open_id: string;
  tenant_key: string;
  union_id?: string;
  user_id?: string;
  name?: string;
  email?: string;
  enterprise_email?: string;
  avatar_url?: string;
}
interface LoginFlow {
  verifier: string;
  binding: string;
  redirect: string;
}
@Injectable()
export class FeishuService {
  constructor(
    private config: ConfigService,
    private redisService: RedisService,
    @InjectKysely() private db: Kysely<any>,
    private workspaces: WorkspaceRepo,
    private users: UserRepo,
    private groups: GroupUserRepo,
    private signup: SignupService,
    private sessions: SessionService,
    private directory: FeishuDirectoryService,
  ) {
    this.redis = this.redisService.getOrThrow();
  }
  private redis: Redis;
  get appId(): string {
    return this.config.get<string>('FEISHU_APP_ID', '');
  }
  get tenant(): string {
    return this.config.get<string>('FEISHU_TENANT_KEY', '');
  }
  get appUrl(): string {
    return this.config.get<string>('APP_URL', '').replace(/\/$/, '');
  }
  get callbackUrl(): string {
    return this.appUrl + '/api/auth/feishu/callback';
  }
  get enabled(): boolean {
    return !!(
      this.appId &&
      this.tenant &&
      this.config.get('FEISHU_APP_SECRET') &&
      this.appUrl
    );
  }
  get secure(): boolean {
    return this.appUrl.startsWith('https://');
  }
  cookieName(state: string): string {
    return 'lab110_oauth_' + hashState(state).slice(0, 16);
  }
  async begin(redirect: unknown) {
    if (!this.enabled)
      throw new ServiceUnavailableException('飞书登录尚未配置');
    const state = randomBytes(32).toString('base64url');
    const binding = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = Buffer.from(hashState(verifier), 'hex').toString(
      'base64url',
    );
    await this.redis.set(
      'lab110:oauth:' + hashState(state),
      JSON.stringify({
        verifier,
        binding,
        redirect: safeReturnPath(redirect),
      } satisfies LoginFlow),
      'EX',
      600,
      'NX',
    );
    const url = new URL(
      'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    );
    for (const [key, value] of Object.entries({
      client_id: this.appId,
      response_type: 'code',
      redirect_uri: this.callbackUrl,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }))
      url.searchParams.set(key, value);
    return { url: url.toString(), state, binding };
  }
  async complete(state: unknown, code: unknown, binding: unknown) {
    if (!this.enabled)
      throw new ServiceUnavailableException('飞书登录尚未配置');
    if (
      typeof state !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      typeof code !== 'string' ||
      code.length < 1 ||
      code.length > 2048
    )
      throw new UnauthorizedException('登录状态无效');
    // Only the originating browser can consume this one-time flow.
    const key = 'lab110:oauth:' + hashState(state);
    const raw = await this.redis.get(key);
    if (!raw) throw new UnauthorizedException('登录已过期');
    const flow: LoginFlow = JSON.parse(raw);
    if (!equalSecret(binding, flow.binding))
      throw new UnauthorizedException('登录状态无效');
    const taken = await this.redis.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]);return 1 else return 0 end",
      1,
      key,
      raw,
    );
    if (taken !== 1) throw new UnauthorizedException('登录状态已使用');
    const token = await this.providerRequest(
      'https://open.feishu.cn/open-apis/authen/v2/oauth/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: this.appId,
          client_secret: this.config.get('FEISHU_APP_SECRET'),
          code,
          redirect_uri: this.callbackUrl,
          code_verifier: flow.verifier,
        }),
      },
    );
    if (typeof token.access_token !== 'string' || !token.access_token)
      throw new UnauthorizedException('飞书授权失败');
    const response = await this.providerRequest(
      'https://open.feishu.cn/open-apis/authen/v1/user_info',
      { headers: { Authorization: 'Bearer ' + token.access_token } },
    );
    const info: Identity = response.data;
    if (!info || !identityAllowed(info, this.tenant))
      throw new ForbiddenException('organization');
    if (directoryEnabled(this.config))
      await this.directory.ensureMember(info.open_id);
    const user = await this.bindIdentity(info);
    if (isUserDisabled(user)) throw new ForbiddenException('disabled');
    const authToken = await this.sessions.createSessionAndToken(user);
    return { authToken, redirect: flow.redirect };
  }
  private async providerRequest(url: string, init: RequestInit) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(12000),
        redirect: 'error',
      });
      if (!res.ok) throw new Error('provider status');
      const data = await res.json();
      if (data.code !== undefined && data.code !== 0)
        throw new Error('provider rejected');
      return data;
    } catch {
      throw new ServiceUnavailableException('飞书登录暂时不可用');
    }
  }
  private async bindIdentity(info: Identity) {
    const owners = splitIds(this.config.get('FEISHU_OWNER_OPEN_IDS'));
    const owner = owners.includes(info.open_id);
    // Email is presentation data, never an account-linking credential.
    const email = (
      info.enterprise_email ||
      info.email ||
      hashState(this.tenant + ':' + info.open_id) + '@feishu.110lab.invalid'
    ).toLowerCase();
    return this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${this.appId + ':' + this.tenant + ':' + info.open_id}))`.execute(
        trx,
      );
      const identity = await trx
        .selectFrom('feishuIdentities')
        .selectAll()
        .where('appId', '=', this.appId)
        .where('tenantKey', '=', this.tenant)
        .where('subject', '=', info.open_id)
        .executeTakeFirst();
      if (identity) {
        if (directoryEnabled(this.config)) assertDirectoryAccess(identity);
        else if (
          identity.directoryStatus &&
          !['unknown', 'active'].includes(identity.directoryStatus)
        )
          throw new ForbiddenException('disabled');
        const user = await this.users.findById(
          identity.userId,
          identity.workspaceId,
          { trx },
        );
        if (!user || isUserDisabled(user))
          throw new ForbiddenException('disabled');
        const patch: any = {
          name: (info.name || user.name).trim().slice(0, 50),
          locale: 'zh-CN',
          ...(safeFeishuAvatar(info.avatar_url)
            ? { avatarUrl: safeFeishuAvatar(info.avatar_url) }
            : {}),
        };
        if (owner) patch.role = 'owner';
        await this.users.updateUser(patch, user.id, user.workspaceId, trx);
        return { ...user, ...patch };
      }
      // Serialize workspace bootstrap and legacy owner binding across different identities.
      if (directoryEnabled(this.config))
        throw new ForbiddenException('disabled');
      await sql`select pg_advisory_xact_lock(hashtext(${'110lab:feishu:bootstrap'}))`.execute(
        trx,
      );
      let workspace = await trx
        .selectFrom('workspaces')
        .selectAll()
        .orderBy('createdAt', 'asc')
        .limit(1)
        .executeTakeFirst();
      let user: any;
      const bootstrapId = this.config.get<string>(
        'FEISHU_BOOTSTRAP_USER_ID',
        '',
      );
      if (workspace && owner && bootstrapId) {
        const existingBinding = await trx
          .selectFrom('feishuIdentities')
          .select('subject')
          .where('userId', '=', bootstrapId)
          .executeTakeFirst();
        if (!existingBinding) {
          const legacy = await this.users.findById(bootstrapId, workspace.id, {
            trx,
          });
          if (!legacy || legacy.role !== 'owner' || isUserDisabled(legacy))
            throw new ForbiddenException('Invalid explicit bootstrap owner');
          user = legacy;
          await this.users.updateUser(
            { name: (info.name || legacy.name).trim().slice(0, 50) },
            user.id,
            workspace.id,
            trx,
          );
          user = {
            ...user,
            name: (info.name || legacy.name).trim().slice(0, 50),
          };
        }
      }
      if (user) {
        // Only an explicitly allowlisted, verified owner may retain the demo owner's data.
      } else if (!workspace) {
        if (!owner)
          throw new ForbiddenException('平台尚未初始化，请联系管理员');
        const result = await this.signup.initialSetup(
          {
            name: (info.name || '管理员').slice(0, 50),
            email,
            password: randomBytes(48).toString('base64url'),
            workspaceName: '110lab',
          },
          trx,
        );
        workspace = result.workspace;
        user = result.user;
      } else {
        const conflict = await trx
          .selectFrom('users')
          .select('id')
          .where('workspaceId', '=', workspace.id)
          .where('email', '=', email)
          .executeTakeFirst();
        // Never merge an existing account merely because the mailbox matches.
        const uniqueEmail = conflict
          ? hashState(this.tenant + ':' + info.open_id) +
            '@feishu.110lab.invalid'
          : email;
        user = await this.users.insertUser(
          {
            name: (info.name || '成员').slice(0, 50),
            email: uniqueEmail,
            password: null,
            role: owner ? 'owner' : 'member',
            workspaceId: workspace.id,
            locale: 'zh-CN',
            avatarUrl: safeFeishuAvatar(info.avatar_url),
            emailVerifiedAt: new Date(),
          },
          trx,
        );
        await this.groups.addUserToDefaultGroup(user.id, workspace.id, trx);
      }
      await this.users.updateUser(
        { password: null, locale: 'zh-CN' },
        user.id,
        workspace.id,
        trx,
      );
      // Invalidate all pre-Feishu sessions before the first verified identity binding.
      await trx
        .updateTable('userSessions')
        .set({ revokedAt: new Date() })
        .where('userId', '=', user.id)
        .where('workspaceId', '=', workspace.id)
        .where('revokedAt', 'is', null)
        .execute();
      await trx
        .insertInto('feishuIdentities')
        .values({
          userId: user.id,
          workspaceId: workspace.id,
          provider: 'feishu',
          appId: this.appId,
          tenantKey: this.tenant,
          subject: info.open_id,
          unionId: info.union_id || null,
        })
        .execute();
      return { ...user, workspaceId: workspace.id, locale: 'zh-CN' };
    });
  }
}
