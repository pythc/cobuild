import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, Transaction, sql } from 'kysely';
import { v7 as uuid7 } from 'uuid';
import { generateSlugId } from '../../../common/helpers';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';

// Called inside the directory status transaction. Only authoritative departures
// enqueue a transfer; loss of scope, frozen accounts and API errors never do.
export async function queuePersonalHandoff(
  trx: Transaction<any>,
  userId: string,
  workspaceId: string,
  status: string,
) {
  if (!['resigned', 'exited'].includes(status)) return;
  const user = await trx
    .selectFrom('users')
    .select('name')
    .where('id', '=', userId)
    .executeTakeFirst();
  const space = await trx
    .selectFrom('spaces')
    .select('id')
    .where('creatorId', '=', userId)
    .where('workspaceId', '=', workspaceId)
    .where('isPersonal', '=', true)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (!space || !user) return;
  await trx
    .insertInto('personalHandoffs')
    .values({
      sourceSpaceId: space.id,
      userId,
      workspaceId,
      memberName: user.name,
      reason: status,
    })
    .onConflict((o) => o.column('sourceSpaceId').doNothing())
    .execute();
}

export async function ensurePersonalSpace(
  trx: Transaction<any>,
  userId: string,
  workspaceId: string,
) {
  await sql`select pg_advisory_xact_lock(hashtext(${workspaceId + ':personal:' + userId}))`.execute(
    trx,
  );
  const existing = await trx
    .selectFrom('spaces')
    .selectAll()
    .where('creatorId', '=', userId)
    .where('workspaceId', '=', workspaceId)
    .where('isPersonal', '=', true)
    .where('deletedAt', 'is', null)
    .executeTakeFirst();
  if (existing) return existing;
  const user = await trx
    .selectFrom('users')
    .select('id')
    .where('id', '=', userId)
    .where('workspaceId', '=', workspaceId)
    .where('deletedAt', 'is', null)
    .where('deactivatedAt', 'is', null)
    .executeTakeFirst();
  if (!user)
    throw new ServiceUnavailableException(
      'Personal space owner is unavailable',
    );
  const id = uuid7();
  const space = await trx
    .insertInto('spaces')
    .values({
      id,
      workspaceId,
      creatorId: userId,
      isPersonal: true,
      name: '我的知识库',
      slug: 'personal-' + id,
      visibility: 'private',
      settings: { sharing: { disabled: true } },
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await trx
    .insertInto('spaceMembers')
    .values({ spaceId: id, userId, role: 'admin' })
    .execute();
  return space;
}

@Injectable()
export class PersonalSpaceService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PersonalSpaceService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(
    @InjectKysely() private readonly db: Kysely<any>,
    private readonly config: ConfigService,
  ) {}
  onApplicationBootstrap() {
    if (this.config.get('PERSONAL_KNOWLEDGE_ENABLED') !== 'true') return;
    void this.reconcile();
    this.timer = setInterval(() => void this.reconcile(), 60000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async forUser(userId: string, workspaceId: string) {
    if (this.config.get('PERSONAL_KNOWLEDGE_ENABLED') !== 'true')
      throw new ServiceUnavailableException(
        'Personal knowledge is unavailable',
      );
    return this.db.transaction().execute(async (trx) => {
      const identity = await trx
        .selectFrom('feishuIdentities')
        .select('directoryStatus')
        .where('userId', '=', userId)
        .where('workspaceId', '=', workspaceId)
        .forUpdate()
        .executeTakeFirst();
      if (identity?.directoryStatus !== 'active')
        throw new ServiceUnavailableException(
          'Personal space owner is unavailable',
        );
      return ensurePersonalSpace(trx, userId, workspaceId);
    });
  }
  async reconcile() {
    if (this.running) return;
    this.running = true;
    try {
      // Each user's provisioning/transfer is a separate, restart-safe transaction.
      const members = await this.db
        .selectFrom('users as u')
        .innerJoin('feishuIdentities as i', 'i.userId', 'u.id')
        .select([
          'u.id',
          'u.workspaceId',
          'u.deletedAt',
          'u.deactivatedAt',
          'i.directoryStatus',
        ])
        .execute();
      for (const u of members) {
        await this.db.transaction().execute(async (trx) => {
          // Serialize with event/snapshot updates. Never recreate a space after an
          // authoritative departure based on an older list read.
          const identity = await trx
            .selectFrom('feishuIdentities')
            .select('directoryStatus')
            .where('userId', '=', u.id)
            .forUpdate()
            .executeTakeFirst();
          if (
            identity?.directoryStatus === 'active' &&
            !u.deletedAt &&
            !u.deactivatedAt
          )
            await ensurePersonalSpace(trx, u.id, u.workspaceId);
          else if (identity)
            await queuePersonalHandoff(
              trx,
              u.id,
              u.workspaceId,
              identity.directoryStatus,
            );
        });
      }
      const pending = await this.db
        .selectFrom('personalHandoffs')
        .select('sourceSpaceId')
        .where('state', '=', 'pending')
        .limit(20)
        .execute();
      for (const job of pending) {
        try {
          await this.transfer(job.sourceSpaceId);
        } catch {
          await this.db
            .updateTable('personalHandoffs')
            .set({
              attempts: sql`attempts + 1`,
              errorCode: 'transfer_unavailable',
            })
            .where('sourceSpaceId', '=', job.sourceSpaceId)
            .where('state', '=', 'pending')
            .execute();
          this.logger.warn('Personal knowledge handoff pending; will retry');
        }
      }
    } catch {
      this.logger.warn(
        'Personal knowledge reconciliation unavailable; will retry',
      );
    } finally {
      this.running = false;
    }
  }
  async transfer(sourceSpaceId: string) {
    return this.db.transaction().execute(async (trx) => {
      // Global transfer lock orders concurrent handoffs to the same recipient.
      await sql`select pg_advisory_xact_lock(hashtext('personal-knowledge-handoff'))`.execute(
        trx,
      );
      const initial = await trx
        .selectFrom('personalHandoffs')
        .selectAll()
        .where('sourceSpaceId', '=', sourceSpaceId)
        .executeTakeFirst();
      if (!initial || initial.state !== 'pending') return;
      const identity = await trx
        .selectFrom('feishuIdentities')
        .select('directoryStatus')
        .where('userId', '=', initial.userId)
        .forUpdate()
        .executeTakeFirst();
      const job = await trx
        .selectFrom('personalHandoffs')
        .selectAll()
        .where('sourceSpaceId', '=', sourceSpaceId)
        .forUpdate()
        .executeTakeFirst();
      if (!job || job.state !== 'pending') return;
      if (identity?.directoryStatus === 'active') {
        // A corrected directory event before transfer cancels the pending job.
        await trx
          .deleteFrom('personalHandoffs')
          .where('sourceSpaceId', '=', sourceSpaceId)
          .execute();
        return;
      }
      const recipientId = this.config.get<string>(
        'PERSONAL_KNOWLEDGE_RECIPIENT_ID',
      );
      if (!recipientId || recipientId === job.userId)
        throw new Error('Recipient is unavailable');
      const recipient = await trx
        .selectFrom('users')
        .innerJoin('feishuIdentities', 'feishuIdentities.userId', 'users.id')
        .select('users.id')
        .where('users.id', '=', recipientId)
        .where('users.workspaceId', '=', job.workspaceId)
        .where('users.deletedAt', 'is', null)
        .where('users.deactivatedAt', 'is', null)
        .where('users.role', '=', 'owner')
        .where('feishuIdentities.directoryStatus', '=', 'active')
        .executeTakeFirst();
      if (!recipient) throw new Error('Recipient is unavailable');
      const target = await ensurePersonalSpace(
        trx,
        recipientId,
        job.workspaceId,
      );
      // Match normal page hierarchy mutation lock order; lock all pages before
      // reparenting so in-flight saves cannot write the old space metadata back.
      for (const id of [sourceSpaceId, target.id].sort())
        await sql`select pg_advisory_xact_lock(hashtext('page-hierarchy'), hashtext(${id}))`.execute(
          trx,
        );
      const source = await trx
        .selectFrom('spaces')
        .selectAll()
        .where('id', '=', sourceSpaceId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !source ||
        !source.isPersonal ||
        source.creatorId !== job.userId ||
        source.deletedAt
      )
        throw new Error('Source changed');
      const pages = await trx
        .selectFrom('pages')
        .select(['id', 'parentPageId'])
        .where('spaceId', '=', sourceSpaceId)
        .forUpdate()
        .execute();
      // Separate the recipient's editor room from any still-open departed client.
      // The personal-only release can run before the optional Office migration.
      const officeTable = await sql<{
        name: string | null;
      }>`select to_regclass('office_sessions')::text as name`.execute(trx);
      if (officeTable.rows[0]?.name && pages.length) {
        await trx
          .updateTable('officeSessions')
          .set({ closedAt: new Date() })
          .where(
            'pageId',
            'in',
            pages.map((page) => page.id),
          )
          .where('closedAt', 'is', null)
          .execute();
      }
      const folderId = uuid7();
      const last = await trx
        .selectFrom('pages')
        .select('position')
        .where('spaceId', '=', target.id)
        .where('parentPageId', 'is', null)
        .where('deletedAt', 'is', null)
        .orderBy('position', 'desc')
        .limit(1)
        .executeTakeFirst();
      await trx
        .insertInto('pages')
        .values({
          id: folderId,
          title: job.memberName,
          icon: '📁',
          slugId: generateSlugId(),
          creatorId: recipientId,
          lastUpdatedById: recipientId,
          workspaceId: job.workspaceId,
          spaceId: target.id,
          position: generateJitteredKeyBetween(last?.position ?? null, null),
          content: { type: 'doc', content: [{ type: 'paragraph' }] },
        })
        .execute();
      // Keep original IDs, Yjs bytes, content, trash state and authors. Cross-space
      // references remain the same document IDs; only location metadata changes.
      if (pages.length) {
        const ids = pages.map((p) => p.id);
        const roots = pages
          .filter((p) => !p.parentPageId || !ids.includes(p.parentPageId))
          .map((p) => p.id);
        await trx
          .updateTable('pages')
          .set({ spaceId: target.id })
          .where('spaceId', '=', sourceSpaceId)
          .execute();
        if (roots.length)
          await trx
            .updateTable('pages')
            .set({ parentPageId: folderId })
            .where('id', 'in', roots)
            .execute();
        for (const table of [
          'attachments',
          'comments',
          'pageHistory',
          'notifications',
          'pageAccess',
          'pageVerifications',
        ])
          await trx
            .updateTable(table)
            .set({ spaceId: target.id })
            .where('pageId', 'in', ids)
            .execute();
        // No inherited grants, public links or subscriptions survive transfer.
        await trx.deleteFrom('pageAccess').where('pageId', 'in', ids).execute();
        await trx.deleteFrom('watchers').where('pageId', 'in', ids).execute();
        await trx
          .deleteFrom('favorites')
          .where('pageId', 'in', ids)
          .where('userId', '!=', recipientId)
          .execute();
        await trx.deleteFrom('shares').where('pageId', 'in', ids).execute();
      }
      await trx
        .updateTable('spaces')
        .set({ deletedAt: new Date() })
        .where('id', '=', sourceSpaceId)
        .execute();
      await trx
        .updateTable('personalHandoffs')
        .set({
          state: 'done',
          recipientId,
          folderId,
          pageCount: pages.length,
          attempts: sql`attempts + 1`,
          errorCode: null,
          finishedAt: new Date(),
        })
        .where('sourceSpaceId', '=', sourceSpaceId)
        .execute();
    });
  }
}
