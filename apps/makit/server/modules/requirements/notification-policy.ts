interface NotificationEnvironment {
  NOTIFICATION_MODE?: string;
  NOTIFICATION_ALLOWED_CHAT_IDS?: string;
}

export interface NotificationPolicyDecision {
  allowed: boolean;
  mode: 'disabled' | 'test_only' | 'live';
  reason: string;
}

function notificationMode(
  environment: NotificationEnvironment,
): 'disabled' | 'test_only' | 'live' {
  const value: string = environment.NOTIFICATION_MODE?.trim() || '';
  if (value === 'live' || value === 'test_only') return value;
  return 'disabled';
}

function allowedChats(environment: NotificationEnvironment): Set<string> {
  return new Set(
    (environment.NOTIFICATION_ALLOWED_CHAT_IDS || '')
      .split(',')
      .map((item: string): string => item.trim())
      .filter(Boolean),
  );
}

export function notificationPolicyDecision(
  chatId: string,
  environment: NotificationEnvironment = process.env,
): NotificationPolicyDecision {
  const mode: 'disabled' | 'test_only' | 'live' =
    notificationMode(environment);
  if (mode === 'live') {
    return { allowed: true, mode, reason: 'live mode' };
  }
  if (mode === 'disabled') {
    return { allowed: false, mode, reason: 'notifications disabled' };
  }
  if (allowedChats(environment).has(chatId)) {
    return { allowed: true, mode, reason: 'allowed test chat' };
  }
  return {
    allowed: false,
    mode,
    reason: 'target is outside test allowlist',
  };
}
