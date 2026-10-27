import { Inject, Injectable } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@lark-apaas/fullstack-nestjs-core';
import { sql } from 'drizzle-orm';
import type {
  NotificationDeliveryListResponse,
  NotificationDeliveryStats,
  NotificationDeliveryStatus,
} from '@shared/api.interface';
import { pullRequestPlatformUrl } from '../requirements/requirement-links';
import {
  type NotificationDeliveryRow,
  notificationDeliverySummary,
} from './notifications.model';

interface NotificationStatsRow extends Record<string, unknown> {
  total: number;
  pending: number;
  retrying: number;
  failed: number;
  delivered: number;
  suppressed: number;
  reconciling: number;
}

interface NotificationAuditRow extends Record<string, unknown> {
  assignment_id: string;
  repository: string;
  pull_number: number;
  reviewer_name: string;
  reviewer_employee_id: string;
  github_login: string | null;
  assigned_by_name: string;
  assigned_by_user_id: string;
  max_notification_attempts: number;
  notification_attempts: number;
  notification_error: string | null;
  suppression_reason: string | null;
  suppressed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  notified_at: Date | string | null;
  pull_title: string | null;
  pull_external_url: string | null;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asOptionalDate(value: Date | string | null): Date | null {
  return value ? asDate(value) : null;
}

@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
  ) {}

  private async stats(actorUserId: string): Promise<NotificationDeliveryStats> {
    const rows = await this.db.execute<NotificationStatsRow>(sql`
      SELECT total, pending, retrying, failed, delivered, suppressed,
        reconciling
      FROM pull_request_reviewer_notification_audit_stats(
        ${actorUserId}::text
      )
    `);
    const row: NotificationStatsRow | undefined = rows[0];
    return {
      total: Number(row?.total || 0),
      pending: Number(row?.pending || 0),
      retrying: Number(row?.retrying || 0),
      failed: Number(row?.failed || 0),
      delivered: Number(row?.delivered || 0),
      suppressed: Number(row?.suppressed || 0),
      reconciling: Number(row?.reconciling || 0),
    };
  }

  async list(
    actorUserId: string,
    status: NotificationDeliveryStatus | undefined,
    page: number,
    pageSize: number,
  ): Promise<NotificationDeliveryListResponse> {
    const stats: NotificationDeliveryStats = await this.stats(actorUserId);
    const total: number = status ? stats[status] : stats.total;
    const rows = await this.db.execute<NotificationAuditRow>(sql`
      SELECT *
      FROM pull_request_reviewer_notification_audit_list(
        ${status || null}::text,
        ${(page - 1) * pageSize}::integer,
        ${pageSize}::integer,
        ${actorUserId}::text
      )
    `);
    const normalized: NotificationDeliveryRow[] = rows.map(
      (row: NotificationAuditRow): NotificationDeliveryRow => ({
        id: row.assignment_id,
        repository: row.repository,
        pullNumber: Number(row.pull_number),
        reviewerName: row.reviewer_name,
        reviewerEmployeeId: row.reviewer_employee_id,
        githubLogin: row.github_login,
        assignedByName: row.assigned_by_name,
        assignedByUserId: row.assigned_by_user_id,
        maxNotificationAttempts: Number(row.max_notification_attempts || 8),
        notificationAttempts: Number(row.notification_attempts),
        notificationError: row.notification_error,
        suppressionReason: row.suppression_reason,
        suppressedAt: asOptionalDate(row.suppressed_at),
        createdAt: asDate(row.created_at),
        updatedAt: asDate(row.updated_at),
        notifiedAt: asOptionalDate(row.notified_at),
        pullTitle: row.pull_title,
        pullExternalUrl: row.pull_external_url,
      }),
    );

    return {
      fetchedAt: new Date().toISOString(),
      items: normalized.map((row: NotificationDeliveryRow) =>
        notificationDeliverySummary(
          row,
          pullRequestPlatformUrl(row.pullNumber),
        ),
      ),
      stats,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      total,
      coverage: {
        includedKinds: ['pull_request_reviewer'],
        note: '当前仅展示已持久化的合并请求评审人飞书私聊投递记录；需求字段和状态协作通知尚无统一投递日志，因此未纳入。',
      },
    };
  }
}
