import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectKysely } from 'nestjs-kysely';
import { Kysely, sql } from 'kysely';
import { randomInt } from 'node:crypto';
import { Interval } from '@nestjs/schedule';
import { z } from 'zod';
import { MailService } from '../../integrations/mail/mail.service';
import { PageAccessService } from '../page/page-access/page-access.service';
import { KnowledgeOAuthService } from './knowledge-oauth.service';
import { hash, same } from './knowledge-policy';
import {
  NotificationType,
  NotificationTypeToSettingKey,
} from '../notification/notification.constants';
import { FeishuApiService } from '../feishu/feishu-api.service';
import { assertDirectoryAccess } from '../feishu/feishu-directory-policy';

@Injectable()
export class KnowledgeMailService {
  private working = false;
  constructor(
    @InjectKysely() private db: Kysely<any>,
    private config: ConfigService,
    private mail: MailService,
    private access: PageAccessService,
    private oauth: KnowledgeOAuthService,
    private feishu: FeishuApiService,
  ) {}
  get enabled() {
    return (
      this.config.get('KNOWLEDGE_MAIL_ENABLED', 'false') === 'true' &&
      this.config.get('MAIL_DRIVER') === 'smtp'
    );
  }
  async profile(user: any) {
    const p = await this.db
      .selectFrom('knowledgeMailProfiles')
      .select(['email', 'verifiedAt', 'enabled'])
      .where('userId', '=', user.id)
      .executeTakeFirst();
    return {
      available: this.enabled,
      ...(p || { email: null, verifiedAt: null, enabled: false }),
    };
  }
  async request(user: any, email: unknown) {
    if (!this.enabled)
      throw new ServiceUnavailableException(
        '邮件提醒尚未配置',
      );
    const parsed = z.email().max(254).safeParse(email);
    if (!parsed.success) throw new BadRequestException('邮箱地址格式不正确');
    const value = parsed.data.toLowerCase(),
      code = String(randomInt(100000, 1000000));
    await this.db.transaction().execute(async (t) => {
      await sql`select pg_advisory_xact_lock(hashtext(${'knowledge:mail:' + user.id}))`.execute(
        t,
      );
      const previous = await t
        .selectFrom('knowledgeMailVerification')
        .selectAll()
        .where('userId', '=', user.id)
        .executeTakeFirst();
      if (
        previous &&
        new Date(previous.createdAt).getTime() > Date.now() - 60000
      )
        throw new BadRequestException('请稍后再发送验证码');
      // Per-member daily limit is persisted, not a client-side timer.
      const day = new Date().toISOString().slice(0, 10);
      await sql`select pg_advisory_xact_lock(hashtext('knowledge:mail:daily'))`.execute(
        t,
      );
      for (const [key, maximum] of [
        [day + ':' + user.id, 4],
        [day + ':global', 100],
      ] as const) {
        const quota = await t
          .selectFrom('knowledgeMailQuota')
          .select('count')
          .where('key', '=', key)
          .executeTakeFirst();
        if (quota && quota.count >= maximum)
          throw new BadRequestException(
            '今日验证码发送次数已达上限',
          );
        await t
          .insertInto('knowledgeMailQuota')
          .values({ key, count: 1 })
          .onConflict((c) =>
            c
              .column('key')
              .doUpdateSet({ count: sql`knowledge_mail_quota.count + 1` }),
          )
          .execute();
      }
      await t
        .insertInto('knowledgeMailVerification')
        .values({
          userId: user.id,
          email: value,
          codeHash: hash(user.id + '\n' + value + '\n' + code),
          expiresAt: new Date(Date.now() + 600000),
          attempts: 0,
          createdAt: new Date(),
        })
        .onConflict((c) =>
          c.column('userId').doUpdateSet({
            email: value,
            codeHash: hash(user.id + '\n' + value + '\n' + code),
            expiresAt: new Date(Date.now() + 600000),
            attempts: 0,
            createdAt: new Date(),
          }),
        )
        .execute();
    });
    try {
      await this.mail.sendEmail({
        to: value,
        subject: '110lab 知识库邮箱验证',
        text: `验证码：${code}\n10 分钟内有效。此操作仅绑定通知邮箱，不改变飞书登录。`,
      });
    } catch {
      throw new ServiceUnavailableException(
        '发送结果未确认，请先检查邮箱后再试',
      );
    }
    return { requested: true };
  }
  async verify(user: any, code: unknown) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code))
      throw new BadRequestException('请输入6位验证码');
    const ok = await this.db.transaction().execute(async (t) => {
      const row = await t
        .selectFrom('knowledgeMailVerification')
        .selectAll()
        .where('userId', '=', user.id)
        .forUpdate()
        .executeTakeFirst();
      if (
        !row ||
        row.attempts >= 5 ||
        new Date(row.expiresAt).getTime() <= Date.now()
      )
        return false;
      await t
        .updateTable('knowledgeMailVerification')
        .set({ attempts: row.attempts + 1 })
        .where('userId', '=', user.id)
        .execute();
      if (!same(row.codeHash, hash(user.id + '\n' + row.email + '\n' + code)))
        return false;
      await t
        .insertInto('knowledgeMailProfiles')
        .values({
          userId: user.id,
          workspaceId: user.workspaceId,
          email: row.email,
          verifiedAt: new Date(),
          enabled: true,
        })
        .onConflict((c) =>
          c.column('userId').doUpdateSet({
            email: row.email,
            verifiedAt: new Date(),
            enabled: true,
          }),
        )
        .execute();
      await t
        .deleteFrom('knowledgeMailVerification')
        .where('userId', '=', user.id)
        .execute();
      return true;
    });
    if (!ok) throw new BadRequestException('验证码不正确或已过期');
    return { verified: true };
  }
  async toggle(user: any, enabled: boolean) {
    const row = await this.db
      .updateTable('knowledgeMailProfiles')
      .set({ enabled })
      .where('userId', '=', user.id)
      .where('verifiedAt', 'is not', null)
      .returning('userId')
      .executeTakeFirst();
    if (!row) throw new BadRequestException('请先验证通知邮箱');
    return { enabled };
  }
  async enqueue(t: Kysely<any>, notification: any) {
    if (
      !this.enabled ||
      notification.userId === notification.actorId ||
      ![
        NotificationType.PAGE_USER_MENTION,
        NotificationType.COMMENT_USER_MENTION,
      ].includes(notification.type)
    )
      return;
    const profile = await t
      .selectFrom('knowledgeMailProfiles')
      .select('userId')
      .where('userId', '=', notification.userId)
      .where('enabled', '=', true)
      .where('verifiedAt', 'is not', null)
      .executeTakeFirst();
    if (profile)
      await t
        .insertInto('knowledgeMailOutbox')
        .values({ notificationId: notification.id })
        .onConflict((c) => c.doNothing())
        .execute();
  }
  @Interval('knowledge-mail-delivery', 5000)
  async deliver() {
    if (!this.enabled || this.working) return;
    this.working = true;
    try {
      for (let i = 0; i < 10; i++) {
        const row = await this.db.transaction().execute(async (t) => {
          const row = await t
            .selectFrom('knowledgeMailOutbox')
            .selectAll()
            .where('state', '=', 'pending')
            .orderBy('createdAt')
            .forUpdate()
            .skipLocked()
            .limit(1)
            .executeTakeFirst();
          if (!row) return;
          await t
            .updateTable('knowledgeMailOutbox')
            .set({ state: 'unknown' })
            .where('notificationId', '=', row.notificationId)
            .execute();
          return row;
        });
        if (!row) break;
        let state = 'skipped';
        try {
          const n = await this.db
              .selectFrom('notifications')
              .selectAll()
              .where('id', '=', row.notificationId)
              .executeTakeFirst(),
            profile =
              n &&
              (await this.db
                .selectFrom('knowledgeMailProfiles')
                .selectAll()
                .where('userId', '=', n.userId)
                .where('enabled', '=', true)
                .where('verifiedAt', 'is not', null)
                .executeTakeFirst());
          if (n && profile) {
            const user = await this.db
                .selectFrom('users')
                .selectAll()
                .where('id', '=', n.userId)
                .where('deactivatedAt', 'is', null)
                .where('deletedAt', 'is', null)
                .executeTakeFirst(),
              page = await this.db
                .selectFrom('pages')
                .selectAll()
                .where('id', '=', n.pageId)
                .where('deletedAt', 'is', null)
                .executeTakeFirst(),
              identity = await this.db
                .selectFrom('feishuIdentities')
                .selectAll()
                .where('userId', '=', n.userId)
                .where('appId', '=', this.feishu.appId)
                .where('tenantKey', '=', this.feishu.tenant)
                .executeTakeFirst();
            assertDirectoryAccess(identity);
            if (
              user &&
              page &&
              page.workspaceId === profile.workspaceId &&
              user.settings?.notifications?.[
                NotificationTypeToSettingKey[n.type]
              ] !== false
            ) {
              await this.access.validateCanView(page as any, user as any);
              await this.mail.sendEmail({
                to: profile.email,
                subject: '110lab 知识库：有人提及你',
                text:
                  '有人在知识库中提及你。\n' +
                  this.oauth.origin +
                  '/p/' +
                  page.slugId +
                  '\n请使用飞书账号登录查看。',
              });
              state = 'accepted';
            }
          }
        } catch {
          state = 'unknown';
        }
        await this.db
          .updateTable('knowledgeMailOutbox')
          .set({ state, finishedAt: new Date() })
          .where('notificationId', '=', row.notificationId)
          .execute();
      }
    } catch {
      /* No automatic resend after uncertain SMTP acceptance. */
    } finally {
      this.working = false;
    }
  }
}
