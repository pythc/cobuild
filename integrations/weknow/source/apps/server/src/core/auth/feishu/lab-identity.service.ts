import {SuiteCollaborationService} from './suite-collaboration.service';
import {
  IdentityLoginError,
  identityLoginStep,
} from './lab-identity-diagnostics';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { FeishuApiService } from '../../feishu/feishu-api.service';
import { FeishuDirectoryService } from '../../feishu/feishu-directory.service';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { TokenService } from '../services/token.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { safeReturnPath, hashState, equalSecret } from './feishu-policy';
import {
  identityEndpoint,
  identityRequest,
  sealIdentity,
} from './lab-identity-policy';
import { provisionSuiteAccount } from './suite-identity';
import { SignupService } from '../services/signup.service';
import { isUserDisabled } from '../../../common/helpers';
@Injectable()
export class LabIdentityService {
  constructor(
    private config: ConfigService,
    private redisService: RedisService,
    @InjectKysely() private db: Kysely<any>,
    private api: FeishuApiService,
    private directory: FeishuDirectoryService,
    private users: UserRepo,
    private sessions: UserSessionRepo,
    private tokens: TokenService,
    private env: EnvironmentService,
    private signup: SignupService,
    private collaboration: SuiteCollaborationService,
  ) {}
  get issuer() { return identityEndpoint(this.config); }
  get enabled() {
    return this.config.get('LAB_IDENTITY_ENABLED') === 'true';
  }
  get callbackUrl() {
    return (
      this.config.get<string>('APP_URL', '').replace(/\/$/, '') +
      '/api/auth/identity/callback'
    );
  }
  get secure() {
    return this.callbackUrl.startsWith('https:');
  }
  cookieName(state: string) {
    return 'lab110_identity_' + hashState(state).slice(0, 16);
  }
  async begin(redirect: unknown) {
    if (!this.enabled) throw new ServiceUnavailableException();
    const state = randomBytes(32).toString('base64url'),
      binding = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url');
    await this.redisService.getOrThrow().set(
      'lab110:identity:' + hashState(state),
      JSON.stringify({
        binding,
        verifier,
        redirect: safeReturnPath(redirect),
      }),
      'EX',
      600,
      'NX',
    );
    const u = new URL(identityEndpoint(this.config) + '/auth');
    u.search = new URLSearchParams({
      audience: 'knowledge',
      state,
      redirect_uri: this.callbackUrl,
      code_challenge: Buffer.from(hashState(verifier), 'hex').toString(
        'base64url',
      ),
    }).toString();
    return { state, binding, url: u.href };
  }
  async complete(state: unknown, code: unknown, binding: unknown) {
    if (
      !this.enabled ||
      typeof state !== 'string' ||
      !/^[\w-]{43}$/.test(state) ||
      typeof code !== 'string' ||
      !/^[\w-]{43}$/.test(code)
    )
      throw new IdentityLoginError('invalid_parameters');
    const redis = this.redisService.getOrThrow(),
      key = 'lab110:identity:' + hashState(state),
      raw = await redis.get(key);
    if (!raw) throw new IdentityLoginError('flow_expired_or_missing');
    const flow = JSON.parse(raw);
    if (!equalSecret(binding, flow.binding))
      throw new IdentityLoginError('browser_binding_mismatch');
    if (
      (await redis.eval(
        "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]);return 1 else return 0 end",
        1,
        key,
        raw,
      )) !== 1
    )
      throw new IdentityLoginError('flow_already_used');
    const profile = await identityLoginStep('exchange', () =>
      identityRequest(this.config, 'exchange', {
        code,
        state,
        verifier: flow.verifier,
        redirectUri: this.callbackUrl,
      }),
    );
    // Resolve the union ID in this app's own directory. Never merge by email or
    // transfer a portal administrator role into a knowledge space.
    const identity = this.config.get('COBUILD_IDENTITY_MODE') === 'local'
      ? await provisionSuiteAccount(this.db,this.signup,profile,this.config.get('COBUILD_ORGANIZATION_NAME','CoBuild'))
      : await (async () => {
    const data = await identityLoginStep('directory_lookup', () =>
      this.api.call(
        '/contact/v3/users/' + encodeURIComponent(profile.unionId),
        { user_id_type: 'union_id' },
      ),
    );
    if (
      data?.user?.union_id !== profile.unionId ||
      !/^ou_[\w-]{5,200}$/.test(data.user.open_id || '')
    )
      throw new IdentityLoginError('directory_identity_mismatch');
    await identityLoginStep('directory_membership', () =>
      this.directory.ensureMember(data.user.open_id),
    );
    return await this.db
      .selectFrom('feishuIdentities')
      .selectAll()
      .where('appId', '=', this.config.get('FEISHU_APP_ID', ''))
      .where('tenantKey', '=', profile.tenantKey)
      .where('subject', '=', data.user.open_id)
      .executeTakeFirst();
    })();
    if(this.config.get('COBUILD_IDENTITY_MODE')==='local')await this.collaboration.syncDirectory();
    if (!identity) throw new IdentityLoginError('identity_not_registered');
    const user = await this.users.findById(
      identity.userId,
      identity.workspaceId,
    );
    if (!user || isUserDisabled(user))
      throw new IdentityLoginError('member_inactive');
    const session = await identityLoginStep('session_create', () =>
      this.db.transaction().execute(async (trx) => {
        const s = await this.sessions.insertSession(
          {
            userId: user.id,
            workspaceId: user.workspaceId,
            deviceName: this.config.get('COBUILD_IDENTITY_MODE') === 'local' ? 'CoBuild' : '110lab 统一登录',
            expiresAt: new Date(
              Math.min(
                this.env.getCookieExpiresIn().getTime(),
                Date.parse(profile.expiresAt),
              ),
            ),
          },
          trx as any,
        );
        await trx
          .insertInto('labIdentitySessions')
          .values({
            sessionId: s.id,
            subject: profile.subject,
            expiresAt: new Date(profile.expiresAt),
            sealedGrant: sealIdentity(
              profile.token,
              s.id,
              this.env.getAppSecret(),
            ),
          })
          .execute();
        return s;
      }),
    );
    return {
      authToken: await this.tokens.generateAccessToken(user, session.id),
      redirect: flow.redirect,
    };
  }
}
