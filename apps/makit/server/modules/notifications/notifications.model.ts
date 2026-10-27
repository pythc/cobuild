import type {
  NotificationDeliveryStatus,
  NotificationDeliverySummary,
} from '@shared/api.interface';

export const MAX_NOTIFICATION_DELIVERY_ATTEMPTS: number = 8;

export interface NotificationDeliveryRow {
  id: string;
  repository: string;
  pullNumber: number;
  reviewerName: string;
  reviewerEmployeeId: string;
  githubLogin: string | null;
  assignedByName: string;
  assignedByUserId: string;
  maxNotificationAttempts: number;
  notificationAttempts: number;
  notificationError: string | null;
  suppressionReason: string | null;
  suppressedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  notifiedAt: Date | null;
  pullTitle: string | null;
  pullExternalUrl: string | null;
}

export function notificationDeliveryStatus(
  row: Pick<
    NotificationDeliveryRow,
    | 'notificationAttempts'
    | 'maxNotificationAttempts'
    | 'notifiedAt'
    | 'suppressedAt'
  >,
): NotificationDeliveryStatus {
  if (row.notifiedAt) return 'delivered';
  if (row.suppressedAt) return 'suppressed';
  const maxAttempts: number = Number(
    row.maxNotificationAttempts || MAX_NOTIFICATION_DELIVERY_ATTEMPTS,
  );
  if (row.notificationAttempts >= maxAttempts) {
    return 'failed';
  }
  if (row.notificationAttempts > 0) return 'retrying';
  return 'pending';
}

export function notificationDeliverySummary(
  row: NotificationDeliveryRow,
  pullPlatformUrl: string,
): NotificationDeliverySummary {
  return {
    id: row.id,
    kind: 'pull_request_reviewer',
    channel: 'feishu_private',
    status: notificationDeliveryStatus(row),
    attempts: row.notificationAttempts,
    maxAttempts: row.maxNotificationAttempts,
    errorMessage: row.notificationError || '',
    suppressionReason: row.suppressionReason || '',
    recipientName: row.reviewerName,
    recipientEmployeeId: row.reviewerEmployeeId,
    githubLogin: row.githubLogin || '',
    assignedByName: row.assignedByName,
    assignedByUserId: row.assignedByUserId,
    repository: row.repository,
    pullNumber: row.pullNumber,
    pullTitle: row.pullTitle || `合并请求 #${row.pullNumber}`,
    pullPlatformUrl,
    pullExternalUrl:
      row.pullExternalUrl ||
      `https://github.com/${row.repository}/pull/${row.pullNumber}`,
    queuedAt: row.createdAt.toISOString(),
    lastAttemptAt:
      row.notificationAttempts > 0 ? row.updatedAt.toISOString() : null,
    deliveredAt: row.notifiedAt?.toISOString() || null,
  };
}
