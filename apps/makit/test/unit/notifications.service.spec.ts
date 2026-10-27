import { NotificationsService } from '../../server/modules/notifications/notifications.service';

describe('NotificationsService', () => {
  it('reads audit data through identity-bound functions and keeps suppressed terminal', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce([
        {
          total: 2,
          pending: 0,
          retrying: 0,
          failed: 0,
          delivered: 1,
          suppressed: 1,
          reconciling: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          assignment_id: '469bcf56-459b-41eb-8073-5c8d63e98378',
          repository: 'pythc/ai-homework-system',
          pull_number: 34,
          reviewer_name: '评审同学',
          reviewer_employee_id: 'employee-1',
          github_login: 'reviewer-login',
          assigned_by_name: '周灿宇',
          assigned_by_user_id: 'miaoda-admin',
          max_notification_attempts: 8,
          notification_attempts: 0,
          notification_error: null,
          suppression_reason: '评审私聊通知未启用',
          suppressed_at: '2026-08-12T02:00:00.000Z',
          created_at: '2026-08-12T01:59:00.000Z',
          updated_at: '2026-08-12T02:00:00.000Z',
          notified_at: null,
          pull_title: 'feat: safe reviewer notification',
          pull_external_url:
            'https://github.com/pythc/ai-homework-system/pull/34',
        },
      ]);
    const service = new NotificationsService({ execute } as never);

    const result = await service.list('miaoda-admin', 'suppressed', 1, 25);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(result.stats).toEqual({
      total: 2,
      pending: 0,
      retrying: 0,
      failed: 0,
      delivered: 1,
      suppressed: 1,
      reconciling: 0,
    });
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      status: 'suppressed',
      suppressionReason: '评审私聊通知未启用',
      assignedByUserId: 'miaoda-admin',
      attempts: 0,
    });
  });
});
