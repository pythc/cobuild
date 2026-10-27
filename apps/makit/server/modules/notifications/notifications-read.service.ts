import { Injectable } from '@nestjs/common';
import type { PostgresJsDatabase } from '@lark-apaas/fullstack-nestjs-core';
import {
  and,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  lt,
  sql,
  type SQL,
} from 'drizzle-orm';
import type {
  NotificationDeliveryListResponse,
  NotificationDeliveryStats,
  NotificationDeliveryStatus,
} from '@shared/api.interface';
import { ServiceRoleDatabaseExecutor } from '../../database/service-role-database.executor';
import {
  pullRequestReviewerNotificationEvent as event,
  pullRequestReviewerState as state,
  pullRequestSnapshot as snapshot,
} from '../../database/schema';
import {
  notificationDeliverySummary,
  type NotificationDeliveryRow,
} from './notifications.model';
import { pullRequestPlatformUrl } from '../requirements/requirement-links';
import { safeNotificationError } from './notification-error.model';

export function notificationStatusPredicate(
  status: NotificationDeliveryStatus,
): SQL {
  if (status === 'delivered') return isNotNull(event.notifiedAt);
  if (status === 'suppressed')
    return and(isNull(event.notifiedAt), isNotNull(event.suppressedAt))!;
  const undelivered: SQL[] = [
    isNull(event.notifiedAt),
    isNull(event.suppressedAt),
  ];
  if (status === 'failed')
    return and(
      ...undelivered,
      gte(event.notificationAttempts, event.maxNotificationAttempts),
    )!;
  if (status === 'retrying')
    return and(
      ...undelivered,
      gt(event.notificationAttempts, 0),
      lt(event.notificationAttempts, event.maxNotificationAttempts),
    )!;
  return and(...undelivered, eq(event.notificationAttempts, 0))!;
}

interface StatsRow extends Record<string, unknown> {
  total: number;
  pending: number;
  retrying: number;
  failed: number;
  delivered: number;
  suppressed: number;
}
interface CountRow extends Record<string, unknown> {
  total: number;
}
interface AuditRow extends Record<string, unknown> {
  id: string;
  repository: string;
  pullNumber: number;
  reviewerName: string;
  reviewerEmployeeId: string;
  githubLogin: string;
  assignedByName: string;
  assignedByUserId: string;
  maxNotificationAttempts: number;
  notificationAttempts: number;
  notificationError: string | null;
  suppressionReason: string | null;
  suppressedAt: string | null;
  createdAt: string;
  updatedAt: string;
  notifiedAt: string | null;
  pullTitle: string | null;
  pullExternalUrl: string | null;
}

/** Read-only projection. Controllers must verify live platform roles first. */
@Injectable()
export class NotificationsReadService {
  constructor(private readonly database: ServiceRoleDatabaseExecutor) {}

