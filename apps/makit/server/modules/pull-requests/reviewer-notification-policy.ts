interface ReviewerNotificationEnvironment {
  PR_REVIEWER_NOTIFICATION_MODE?: string;
  PR_REVIEWER_NOTIFICATION_ALLOWED_USER_IDS?: string;
}

export type ReviewerNotificationMode = 'disabled' | 'test_only' | 'live';

export interface ReviewerNotificationPolicyDecision {
  allowed: boolean;
  mode: ReviewerNotificationMode;
  reason: string;
}

export interface ReviewerNotificationPolicyConfig {
  mode: ReviewerNotificationMode;
  allowedUserIds: Set<string>;
}

export function reviewerNotificationPolicyConfig(
  environment: ReviewerNotificationEnvironment = process.env,
): ReviewerNotificationPolicyConfig {
  const configuredMode: string =
    environment.PR_REVIEWER_NOTIFICATION_MODE?.trim() || '';
  const mode: ReviewerNotificationMode =
    configuredMode === 'live' || configuredMode === 'test_only'
      ? configuredMode
      : 'disabled';
  const allowedUserIds: Set<string> = new Set(
    (environment.PR_REVIEWER_NOTIFICATION_ALLOWED_USER_IDS || '')
      .split(',')
      .map((value: string): string => value.trim())
      .filter(Boolean),
  );
  return { mode, allowedUserIds };
}

export function reviewerNotificationPolicyDecision(
  reviewerEmployeeId: string,
  environment: ReviewerNotificationEnvironment = process.env,
): ReviewerNotificationPolicyDecision {
  const config: ReviewerNotificationPolicyConfig =
    reviewerNotificationPolicyConfig(environment);
  if (config.mode === 'live') {
    return { allowed: true, mode: config.mode, reason: 'live mode' };
  }
  if (config.mode === 'disabled') {
    return {
      allowed: false,
      mode: config.mode,
      reason: 'reviewer notifications disabled',
    };
  }
  if (config.allowedUserIds.has(reviewerEmployeeId)) {
    return {
      allowed: true,
      mode: config.mode,
      reason: 'allowed test user',
    };
  }
  return {
    allowed: false,
    mode: config.mode,
    reason: 'target is outside reviewer test allowlist',
  };
}
