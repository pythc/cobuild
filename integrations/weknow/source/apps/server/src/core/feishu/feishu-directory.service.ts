import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction, sql } from 'kysely';
import { FeishuApiService, FeishuApiError } from './feishu-api.service';
import {
  FeishuDirectoryProvider,
  DirectorySnapshot,
} from './feishu-directory-provider';
import {
  DIRECTORY_INTERVAL_MS,
  directoryEnabled,
  DirectoryStatus,
  assertDirectoryAccess,
} from './feishu-directory-policy';
import { hashState } from '../auth/feishu/feishu-policy';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import {
  invalidateDepartmentGroup,
  removeUserFromDepartmentGroups,
  syncDepartmentGroups,
} from './feishu-department-sync';
import { queuePersonalHandoff } from '../space/services/personal-space.service';
import { GroupUserRepo } from '@docmost/db/repos/group/group-user.repo';

@Injectable()
export class FeishuDirectoryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private logger = new Logger(FeishuDirectoryService.name);
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<any>;
  private requested = false;
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private config: ConfigService,
    private api: FeishuApiService,
    private provider: FeishuDirectoryProvider,
    private users: UserRepo,
    private groups: GroupUserRepo,
  ) {}
  get enabled() {
    return directoryEnabled(this.config);
  }
  onApplicationBootstrap() {
    if (!this.enabled) return;
    void this.sync('startup');
    this.timer = setInterval(
      () => void this.sync('scheduled'),
      DIRECTORY_INTERVAL_MS,
    );
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  requestSync() {
    if (this.pending) this.requested = true;
    else void this.sync('event');
  }
  async ensureMember(subject: string) {
    const find = () =>
      this.db
        .selectFrom('feishuIdentities')
        .selectAll()
        .where('appId', '=', this.api.appId)
        .where('tenantKey', '=', this.api.tenant)
        .where('subject', '=', subject)
        .executeTakeFirst();
    let identity = await find();
    if (
      !identity?.directoryCheckedAt ||
      Date.now() - new Date(identity.directoryCheckedAt).getTime() >
        DIRECTORY_INTERVAL_MS ||
      identity.directoryStatus !== 'active'
    ) {
      await this.sync('login');
      identity = await find();
    }
    assertDirectoryAccess(identity);
  }
  async sync(source = 'manual'): Promise<any> {
    if (!this.enabled) return { status: 'disabled' };
    if (this.pending) return this.pending;
    this.pending = this.run(source);
    try {
      return await this.pending;
    } catch {
      this.logger.warn('Feishu member sync unavailable');
      return { status: 'failed', errorCode: 'sync_unavailable' };
    } finally {
      this.pending = undefined;
      if (this.requested) {
        this.requested = false;
        void this.sync('event');
      }
    }
  }
  private async run(source: string) {
    // Session-level advisory lock on a dedicated transaction prevents concurrent
    // processes from publishing snapshots out of order, including during upgrades.
    return this.db.transaction().execute(async (lock) => {
      const { rows } = await sql<{
        locked: boolean;
      }>`select pg_try_advisory_xact_lock(hashtext(${this.api.appId + ':directory-sync'})) as locked`.execute(
        lock,
      );
      if (!rows[0].locked) return { status: 'busy' };
      const run = await this.db
        .insertInto('feishuSyncRuns')
        .values({
          appId: this.api.appId,
          tenantKey: this.api.tenant,
          source,
          startedAt: new Date(),
          status: 'running',
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      try {
        const snapshot = await this.provider.snapshot({
          includeDepartments:
            this.config.get('FEISHU_DEPARTMENT_SYNC_ENABLED', 'false') ===
            'true',
        });
        const stats = await this.applySnapshot(snapshot);
        await this.db
          .updateTable('feishuSyncRuns')
          .set({ ...stats, status: 'success', finishedAt: new Date() })
          .where('id', '=', run.id)
          .execute();
        return { status: 'success', ...stats };
      } catch (e) {
        const errorCode = e instanceof FeishuApiError ? e.code : 'sync_failed';
        await this.db
          .updateTable('feishuSyncRuns')
          .set({ status: 'failed', errorCode, finishedAt: new Date() })
          .where('id', '=', run.id)
          .execute();
        this.logger.warn('Feishu member sync failed: ' + errorCode);
        return { status: 'failed', errorCode };
      }
    });
  }

  private async applySnapshot(snapshot: DirectorySnapshot) {
    return this.db.transaction().execute(async (trx) => {
      const workspace = await trx
        .selectFrom('workspaces')
        .select('id')
        .orderBy('createdAt', 'asc')
        .limit(1)
        .executeTakeFirst();
      if (!workspace) throw new FeishuApiError('workspace_not_initialized');
      const stats = {
        total: snapshot.members.length,
        added: 0,
        updated: 0,
        blocked: 0,
      };
      const present = new Set<string>();
      for (const member of snapshot.members) {
        present.add(member.subject);
        await sql`select pg_advisory_xact_lock(hashtext(${this.api.appId + ':' + this.api.tenant + ':' + member.subject}))`.execute(
          trx,
        );
        let identity = await trx
          .selectFrom('feishuIdentities')
          .selectAll()
          .where('appId', '=', this.api.appId)
          .where('tenantKey', '=', this.api.tenant)
          .where('subject', '=', member.subject)
          .forUpdate()
          .executeTakeFirst();
        if (!identity) {
          if (member.status !== 'active') continue;
          const user = await this.users.insertUser(
            {
              name: member.name,
              email:
                hashState(this.api.tenant + ':' + member.subject) +
                '@feishu.110lab.invalid',
              password: null,
              role: 'member',
              workspaceId: workspace.id,
              locale: 'zh-CN',
              avatarUrl: member.avatarUrl,
            },
            trx,
          );
          await this.groups.addUserToDefaultGroup(user.id, workspace.id, trx);
          identity = await trx
            .insertInto('feishuIdentities')
            .values({
              provider: 'feishu',
              appId: this.api.appId,
              tenantKey: this.api.tenant,
              subject: member.subject,
              userId: user.id,
              workspaceId: workspace.id,
              directoryStatus: member.status,
              directoryCheckedAt: snapshot.startedAt,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          stats.added++;
        } else {
          // Never undo a negative event received after this network snapshot began.
          if (
            identity.lastEventAt &&
            new Date(identity.lastEventAt) > snapshot.startedAt
          )
            continue;
          const user = await this.users.findById(
            identity.userId,
            identity.workspaceId,
            { trx },
          );
          if (!user || user.deletedAt) {
            await this.revoke(trx, identity.userId, identity.workspaceId);
            continue;
          }
          await this.users.updateUser(
            { name: member.name, avatarUrl: member.avatarUrl },
            user.id,
            user.workspaceId,
            trx,
          );
          await trx
            .updateTable('feishuIdentities')
            .set({
              directoryStatus: member.status,
              directoryCheckedAt: snapshot.startedAt,
            })
            .where('id', '=', identity.id)
            .execute();
          stats.updated++;
          if (member.status === 'active' && !user.deactivatedAt) {
            // Repair missing memberships and rejoin reactivated Feishu members.
            await this.groups.addUserToDefaultGroup(
              user.id,
              user.workspaceId,
              trx,
            );
          } else if (member.status === 'active') {
            await this.groups.removeUserFromDefaultGroup(
              user.id,
              user.workspaceId,
              trx,
            );
          }
        }
        if (member.status !== 'active') {
          await queuePersonalHandoff(trx, identity.userId, identity.workspaceId, member.status);
          await this.revoke(trx, identity.userId, identity.workspaceId);
          stats.blocked++;
        }
      }
      const identities = await trx
        .selectFrom('feishuIdentities')
        .selectAll()
        .where('appId', '=', this.api.appId)
        .where('tenantKey', '=', this.api.tenant)
        .forUpdate()
        .execute();
      for (const identity of identities) {
        if (
          present.has(identity.subject) ||
          (identity.lastEventAt &&
            new Date(identity.lastEventAt) > snapshot.startedAt)
        )
          continue;
        await trx
          .updateTable('feishuIdentities')
          .set({
            directoryStatus: 'out_of_scope',
            directoryCheckedAt: snapshot.startedAt,
          })
          .where('id', '=', identity.id)
          .execute();
        await this.revoke(trx, identity.userId, identity.workspaceId);
        stats.blocked++;
      }
      await syncDepartmentGroups(
        trx,
        {
          appId: this.api.appId,
          tenant: this.api.tenant,
          workspaceId: workspace.id,
        },
        snapshot.departments ?? [],
        snapshot.startedAt,
      );
      return stats;
    });
  }

  async receiveEvent(event: any, type: string) {
    if (
      !this.enabled ||
      event?.app_id !== this.api.appId ||
      event?.tenant_key !== this.api.tenant ||
      typeof event?.event_id !== 'string' ||
      !event.event_id ||
      event.event_id.length > 256
    )
      return;
    const member = event.object;
    const isUserEvent = type.startsWith('contact.user.');
    const negative: DirectoryStatus | undefined = !isUserEvent
      ? undefined
      : type === 'contact.user.deleted_v3'
        ? 'resigned'
        : member?.status?.is_resigned
          ? 'resigned'
          : member?.status?.is_exited
            ? 'exited'
            : member?.status?.is_frozen
              ? 'frozen'
              : member?.status?.is_activated === false
                ? 'unactivated'
                : undefined;
    await this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('feishuEvents')
        .values({ eventId: event.event_id })
        .onConflict((o) => o.doNothing())
        .returning('eventId')
        .executeTakeFirst();
      if (!inserted) return;
      if (
        type === 'contact.department.deleted_v3' &&
        typeof member?.open_department_id === 'string'
      ) {
        const workspace = await trx
          .selectFrom('workspaces')
          .select('id')
          .orderBy('createdAt', 'asc')
          .limit(1)
          .executeTakeFirst();
        if (workspace)
          await invalidateDepartmentGroup(
            trx,
            {
              appId: this.api.appId,
              tenant: this.api.tenant,
              workspaceId: workspace.id,
            },
            member.open_department_id,
          );
      }
      if (negative && typeof member?.open_id === 'string') {
        const identity = await trx
          .selectFrom('feishuIdentities')
          .selectAll()
          .where('appId', '=', this.api.appId)
          .where('tenantKey', '=', this.api.tenant)
          .where('subject', '=', member.open_id)
          .forUpdate()
          .executeTakeFirst();
        if (identity) {
          await trx
            .updateTable('feishuIdentities')
            .set({ directoryStatus: negative, lastEventAt: new Date() })
            .where('id', '=', identity.id)
            .execute();
          await this.revoke(trx, identity.userId, identity.workspaceId);
          await queuePersonalHandoff(trx, identity.userId, identity.workspaceId, negative);
        }
      }
    });
    this.requestSync();
  }
  private async revoke(
    trx: Transaction<any>,
    userId: string,
    workspaceId: string,
  ) {
    await this.groups.removeUserFromDefaultGroup(userId, workspaceId, trx);
    await removeUserFromDepartmentGroups(
      trx,
      { appId: this.api.appId, tenant: this.api.tenant, workspaceId },
      userId,
    );
    return trx
      .updateTable('userSessions')
      .set({ revokedAt: new Date() })
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('revokedAt', 'is', null)
      .execute();
  }
  async status(workspaceId: string) {
    const runs = await this.db
      .selectFrom('feishuSyncRuns')
      .selectAll()
      .where('appId', '=', this.api.appId)
      .where('tenantKey', '=', this.api.tenant)
      .orderBy('id', 'desc')
      .limit(10)
      .execute();
    const members = await this.db
      .selectFrom('feishuIdentities as f')
      .innerJoin('users as u', 'u.id', 'f.userId')
      .select([
        'u.id',
        'u.name',
        'u.avatarUrl',
        'u.role',
        'u.deactivatedAt',
        'f.directoryStatus',
        'f.directoryCheckedAt',
      ])
      .where('f.workspaceId', '=', workspaceId)
      .where('f.appId', '=', this.api.appId)
      .where('f.tenantKey', '=', this.api.tenant)
      .where('u.deletedAt', 'is', null)
      .orderBy('u.name', 'asc')
      .limit(10000)
      .execute();
    return {
      enabled: this.enabled,
      intervalSeconds: DIRECTORY_INTERVAL_MS / 1000,
      maxAgeSeconds: 900,
      runs,
      members,
    };
  }
}
