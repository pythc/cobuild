import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { requirementPlatformUrl } from '../requirements/requirement-links';
import { confirmedWorkflowSource } from './workflow-source.model';
import {
  notificationDelivery,
  notificationDeliveryAttempt,
} from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import {
  deliveryDigest,
  deliveryPolicy,
  requirementDeliveryPlans,
  type DeliveryOutcome,
  type DeliveryPayload,
  type DeliveryPlan,
  type RequirementNotificationEvent,
} from './notification-delivery.model';

export interface DeliveryRow extends Record<string, unknown> {
  id: string;
  event_id: string;
  operation_id: string | null;
  source: DeliveryPlan['source'];
  owner: DeliveryPlan['owner'];
  kind: string;
  template_version: string;
  requirement_id: string | null;
  repository: string | null;
  pull_number: number | null;
  channel: DeliveryPlan['channel'];
  target_id: string;
  target_name: string;
  platform_url: string;
  payload_json: string;
  payload_hash: string;
  policy_mode: string;
  policy_allowed: boolean;
  policy_reason: string;
  state: string;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
  lease_expires_at: string | null;
  message_id: string | null;
  provider_request_id: string | null;
  last_error_code: string | null;
  confirmed_at: string | null;
  _created_at: string;
  _updated_at: string;
}
export interface ClaimedDelivery {
  id: string;
  leaseToken: string;
  eventId: string;
  channel: DeliveryPlan['channel'];
  targetId: string;
  payload: DeliveryPayload;
  idempotencyKey: string;
}
export interface DeliveryResult {
  id: string;
  leaseToken: string;
  outcome: DeliveryOutcome;
  messageId?: string;
  providerRequestId?: string;
  errorCode?: string;
}

export function publicDelivery(row: DeliveryRow): Record<string, unknown> {
  return {
    id: row.id,
    eventId: row.event_id,
    operationId: row.operation_id,
    source: row.source,
    owner: row.owner,
    kind: row.kind,
    requirementId: row.requirement_id,
    repository: row.repository,
    pullNumber: row.pull_number,
    channel: row.channel,
    targetName: row.target_name,
    platformUrl: row.platform_url,
    state: row.state,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    messageId: row.message_id,
    lastErrorCode: row.last_error_code,
    confirmedAt: row.confirmed_at,
    updatedAt: row._updated_at,
  };
}

@Injectable()
export class NotificationDeliveryService {
  constructor(private readonly serviceDatabase: ServiceRoleDatabaseExecutor) {}

  async recordRequirementEvent(
    event: RequirementNotificationEvent,
  ): Promise<{ count: number }> {
    const plans: DeliveryPlan[] = requirementDeliveryPlans(event);
    if (plans.length > 50)
      throw new BadRequestException('通知对象过多，已隔离待核实');
    await this.serviceDatabase.run(
      async (db: PostgresJsDatabase): Promise<void> => {
        for (const plan of plans) await this.insert(db, plan);
      },
    );
    return { count: plans.length };
  }

  async ingestWorkflow(input: {
    eventId: string;
    requirementId: string;
    targetId: string;
    targetName?: string;
    kind: string;
    channel: DeliveryPlan['channel'];
    payload: DeliveryPayload;
    localAllowed: boolean;
  }): Promise<{ id: string; state: string; messageId: string | null }> {
    if (
      !input ||
      !/^rec[A-Za-z0-9]{1,80}$/u.test(input.requirementId || '') ||
      typeof input.eventId !== 'string' ||
      !input.eventId ||
      input.eventId.length > 200 ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(input.targetId || '') ||
      typeof input.kind !== 'string' ||
      input.kind.length > 80 ||
      !['feishu_private', 'feishu_group'].includes(input.channel) ||
      !['interactive', 'post'].includes(input.payload?.type) ||
      input.payload.receiveIdType !==
        (input.channel === 'feishu_group' ? 'chat_id' : 'open_id') ||
      !input.payload.content ||
      typeof input.payload.content !== 'object' ||
      typeof input.localAllowed !== 'boolean'
    )
      throw new BadRequestException('工作流投递事件无效');
    // Old pending scanner events must be explicitly drained/quarantined before cutover.
    if (confirmedWorkflowSource() && !input.eventId.startsWith('native-v1:'))
      throw new ConflictException('旧来源通知需人工核对，未自动补发');
    const policy = deliveryPolicy(
      input.channel,
      input.targetId,
      'requirement_workflow',
    );
    const platformUrl = requirementPlatformUrl(input.requirementId);
    const payload = structuredClone(input.payload);
    if (payload.type === 'post') {
      const content = payload.content as {
        zh_cn?: { title?: string; content?: unknown[][] };
      };
      if (!content.zh_cn || !Array.isArray(content.zh_cn.content))
        throw new BadRequestException('工作流消息格式无效');
      content.zh_cn.content.push([
        { tag: 'a', text: '查看需求', href: platformUrl },
      ]);
    }
    const eventKey = createHash('sha256')
      .update(JSON.stringify([input.eventId, input.kind]))
      .digest('hex');
    const id = await this.record({
      eventId: `legacy:${eventKey}`,
      requirementId: input.requirementId,
      source: 'requirement_workflow',
      owner:
        process.env.WORKFLOW_DELIVERY_OWNER === 'managed_bot'
          ? 'managed_bot'
          : 'shadow',
      kind: input.kind,
      channel: input.channel,
      targetId: input.targetId,
      targetName: input.targetName?.slice(0, 100) || '协作成员 / 群聊',
      templateVersion: 'legacy-workflow-v1',
      platformUrl,
      payload,
      policyMode: policy.mode,
      policyAllowed: policy.allowed && input.localAllowed,
      policyReason: input.localAllowed ? policy.reason : 'source_policy_denied',
    });
    return { id, ...(await this.status(id)) };
  }

