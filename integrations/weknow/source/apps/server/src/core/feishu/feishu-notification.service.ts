import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { FeishuApiService, FeishuApiError } from './feishu-api.service';
import {
  directoryEnabled,
  assertDirectoryAccess,
} from './feishu-directory-policy';
import { PageAccessService } from '../page/page-access/page-access.service';
import {
  NotificationType,
  NotificationTypeToSettingKey,
} from '../notification/notification.constants';

const MENTIONS = [
  NotificationType.PAGE_USER_MENTION,
  NotificationType.COMMENT_USER_MENTION,
];

export function feishuMentionContent(
  actor: string,
  title: string,
  url: string,
  comment: boolean,
) {
  // Post-format text nodes avoid Markdown/HTML injection by document titles.
  return {
    zh_cn: {
      title: '有人在' + (comment ? '评论' : '文档') + '中提及你',
      content: [
        [
          {
            tag: 'text',
            text:
              actor.slice(0, 50) +
              ' 在「' +
              title.slice(0, 200) +
              '」中 @ 了你。',
          },
        ],
        [{ tag: 'a', text: '打开文档', href: url }],
      ],
    },
  };
}

@Injectable()
export class FeishuNotificationService {
  private working = false;
  private logger = new Logger(FeishuNotificationService.name);
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private config: ConfigService,
    private api: FeishuApiService,
    private access: PageAccessService,
  ) {}
  get enabled() {
    return (
      directoryEnabled(this.config) &&
      this.config.get('FEISHU_NOTIFICATIONS_ENABLED', 'false') === 'true'
    );
  }
  async sendTest(userId: string, workspaceId: string) {
    if (!this.enabled)
      throw new ServiceUnavailableException('飞书通知尚未启用');
    const identity = await this.db
      .selectFrom('feishuIdentities')
      .selectAll()
      .where('userId', '=', userId)
      .where('workspaceId', '=', workspaceId)
      .where('appId', '=', this.api.appId)
      .where('tenantKey', '=', this.api.tenant)
      .executeTakeFirst();
    assertDirectoryAccess(identity);
    try {
      const response = await this.api.call(
        '/im/v1/messages',
        { receive_id_type: 'open_id' },
        {
          receive_id: identity.subject,
          msg_type: 'text',
          uuid: randomUUID(),
          content: JSON.stringify({
            text: '110lab 知识库通知测试\n飞书通知通道已连接。此消息仅用于验证通知功能。',
          }),
        },
      );
      if (typeof response?.message_id !== 'string') throw new Error();
      return { sent: true };
    } catch {
      throw new ServiceUnavailableException(
        '发送结果未确认，请先在飞书检查后再试',
      );
    }
  }
  async enqueue(trx: Kysely<any>, notification: any) {
    if (
      !this.enabled ||
      !MENTIONS.includes(notification.type) ||
      notification.userId === notification.actorId
    )
      return;
    await trx
      .insertInto('feishuNotificationOutbox')
      .values({ notificationId: notification.id })
      .onConflict((o) => o.doNothing())
      .execute();
  }
  @Interval('feishu-mention-delivery', 5000)
  async deliver() {
    if (!this.enabled || this.working) return;
    this.working = true;
    try {
      // Crashes release a claim after 60 seconds; UUID stays the notification ID.
      for (let i = 0; i < 10; i++) {
        const row = await this.db.transaction().execute(async (trx) => {
          const pending = await trx
            .selectFrom('feishuNotificationOutbox')
            .selectAll()
            .where((eb) =>
              eb.or([
                eb.and([
                  eb('state', '=', 'pending'),
                  eb('nextAttemptAt', '<=', new Date()),
                ]),
                eb.and([
                  eb('state', '=', 'sending'),
                  eb('claimedAt', '<', new Date(Date.now() - 60000)),
                ]),
              ]),
            )
            .orderBy('createdAt', 'asc')
            .forUpdate()
            .skipLocked()
            .limit(1)
            .executeTakeFirst();
          if (!pending) return;
          return trx
            .updateTable('feishuNotificationOutbox')
            .set({
              state: 'sending',
              claimedAt: new Date(),
              attempts: pending.attempts + 1,
            })
            .where('notificationId', '=', pending.notificationId)
            .returningAll()
            .executeTakeFirst();
        });
        if (!row) break;
        await this.send(row);
      }
    } catch {
      this.logger.warn('Feishu notification delivery unavailable');
    } finally {
      this.working = false;
    }
  }
  private async send(row: any) {
    // Retries are confined inside Feishu's documented 1-hour UUID dedup window.
    if (
      Date.now() - new Date(row.createdAt).getTime() > 45 * 60 * 1000 ||
      row.attempts > 8
    ) {
      await this.finish(row.notificationId, 'failed', 'retry_window_expired');
      return;
    }
    try {
      const n = await this.db
        .selectFrom('notifications')
        .selectAll()
        .where('id', '=', row.notificationId)
        .executeTakeFirst();
      if (
        !n ||
        !MENTIONS.includes(n.type) ||
        !n.pageId ||
        n.actorId === n.userId
      ) {
        await this.finish(row.notificationId, 'skipped', 'no_recipient');
        return;
      }
      const identity = await this.db
        .selectFrom('feishuIdentities as f')
        .innerJoin('users as u', 'u.id', 'f.userId')
        .select([
          'f.subject',
          'f.directoryStatus',
          'f.directoryCheckedAt',
          'u.id',
          'u.workspaceId',
          'u.name',
          'u.role',
          'u.settings',
          'u.deletedAt',
          'u.deactivatedAt',
        ])
        .where('f.userId', '=', n.userId)
        .where('f.workspaceId', '=', n.workspaceId)
        .where('f.appId', '=', this.api.appId)
        .where('f.tenantKey', '=', this.api.tenant)
        .executeTakeFirst();
      if (
        !identity ||
        identity.deletedAt ||
        identity.deactivatedAt ||
        identity.directoryStatus !== 'active'
      ) {
        await this.finish(row.notificationId, 'skipped', 'member_unavailable');
        return;
      }
      assertDirectoryAccess(identity);
      const settingKey = NotificationTypeToSettingKey[n.type];
      if (identity.settings?.notifications?.[settingKey] === false) {
        await this.finish(row.notificationId, 'skipped', 'preference_disabled');
        return;
      }
      const [page, actor] = await Promise.all([
        this.db
          .selectFrom('pages')
          .selectAll()
          .where('id', '=', n.pageId)
          .where('workspaceId', '=', n.workspaceId)
          .executeTakeFirst(),
        this.db
          .selectFrom('users')
          .select('name')
          .where('id', '=', n.actorId)
          .where('workspaceId', '=', n.workspaceId)
          .executeTakeFirst(),
      ]);
      if (!page || page.deletedAt || !actor) {
        await this.finish(row.notificationId, 'skipped', 'page_unavailable');
        return;
      }
      try {
        await this.access.validateCanView(page as any, identity as any);
      } catch {
        await this.finish(row.notificationId, 'skipped', 'no_page_access');
        return;
      }
      const origin = this.config.get<string>('APP_URL', '').replace(/\/$/, '');
      const url =
        origin +
        '/p/' +
        encodeURIComponent(page.slugId) +
        (n.commentId
          ? '?commentId=' + encodeURIComponent(n.commentId)
          : '?mention=' + encodeURIComponent(n.userId));
      const data = await this.api.call(
        '/im/v1/messages',
        { receive_id_type: 'open_id' },
        {
          receive_id: identity.subject,
          msg_type: 'post',
          uuid: n.id,
          content: JSON.stringify(
            feishuMentionContent(
              actor.name,
              page.title || '未命名文档',
              url,
              n.type === NotificationType.COMMENT_USER_MENTION,
            ),
          ),
        },
      );
      if (typeof data?.message_id !== 'string')
        throw new FeishuApiError('invalid_message_response', true);
      await this.db
        .updateTable('feishuNotificationOutbox')
        .set({
          state: 'sent',
          messageId: data.message_id,
          finishedAt: new Date(),
          errorCode: null,
        })
        .where('notificationId', '=', n.id)
        .execute();
    } catch (e) {
      const code =
        e instanceof FeishuApiError
          ? e.code
          : 'directory_temporarily_unavailable';
      if (!(e instanceof FeishuApiError) || e.retryable) {
        await this.db
          .updateTable('feishuNotificationOutbox')
          .set({
            state: 'pending',
            errorCode: code,
            nextAttemptAt: new Date(
              Date.now() + Math.min(120000, 5000 * 2 ** row.attempts),
            ),
          })
          .where('notificationId', '=', row.notificationId)
          .execute();
      } else await this.finish(row.notificationId, 'failed', code);
    }
  }
  private finish(id: string, state: string, errorCode: string) {
    return this.db
      .updateTable('feishuNotificationOutbox')
      .set({ state, errorCode, finishedAt: new Date() })
      .where('notificationId', '=', id)
      .execute();
  }
  async status(workspaceId: string) {
    const counts = await this.db
      .selectFrom('feishuNotificationOutbox as o')
      .innerJoin('notifications as n', 'n.id', 'o.notificationId')
      .select(['o.state', sql<number>`count(*)::int`.as('count')])
      .where('n.workspaceId', '=', workspaceId)
      .groupBy('o.state')
      .execute();
    return { enabled: this.enabled, counts };
  }
}
