import {
  MAX_NOTIFICATION_DELIVERY_ATTEMPTS,
  type NotificationDeliveryRow,
  notificationDeliveryStatus,
  notificationDeliverySummary,
} from '../../server/modules/notifications/notifications.model';

function row(
  input: Partial<NotificationDeliveryRow> = {},
): NotificationDeliveryRow {
  return {
    id: 'delivery-1',
    repository: 'pythc/ai-homework-system',
    pullNumber: 34,
    reviewerName: '评审同学',
    reviewerEmployeeId: 'employee-1',
    githubLogin: 'reviewer',
    assignedByName: '操作人',
    assignedByUserId: 'operator-user-id',
    maxNotificationAttempts: 8,
    notificationAttempts: 0,
    notificationError: null,
    suppressionReason: null,
    suppressedAt: null,
    createdAt: new Date('2026-08-12T01:00:00.000Z'),
    updatedAt: new Date('2026-08-12T01:01:00.000Z'),
    notifiedAt: null,
    pullTitle: 'feat: notification center',
    pullExternalUrl: 'https://github.com/pythc/ai-homework-system/pull/34',
    ...input,
  };
}

describe('notification delivery model', () => {
  it('derives pending, retrying, failed, delivered and suppressed from persisted fields', () => {
    expect(notificationDeliveryStatus(row())).toBe('pending');
    expect(notificationDeliveryStatus(row({ notificationAttempts: 2 }))).toBe(
      'retrying',
    );
    expect(
      notificationDeliveryStatus(
        row({ notificationAttempts: MAX_NOTIFICATION_DELIVERY_ATTEMPTS }),
      ),
    ).toBe('failed');
    expect(
      notificationDeliveryStatus(
        row({
          notificationAttempts: 1,
          notifiedAt: new Date('2026-08-12T01:02:00.000Z'),
        }),
      ),
    ).toBe('delivered');
    expect(
      notificationDeliveryStatus(
        row({
          suppressionReason: '评审私聊通知未启用',
          suppressedAt: new Date('2026-08-12T01:02:00.000Z'),
        }),
      ),
    ).toBe('suppressed');
  });

  it('maps only persisted delivery facts and traceable pull request links', () => {
    const summary = notificationDeliverySummary(
      row({
        notificationAttempts: 2,
        notificationError: '飞书接口暂时不可用',
      }),
      'https://example.test/pull-requests/34',
    );

    expect(summary).toMatchObject({
      kind: 'pull_request_reviewer',
      channel: 'feishu_private',
      status: 'retrying',
      attempts: 2,
      maxAttempts: 8,
      recipientName: '评审同学',
      githubLogin: 'reviewer',
      pullNumber: 34,
      pullTitle: 'feat: notification center',
      errorMessage: '飞书接口暂时不可用',
      pullPlatformUrl: 'https://example.test/pull-requests/34',
    });
    expect(summary.lastAttemptAt).toBe('2026-08-12T01:01:00.000Z');
    expect(summary.deliveredAt).toBeNull();
  });

  it('uses deterministic source fallbacks without inventing delivery state', () => {
    const summary = notificationDeliverySummary(
      row({
        pullTitle: null,
        pullExternalUrl: null,
        githubLogin: null,
      }),
      'https://example.test/pull-requests/34',
    );

    expect(summary.pullTitle).toBe('合并请求 #34');
    expect(summary.pullExternalUrl).toBe(
      'https://github.com/pythc/ai-homework-system/pull/34',
    );
    expect(summary.githubLogin).toBe('');
    expect(summary.lastAttemptAt).toBeNull();
  });
});