  async record(plan: DeliveryPlan, preserveExisting = false): Promise<string> {
    return this.serviceDatabase.run(
      (db: PostgresJsDatabase): Promise<string> =>
        this.insert(db, plan, preserveExisting),
    );
  }

  private async insert(
    db: PostgresJsDatabase,
    plan: DeliveryPlan,
    preserveExisting = false,
  ): Promise<string> {
    const payloadJson: string = JSON.stringify(plan.payload);
    if (
      !plan.eventId ||
      plan.eventId.length > 200 ||
      Buffer.byteLength(payloadJson) > 1000000
    )
      throw new BadRequestException('通知事件格式无效');
    const payloadHash: string = deliveryDigest(plan.payload);
    await db.execute(
      db
        .insert(notificationDelivery)
        .values({
          eventId: plan.eventId,
          operationId: plan.operationId || null,
          source: plan.source,
          owner: plan.owner,
          kind: plan.kind,
          templateVersion: plan.templateVersion,
          requirementId: plan.requirementId || null,
          repository: plan.repository || null,
          pullNumber: plan.pullNumber || null,
          channel: plan.channel,
          targetId: plan.targetId,
          targetName: plan.targetName,
          platformUrl: plan.platformUrl,
          payloadJson,
          payloadHash,
          policyMode: plan.policyMode,
          policyAllowed: plan.policyAllowed,
          policyReason: plan.policyReason,
          state:
            plan.owner === 'shadow'
              ? 'shadow'
              : plan.policyAllowed
                ? 'pending'
                : 'suppressed',
        })
        .onConflictDoNothing(),
    );
    const rows: DeliveryRow[] = await this.rows(
      db,
      and(
        eq(notificationDelivery.eventId, plan.eventId),
        eq(notificationDelivery.channel, plan.channel),
        eq(notificationDelivery.targetId, plan.targetId),
        eq(notificationDelivery.templateVersion, plan.templateVersion),
      ) as SQL,
    );
    if (
      rows.length !== 1 ||
      (!(preserveExisting && (plan.source === 'pr_reviewer' || plan.kind === 'development_overdue')) &&
        rows[0].payload_hash !== payloadHash)
    )
      throw new ConflictException('同一通知事件的内容不一致');
    return rows[0].id;
  }

  async status(
    id: string,
  ): Promise<{ state: string; messageId: string | null }> {
    return this.serviceDatabase.run(
      async (
        db: PostgresJsDatabase,
      ): Promise<{ state: string; messageId: string | null }> => {
        const row: DeliveryRow | undefined = (
          await this.rows(db, eq(notificationDelivery.id, id))
        )[0];
        return {
          state: row?.state || 'missing',
          messageId: row?.message_id || null,
        };
      },
    );
  }

