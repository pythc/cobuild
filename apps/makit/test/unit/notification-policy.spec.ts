import { notificationPolicyDecision } from '../../server/modules/requirements/notification-policy';

describe('notificationPolicyDecision', () => {
  it('defaults to disabled when mode is absent or invalid', () => {
    expect(notificationPolicyDecision('oc_test', {})).toEqual({
      allowed: false,
      mode: 'disabled',
      reason: 'notifications disabled',
    });
    expect(
      notificationPolicyDecision('oc_test', {
        NOTIFICATION_MODE: 'unexpected',
        NOTIFICATION_ALLOWED_CHAT_IDS: 'oc_test',
      }),
    ).toEqual({
      allowed: false,
      mode: 'disabled',
      reason: 'notifications disabled',
    });
  });

  it('only allows configured chats in test_only mode', () => {
    const environment = {
      NOTIFICATION_MODE: 'test_only',
      NOTIFICATION_ALLOWED_CHAT_IDS: 'oc_test, oc_second',
    };
    expect(notificationPolicyDecision('oc_test', environment).allowed).toBe(
      true,
    );
    expect(notificationPolicyDecision('oc_external', environment).allowed).toBe(
      false,
    );
  });

  it('allows all chats only in explicit live mode', () => {
    expect(
      notificationPolicyDecision('oc_external', { NOTIFICATION_MODE: 'live' }),
    ).toEqual({ allowed: true, mode: 'live', reason: 'live mode' });
  });
});
