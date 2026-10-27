import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import { eq, sql } from 'drizzle-orm';
import {
  notificationDelivery,
  notificationRetryPreview,
} from '../../database/schema';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import { deliveryDigest, deliveryPolicy } from './notification-delivery.model';
import {
  publicDelivery,
  type DeliveryRow,
} from './notification-delivery.service';

function retryAllowed(row: DeliveryRow): boolean {
  return (
    row.state === 'failed' &&
    /^feishu_rejected_[0-9]+$/u.test(row.last_error_code || '') &&
    row.policy_allowed &&
    row.owner !== 'shadow' &&
    Number(row.max_attempts) < 20 &&
    deliveryPolicy(row.channel, row.target_id, row.source).allowed &&
    (row.owner !== 'managed_bot' ||
      process.env.WORKFLOW_DELIVERY_OWNER === 'managed_bot')
  );
}

function previewDigest(rows: DeliveryRow[]): string {
  return deliveryDigest(
    rows
      .map((row: DeliveryRow): unknown[] => [
        row.id,
        row.state,
        row.attempts,
        row.max_attempts,
        row.payload_hash,
        row.policy_allowed,
        row.owner,
        retryAllowed(row),
      ])
      .sort((a: unknown[], b: unknown[]): number =>
        String(a[0]).localeCompare(String(b[0])),
      ),
  );
}

@Injectable()
export class NotificationRetryService {
  constructor(private readonly serviceDatabase: ServiceRoleDatabaseExecutor) {}

  async preview(
    actorUserId: string,
    ids: unknown,
  ): Promise<Record<string, unknown>> {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 100 ||
      ids.some(
        (id: unknown): boolean =>
          typeof id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(id),
      )
    ) {
      throw new BadRequestException('请选择 1 到 100 条通知');
    }
    const targets: string[] = [...new Set(ids as string[])];
    return this.serviceDatabase.run(
      async (db: PostgresJsDatabase): Promise<Record<string, unknown>> => {
        const rows = (await db.execute(
          sql`SELECT * FROM ${notificationDelivery} WHERE id IN (${sql.join(
            targets.map((id: string) => sql`${id}::uuid`),
            sql`,`,
          )}) ORDER BY id`,
        )) as unknown as DeliveryRow[];
        const eligible: DeliveryRow[] = rows.filter(retryAllowed);
        const expiresAt: string = new Date(
          Date.now() + 5 * 60000,
        ).toISOString();
        const previews = (await db.execute(
          db
            .insert(notificationRetryPreview)
            .values({
              actorUserId,
              deliveryIdsJson: JSON.stringify(targets),
              projectionDigest: previewDigest(rows),
              expiresAt: new Date(expiresAt),
            })
            .returning({ id: notificationRetryPreview.id }),
        )) as unknown as Array<{ id: string }>;
        return {
          token: previews[0].id,
          expiresAt,
          items: rows.map(
            (row: DeliveryRow): Record<string, unknown> => ({
              ...publicDelivery(row),
              eligible: retryAllowed(row),
              reason: retryAllowed(row)
                ? '已确认发送失败，可再次尝试'
                : '影子、已发送、策略跳过或结果不明的记录不能补发',
            }),
          ),
          eligibleCount: eligible.length,
          rejectedCount: targets.length - eligible.length,
        };
      },
    );
  }

  async confirm(
    actorUserId: string,
    token: string,
  ): Promise<{ acceptedCount: number }> {
    if (!/^[0-9a-f-]{36}$/iu.test(token || ''))
      throw new BadRequestException('补发预览无效');
    return this.serviceDatabase.run(
      async (db: PostgresJsDatabase): Promise<{ acceptedCount: number }> => {
        const previews =
          (await db.execute(sql`SELECT * FROM ${notificationRetryPreview} WHERE id=${token}::uuid AND actor_user_id=${actorUserId}
        AND expires_at>CURRENT_TIMESTAMP AND used_at IS NULL FOR UPDATE`)) as unknown as Array<{
            delivery_ids_json: string;
            projection_digest: string;
          }>;
        if (!previews[0])
          throw new ConflictException('补发预览已失效，请重新核对');
        const ids: string[] = JSON.parse(
          previews[0].delivery_ids_json,
        ) as string[];
        const rows = (await db.execute(
          sql`SELECT * FROM ${notificationDelivery} WHERE id IN (${sql.join(
            ids.map((id: string) => sql`${id}::uuid`),
            sql`,`,
          )}) ORDER BY id FOR UPDATE`,
        )) as unknown as DeliveryRow[];
        if (previewDigest(rows) !== previews[0].projection_digest)
          throw new ConflictException('通知状态或策略已变化，请重新预览');
        const eligible: DeliveryRow[] = rows.filter(retryAllowed);
        for (const row of eligible)
          await db.execute(sql`UPDATE ${notificationDelivery} SET state='pending', max_attempts=max_attempts+1,
        available_at=CURRENT_TIMESTAMP, lease_token=NULL, lease_expires_at=NULL, _updated_at=CURRENT_TIMESTAMP WHERE id=${row.id}::uuid`);
        await db.execute(
          db
            .update(notificationRetryPreview)
            .set({ usedAt: new Date() })
            .where(eq(notificationRetryPreview.id, token)),
        );
        return { acceptedCount: eligible.length };
      },
    );
  }
}