  async enqueueOperationalAlert(input: {
    eventKey: string;
    recipientUserIds: string[];
    summary: string;
    platformUrl: string;
    recovery: boolean;
  }): Promise<{ count: number }> {
    const recipients: string[] = [...new Set(input.recipientUserIds)];
    if (
      recipients.some(
        (id: string): boolean => !/^[A-Za-z0-9_-]{1,128}$/u.test(id),
      )
    )
      throw new BadRequestException('告警接收人必须关联飞书身份');
    if (recipients.length > 20)
      throw new BadRequestException('告警接收人数量超过上限');
    for (const targetId of recipients) {
      await this.record({
        eventId: input.eventKey,
        source: 'operational_alert',
        owner: 'platform_alert',
        kind: input.recovery ? 'recovery' : 'alert',
        templateVersion: 'operational-alert-v1',
        channel: 'feishu_private',
        targetId,
        targetName: '运行管理员',
        platformUrl: input.platformUrl,
        policyMode: 'configured',
        policyAllowed: true,
        policyReason: 'confirmed_alert_settings',
        payload: {
          type: 'post',
          receiveIdType: targetId.startsWith('ou_') ? 'open_id' : 'user_id',
          content: {
            zh_cn: {
              title: input.recovery ? '平台异常已恢复' : '平台运行提醒',
              content: [
                [{ tag: 'text', text: input.summary.slice(0, 1000) }],
                [{ tag: 'a', text: '查看运行中心', href: input.platformUrl }],
              ],
            },
          },
        },
      });
    }
    return { count: recipients.length };
  }

  async claim(
    owner: 'managed_bot' | 'platform_pr' | 'platform_alert',
    ids: string[] = [],
    limit = 10,
    alertRecipients?: ReadonlySet<string>,
  ): Promise<ClaimedDelivery[]> {
    if (owner === 'platform_alert' && !alertRecipients?.size) return [];
    if (
      owner === 'managed_bot' &&
      process.env.WORKFLOW_DELIVERY_OWNER !== 'managed_bot'
    )
      return [];
    return this.serviceDatabase.run(
      async (db: PostgresJsDatabase): Promise<ClaimedDelivery[]> => {
        // Expiry after a persisted send attempt is ambiguous, never safe to replay.
        await db.execute(sql`UPDATE ${notificationDelivery} SET state = 'unknown', last_error_code = 'receipt_missing_after_lease', _updated_at = CURRENT_TIMESTAMP
        WHERE owner = ${owner} AND state = 'sending' AND lease_expires_at <= CURRENT_TIMESTAMP`);
        const filter: SQL = ids.length
          ? sql`AND id IN (${sql.join(
              ids.map((id: string): SQL => sql`${id}::uuid`),
              sql`,`,
            )})`
          : sql``;
        const candidates =
          (await db.execute(sql`SELECT * FROM ${notificationDelivery} AS delivery
        WHERE owner = ${owner} AND state IN ('pending','retry_wait') AND policy_allowed = true
          AND available_at <= CURRENT_TIMESTAMP AND attempts < max_attempts ${filter}
          AND NOT EXISTS (SELECT 1 FROM ${notificationDelivery} AS previous
            WHERE previous.requirement_id = delivery.requirement_id AND previous.channel = delivery.channel
              AND previous.target_id = delivery.target_id AND previous.delivery_sequence < delivery.delivery_sequence
              AND previous.state IN ('pending','sending','retry_wait','unknown'))
        ORDER BY delivery_sequence FOR UPDATE SKIP LOCKED LIMIT ${Math.min(20, Math.max(1, limit))}`)) as unknown as DeliveryRow[];
        const result: ClaimedDelivery[] = [];
        for (const row of candidates) {
          const policy =
            owner === 'platform_alert'
              ? {
                  allowed:
                    row.source === 'operational_alert' &&
                    row.channel === 'feishu_private' &&
                    alertRecipients!.has(row.target_id),
                }
              : deliveryPolicy(row.channel, row.target_id, row.source);
          if (!policy.allowed) {
            await db.execute(
              db
                .update(notificationDelivery)
                .set({
                  state: 'suppressed',
                  lastErrorCode: 'current_policy_denied',
                })
                .where(eq(notificationDelivery.id, row.id)),
            );
            continue;
          }
          const leaseToken: string = randomUUID();
          await db.execute(sql`UPDATE ${notificationDelivery} SET state='sending', attempts=attempts+1,
          lease_token=${leaseToken}::uuid, lease_expires_at=CURRENT_TIMESTAMP + interval '120 seconds',
          first_attempt_at=COALESCE(first_attempt_at,CURRENT_TIMESTAMP), _updated_at=CURRENT_TIMESTAMP WHERE id=${row.id}::uuid`);
          await db.execute(
            db.insert(notificationDeliveryAttempt).values({
              deliveryId: row.id,
              attemptNumber: Number(row.attempts) + 1,
              leaseToken,
            }),
          );
          result.push({
            id: row.id,
            leaseToken,
            eventId: row.event_id,
            channel: row.channel,
            targetId: row.target_id,
            payload: JSON.parse(row.payload_json) as DeliveryPayload,
            idempotencyKey: row.id,
          });
        }
        return result;
      },
    );
  }