  async list(
    status: NotificationDeliveryStatus | undefined,
    page: number,
    pageSize: number,
  ): Promise<NotificationDeliveryListResponse> {
    return this.database.run(
      async (
        db: PostgresJsDatabase,
      ): Promise<NotificationDeliveryListResponse> => {
        const statsRows = await db.execute<StatsRow>(
          db
            .select({
              total: sql<number>`count(*)`.as('total'),
              pending:
                sql<number>`count(*) filter (where ${notificationStatusPredicate('pending')})`.as(
                  'pending',
                ),
              retrying:
                sql<number>`count(*) filter (where ${notificationStatusPredicate('retrying')})`.as(
                  'retrying',
                ),
              failed:
                sql<number>`count(*) filter (where ${notificationStatusPredicate('failed')})`.as(
                  'failed',
                ),
              delivered:
                sql<number>`count(*) filter (where ${notificationStatusPredicate('delivered')})`.as(
                  'delivered',
                ),
              suppressed:
                sql<number>`count(*) filter (where ${notificationStatusPredicate('suppressed')})`.as(
                  'suppressed',
                ),
            })
            .from(event),
        );
        const reconciling = await db.execute<CountRow>(
          db
            .select({ total: sql<number>`count(*)`.as('total') })
            .from(state)
            .where(
              and(
                gt(state.assignmentGeneration, state.notifiedGeneration),
                isNotNull(state.pendingPolicyMode),
              ),
            ),
        );
        const stats: NotificationDeliveryStats = {
          total: Number(statsRows[0]?.total || 0),
          pending: Number(statsRows[0]?.pending || 0),
          retrying: Number(statsRows[0]?.retrying || 0),
          failed: Number(statsRows[0]?.failed || 0),
          delivered: Number(statsRows[0]?.delivered || 0),
          suppressed: Number(statsRows[0]?.suppressed || 0),
          reconciling: Number(reconciling[0]?.total || 0),
        };
        // Explicit aliases are required: the service-role executor returns raw
        // SQL rows and deliberately bypasses Drizzle's result mappers.
        const rows = await db.execute<AuditRow>(
          db
            .select({
              id: event.id,
              repository: event.repository,
              pullNumber: sql<number>`${event.pullNumber}`.as('pullNumber'),
              reviewerName: sql<string>`${event.reviewerName}`.as(
                'reviewerName',
              ),
              reviewerEmployeeId: sql<string>`${event.reviewerEmployeeId}`.as(
                'reviewerEmployeeId',
              ),
              githubLogin: sql<string>`${event.githubLogin}`.as('githubLogin'),
              assignedByName: sql<string>`${event.assignedByName}`.as(
                'assignedByName',
              ),
              assignedByUserId: sql<string>`${event.assignedByUserId}`.as(
                'assignedByUserId',
              ),
              maxNotificationAttempts:
                sql<number>`${event.maxNotificationAttempts}`.as(
                  'maxNotificationAttempts',
                ),
              notificationAttempts:
                sql<number>`${event.notificationAttempts}`.as(
                  'notificationAttempts',
                ),
              notificationError: sql<
                string | null
              >`${event.notificationError}`.as('notificationError'),
              suppressionReason: sql<
                string | null
              >`${event.suppressionReason}`.as('suppressionReason'),
              suppressedAt: sql<string | null>`${event.suppressedAt}`.as(
                'suppressedAt',
              ),
              createdAt: sql<string>`${event.createdAt}`.as('createdAt'),
              updatedAt: sql<string>`${event.updatedAt}`.as('updatedAt'),
              notifiedAt: sql<string | null>`${event.notifiedAt}`.as(
                'notifiedAt',
              ),
              pullTitle: sql<string | null>`${snapshot.title}`.as('pullTitle'),
              pullExternalUrl: sql<string | null>`${snapshot.url}`.as(
                'pullExternalUrl',
              ),
            })
            .from(event)
            .leftJoin(
              snapshot,
              and(
                eq(snapshot.repository, event.repository),
                eq(snapshot.pullNumber, event.pullNumber),
              ),
            )
            .where(status ? notificationStatusPredicate(status) : undefined)
            .orderBy(desc(event.createdAt), desc(event.id))
            .offset((page - 1) * pageSize)
            .limit(pageSize),
        );
        const total: number = status ? stats[status] : stats.total;
        return {
          fetchedAt: new Date().toISOString(),
          items: rows.map((row: AuditRow) => {
            const normalized: NotificationDeliveryRow = {
              ...row,
              notificationError: safeNotificationError(
                row.notificationError || '',
              ),
              suppressionReason: row.suppressionReason
                ? '通知被策略抑制，未向外发送。'
                : null,
              createdAt: new Date(row.createdAt),
              updatedAt: new Date(row.updatedAt),
              notifiedAt: row.notifiedAt ? new Date(row.notifiedAt) : null,
              suppressedAt: row.suppressedAt
                ? new Date(row.suppressedAt)
                : null,
            };
            return notificationDeliverySummary(
              normalized,
              pullRequestPlatformUrl(row.pullNumber),
            );
          }),
          stats,
          page,
          pageSize,
          total,
          pageCount: Math.max(1, Math.ceil(total / pageSize)),
          coverage: {
            includedKinds: ['pull_request_reviewer'],
            note: '合并请求评审人飞书私聊投递记录；需求工作流通知在运行中心单独展示。',
          },
        };
      },
    );
  }
}
