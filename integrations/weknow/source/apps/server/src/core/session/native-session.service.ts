import { refreshManagedAccess } from '../auth/feishu/suite-managed-access';
import { IdentityInspectionCache } from '../auth/feishu/lab-identity-cache';
import {
  identityRequest,
  sealIdentity,
  unsealIdentity,
} from '../auth/feishu/lab-identity-policy';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely } from 'kysely';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import { UserSessionRepo } from '@docmost/db/repos/session/user-session.repo';
import { isUserDisabled } from '../../common/helpers';
import {
  assertDirectoryAccess,
  directoryEnabled,
} from '../feishu/feishu-directory-policy';
@Injectable()
export class NativeSessionService {
  private readonly centralChecks = new IdentityInspectionCache(process.env.COBUILD_IDENTITY_MODE === 'local' ? 0 : 15_000);
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private config: ConfigService,
    private users: UserRepo,
    private sessions: UserSessionRepo,
  ) {}
  async inherit(parent: string, child: string, trx: any) {
    const source = await trx
      .selectFrom('labIdentitySessions')
      .selectAll()
      .where('sessionId', '=', parent)
      .executeTakeFirst();
    if (source)
      await trx
        .insertInto('labIdentitySessions')
        .values({
          ...source,
          sessionId: child,
          sealedGrant: sealIdentity(
            unsealIdentity(
              source.sealedGrant,
              parent,
              this.config.get('APP_SECRET', ''),
            ),
            child,
            this.config.get('APP_SECRET', ''),
          ),
        })
        .execute();
  }
  async validate(userId: string, workspaceId: string, sessionId: string) {
    if (!sessionId) throw new UnauthorizedException();
    const [identity, user, session] = await Promise.all([
      this.config.get('COBUILD_IDENTITY_MODE') === 'local' ? this.db.selectFrom('suiteIdentityAccounts').selectAll().where('userId','=',userId).where('workspaceId','=',workspaceId).where('issuer','=',this.config.get('LAB_IDENTITY_ORIGIN','')).executeTakeFirst() : this.db
        .selectFrom('feishuIdentities')
        .select(['userId', 'directoryStatus', 'directoryCheckedAt'])
        .where('userId', '=', userId)
        .where('workspaceId', '=', workspaceId)
        .where('appId', '=', this.config.get('FEISHU_APP_ID', ''))
        .where('tenantKey', '=', this.config.get('FEISHU_TENANT_KEY', ''))
        .executeTakeFirst(),
      this.users.findById(userId, workspaceId),
      this.sessions.findActiveById(sessionId),
    ]);
    if (
      !identity ||
      !user ||
      isUserDisabled(user) ||
      !session ||
      session.userId !== userId ||
      session.workspaceId !== workspaceId
    )
      throw new UnauthorizedException();
    if (this.config.get('COBUILD_IDENTITY_MODE') === 'local') { /* Central membership is checked below on every request. */ }
    else if (directoryEnabled(this.config)) assertDirectoryAccess(identity);
    else if (
      identity.directoryStatus &&
      !['unknown', 'active'].includes(identity.directoryStatus)
    )
      throw new UnauthorizedException();
    const central = await this.db
      .selectFrom('labIdentitySessions')
      .selectAll()
      .where('sessionId', '=', sessionId)
      .executeTakeFirst();
    // Existing direct Feishu sessions must reconnect once when the workspace
    // adopts the central identity. Otherwise they would bypass central logout.
    if (this.config.get('LAB_IDENTITY_ENABLED') === 'true' && !central)
      throw new UnauthorizedException();
    if (central) {
      if (
        this.config.get('LAB_IDENTITY_ENABLED') !== 'true' ||
        new Date(central.expiresAt).getTime() <= Date.now()
      )
        throw new UnauthorizedException();
      await this.centralChecks.verify(
        sessionId,
        JSON.stringify([
          central.subject,
          central.sealedGrant,
          central.expiresAt,
        ]),
        new Date(central.expiresAt).getTime(),
        async () => {
          const profile = await identityRequest(this.config, 'inspect', {
            token: unsealIdentity(
              central.sealedGrant,
              sessionId,
              this.config.get('APP_SECRET', ''),
            ),
          });
          if (profile.subject !== central.subject || this.config.get('COBUILD_IDENTITY_MODE') === 'local' && ('subject' in identity ? identity.subject : undefined) !== profile.subject)
            throw new UnauthorizedException();
          return Date.parse(profile.expiresAt);
        },
      );
      const latest = await this.sessions.findActiveById(sessionId);
      if (!latest) throw new UnauthorizedException();
    }
    if (this.config.get('COBUILD_IDENTITY_MODE') === 'local') await refreshManagedAccess(this.db, this.config, identity);
    return user;
  }
}