  async result(input: DeliveryResult): Promise<{ accepted: boolean }> {
    if (!['sent', 'rejected', 'unknown', 'suppressed'].includes(input.outcome))
      throw new BadRequestException('投递结果无效');
    if (
      input.outcome === 'sent' &&
      !/^om_[A-Za-z0-9_-]{1,120}$/u.test(input.messageId || '')
    )
      throw new BadRequestException('缺少可核验消息回执');
    return this.serviceDatabase.run(
      async (db: PostgresJsDatabase): Promise<{ accepted: boolean }> => {
        const rows: DeliveryRow[] = await this.rows(
          db,
          eq(notificationDelivery.id, input.id),
          true,
        );
        const row: DeliveryRow | undefined = rows[0];
        if (!row || row.lease_token !== input.leaseToken)
          return { accepted: false };
        if (row.state === 'sent')
          return {
            accepted:
              row.message_id === input.messageId && input.outcome === 'sent',
          };
        if (!['sending', 'unknown'].includes(row.state))
          return { accepted: false };
        const code: string | null =
          input.errorCode && /^[a-z0-9_]{1,80}$/u.test(input.errorCode)
            ? input.errorCode
            : input.outcome === 'sent'
              ? null
              : 'provider_result_unverified';
        const retryable: boolean =
          input.outcome === 'rejected' &&
          /^feishu_rejected_(429|5\d\d|99991400|99991401)$/u.test(code || '');
        const state: string =
          input.outcome === 'sent'
            ? 'sent'
            : input.outcome === 'suppressed'
              ? 'suppressed'
              : input.outcome === 'unknown'
                ? 'unknown'
                : retryable && Number(row.attempts) < Number(row.max_attempts)
                  ? 'retry_wait'
                  : 'failed';
        await db.execute(sql`UPDATE ${notificationDelivery} SET state=${state}, message_id=${input.messageId || null},
        provider_request_id=${input.providerRequestId?.slice(0, 128) || null}, last_error_code=${code},
        confirmed_at=CASE WHEN ${input.outcome === 'sent'} THEN CURRENT_TIMESTAMP ELSE confirmed_at END,
        available_at=CURRENT_TIMESTAMP + make_interval(secs => ${Math.min(3600, 30 * 2 ** Math.max(0, Number(row.attempts) - 1))}),
        _updated_at=CURRENT_TIMESTAMP WHERE id=${row.id}::uuid`);
        await db.execute(
          db
            .update(notificationDeliveryAttempt)
            .set({
              outcome: input.outcome,
              finishedAt: new Date(),
              messageId: input.messageId || null,
              providerRequestId: input.providerRequestId?.slice(0, 128) || null,
              errorCode: code,
            })
            .where(
              and(
                eq(notificationDeliveryAttempt.deliveryId, row.id),
                eq(notificationDeliveryAttempt.leaseToken, input.leaseToken),
              ),
            ),
        );
        return { accepted: true };
      },
    );
  }

  async list(
    query: {
      page?: number;
      pageSize?: number;
      operationId?: string;
      requirementId?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const page: number = Math.min(
      10000,
      Math.max(1, Math.floor(query.page || 1)),
    );
    const pageSize: number = Math.min(
      100,
      Math.max(1, Math.floor(query.pageSize || 30)),
    );
    const where: SQL =
      and(
        query.operationId
          ? eq(notificationDelivery.operationId, query.operationId)
          : undefined,
        query.requirementId
          ? eq(notificationDelivery.requirementId, query.requirementId)
          : undefined,
      ) || sql`true`;
    return this.serviceDatabase.run(
      async (db: PostgresJsDatabase): Promise<Record<string, unknown>> => {
        const items = (await db.execute(
          sql`SELECT * FROM ${notificationDelivery} WHERE ${where} ORDER BY _created_at DESC,id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
        )) as unknown as DeliveryRow[];
        const countRows = (await db.execute(
          sql`SELECT count(*) AS total FROM ${notificationDelivery} WHERE ${where}`,
        )) as unknown as Array<{ total: number }>;
        const total: number = Number(countRows[0]?.total || 0);
        return {
          items: items.map(publicDelivery),
          total,
          page,
          pageSize,
          pageCount: Math.ceil(total / pageSize),
          coverageNote:
            '逐接收人记录仅覆盖接入统一台账后的事件；影子记录没有外发，发送成功仅表示飞书接口返回消息 ID，不代表已读。',
        };
      },
    );
  }

  private async rows(
    db: PostgresJsDatabase,
    where: SQL,
    lock = false,
  ): Promise<DeliveryRow[]> {
    return (await db.execute(
      sql`SELECT * FROM ${notificationDelivery} WHERE ${where} ${lock ? sql`FOR UPDATE` : sql``}`,
    )) as unknown as DeliveryRow[];
  }
}
