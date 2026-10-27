import {
  reviewerNotificationPolicyConfig,
  reviewerNotificationPolicyDecision,
} from '../../server/modules/pull-requests/reviewer-notification-policy';

describe('reviewerNotificationPolicyDecision', () => {
  it('defaults to disabled independently of the group notification mode', () => {
    expect(
      reviewerNotificationPolicyDecision('employee-1', {
        NOTIFICATION_MODE: 'live',
      } as never),
    ).toEqual({
      allowed: false,
      mode: 'disabled',
      reason: 'reviewer notifications disabled',
    });
  });

  it('only allows listed Feishu user ids in test_only mode', () => {
    const environment = {
      PR_REVIEWER_NOTIFICATION_MODE: 'test_only',
      PR_REVIEWER_NOTIFICATION_ALLOWED_USER_IDS:
        'employee-1, employee-2, employee-1',
    };
    expect(
      reviewerNotificationPolicyDecision('employee-1', environment).allowed,
    ).toBe(true);
    expect(
      reviewerNotificationPolicyDecision('employee-3', environment).allowed,
    ).toBe(false);
    expect(
      reviewerNotificationPolicyConfig(environment).allowedUserIds,
    ).toEqual(new Set(['employee-1', 'employee-2']));
  });

  it('allows every target only when the dedicated mode is live', () => {
    expect(
      reviewerNotificationPolicyDecision('employee-3', {
        PR_REVIEWER_NOTIFICATION_MODE: 'live',
      }),
    ).toEqual({
      allowed: true,
      mode: 'live',
      reason: 'live mode',
    });
  });

  it('treats unknown dedicated modes as disabled', () => {
    expect(
      reviewerNotificationPolicyDecision('employee-1', {
        PR_REVIEWER_NOTIFICATION_MODE: 'unexpected',
        PR_REVIEWER_NOTIFICATION_ALLOWED_USER_IDS: 'employee-1',
      }).allowed,
    ).toBe(false);
  });
});
