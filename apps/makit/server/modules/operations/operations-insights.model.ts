import { BadRequestException } from '@nestjs/common';
import type {
  AiPricing,
  AlertRuntimePolicy,
  DependencyOutcome,
  OperationsSettings,
} from '@shared/operations-insights.interface';

export const DEFAULT_OPERATIONS_SETTINGS: OperationsSettings = {
  revision: 0,
  ai: { concurrency: 3, debounceSeconds: 8, dailyBudget: null, pricing: null },
  alerts: {
    enabled: false,
    receiverUserIds: [],
    minimumSamples: 5,
    consecutiveWindows: 3,
    cooldownMinutes: 30,
    backlogMinutes: 5,
    heartbeatMinutes: 3,
    failureRatePercent: 20,
  },
};

export function plainObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function insightDate(value: unknown): string | null {
  if (
    !(value instanceof Date) &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  )
    return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function dependencyFailure(error: unknown): {
  outcome: DependencyOutcome;
  code: string;
  status: number | null;
} {
  const object = plainObject(error);
  const response = plainObject(object.response);
  const remoteCode = Number(
    String(object.errorCode || '').match(/^feishu_rejected_(\d+)$/u)?.[1],
  );
  const status =
    ([401, 403, 408, 429, 504].includes(remoteCode)
      ? remoteCode
      : Number(
          response.status ||
            (typeof object.getStatus === 'function' ? object.getStatus() : 0),
        )) || null;
  const code = String(object.code || '');
  if (status === 401 || status === 403)
    return { outcome: 'permission', code: 'PERMISSION_DENIED', status };
  if (status === 429 || [99991400, 99991401, 1254607].includes(remoteCode))
    return { outcome: 'rate_limited', code: 'RATE_LIMITED', status };
  if (
    ['ECONNABORTED', 'ETIMEDOUT', 'ABORT_ERR'].includes(code) ||
    object.name === 'AbortError' ||
    status === 408 ||
    status === 504
  )
    return { outcome: 'timeout', code: 'DEPENDENCY_TIMEOUT', status };
  if (status && status >= 400 && status < 500)
    return { outcome: 'validation', code: 'DEPENDENCY_REJECTED', status };
  if (status && status >= 500)
    return { outcome: 'server_error', code: 'DEPENDENCY_UNAVAILABLE', status };
  if (
    ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(
      code,
    )
  )
    return { outcome: 'network', code: 'DEPENDENCY_NETWORK', status };
  return { outcome: 'unknown', code: 'DEPENDENCY_ERROR', status };
}

export function safeInsightLabel(
  value: unknown,
  fallback = 'other',
  max = 64,
): string {
  return typeof value === 'string' &&
    new RegExp(`^[a-zA-Z0-9_.:-]{1,${max}}$`, 'u').test(value)
    ? value
    : fallback;
}

function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
function money(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1_000_000
  );
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function validateOperationsSettings(input: unknown): OperationsSettings {
  const value = plainObject(input),
    ai = plainObject(value.ai),
    alerts = plainObject(value.alerts);
  const pricing = ai.pricing === null ? null : plainObject(ai.pricing);
  if (
    !onlyKeys(value, ['revision', 'ai', 'alerts']) ||
    !integer(value.revision, 0, 2_147_483_646) ||
    !onlyKeys(ai, [
      'concurrency',
      'debounceSeconds',
      'dailyBudget',
      'pricing',
    ]) ||
    !integer(ai.concurrency, 1, 8) ||
    !integer(ai.debounceSeconds, 2, 60) ||
    (ai.dailyBudget !== null && !money(ai.dailyBudget))
  )
    throw new BadRequestException('AI 运行配置无效');
  if (
    pricing !== null &&
    (!onlyKeys(pricing, [
      'version',
      'model',
      'currency',
      'inputPerMillion',
      'cachedInputPerMillion',
      'outputPerMillion',
      'effectiveAt',
    ]) ||
      typeof pricing.version !== 'string' ||
      !/^[A-Za-z0-9._-]{1,64}$/u.test(pricing.version) ||
      typeof pricing.model !== 'string' ||
      !/^[A-Za-z0-9._-]{1,100}$/u.test(pricing.model) ||
      !['CNY', 'USD'].includes(String(pricing.currency)) ||
      !money(pricing.inputPerMillion) ||
      (pricing.cachedInputPerMillion !== null &&
        !money(pricing.cachedInputPerMillion)) ||
      !money(pricing.outputPerMillion) ||
      !insightDate(pricing.effectiveAt))
  )
    throw new BadRequestException(
      '请填写有效价格版本、模型、币种、生效时间及每百万 token 价格',
    );
  if (
    !onlyKeys(alerts, [
      'enabled',
      'receiverUserIds',
      'minimumSamples',
      'consecutiveWindows',
      'cooldownMinutes',
      'backlogMinutes',
      'heartbeatMinutes',
      'failureRatePercent',
    ]) ||
    typeof alerts.enabled !== 'boolean' ||
    !Array.isArray(alerts.receiverUserIds) ||
    alerts.receiverUserIds.length > 20 ||
    alerts.receiverUserIds.some(
      (id) => typeof id !== 'string' || !/^\d{1,30}$/u.test(id),
    ) ||
    new Set(alerts.receiverUserIds).size !== alerts.receiverUserIds.length ||
    !integer(alerts.minimumSamples, 1, 1000) ||
    !integer(alerts.consecutiveWindows, 2, 60) ||
    !integer(alerts.cooldownMinutes, 5, 1440) ||
    !integer(alerts.backlogMinutes, 1, 1440) ||
    !integer(alerts.heartbeatMinutes, 1, 60) ||
    !integer(alerts.failureRatePercent, 1, 100)
  )
    throw new BadRequestException('告警配置无效，接收人必须是指定平台成员');
  if (alerts.enabled && !alerts.receiverUserIds.length)
    throw new BadRequestException('启用前请先选择并预览接收人');
  return structuredClone(input as OperationsSettings);
}

export interface ModelUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheHitTokens: number | null;
  cacheMissTokens: number | null;
}
export function modelUsage(raw: unknown): ModelUsage {
  const usage = plainObject(raw);
  const token = (value: unknown): number | null =>
    integer(value, 0, Number.MAX_SAFE_INTEGER) ? value : null;
  return {
    inputTokens: token(usage.prompt_tokens),
    outputTokens: token(usage.completion_tokens),
    cacheHitTokens: token(usage.prompt_cache_hit_tokens),
    cacheMissTokens: token(usage.prompt_cache_miss_tokens),
  };
}
export function estimateModelCost(
  usage: ModelUsage,
  pricing: AiPricing | null,
  model: string,
  startedAt: string,
): number | null {
  if (
    !pricing ||
    pricing.model !== model ||
    Date.parse(pricing.effectiveAt) > Date.parse(startedAt) ||
    usage.inputTokens === null ||
    usage.outputTokens === null
  )
    return null;
  const hit = usage.cacheHitTokens;
  if (
    hit !== null &&
    (hit > usage.inputTokens ||
      (usage.cacheMissTokens !== null &&
        hit + usage.cacheMissTokens !== usage.inputTokens))
  )
    return null;
  // Do not invent cache splits: different hit pricing without reported hit usage is unknown.
  if (pricing.cachedInputPerMillion !== null && hit === null) return null;
  const input =
    hit === null || pricing.cachedInputPerMillion === null
      ? usage.inputTokens * pricing.inputPerMillion
      : (usage.inputTokens - hit) * pricing.inputPerMillion +
        hit * pricing.cachedInputPerMillion;
  return Number(
    (
      (input + usage.outputTokens * pricing.outputPerMillion) /
      1_000_000
    ).toFixed(8),
  );
}

export interface AlertObservation {
  ruleKey: string;
  scope: string;
  title: string;
  actual: number;
  threshold: number;
  unit: string;
  breached: boolean;
}
export function alertWindow(now: number): string {
  return new Date(Math.floor(now / 60_000) * 60_000).toISOString();
}
export function alertFingerprint(observation: AlertObservation): string {
  return `${observation.ruleKey}:${observation.scope}`;
}
export function consecutiveAlertWindows(
  breached: boolean,
  previous:
    | {
        status?: unknown;
        evaluated_window?: unknown;
        consecutive_windows?: unknown;
      }
    | undefined,
  window: string,
): number {
  if (!breached) return 0;
  const last = insightDate(previous?.evaluated_window);
  if (
    !last ||
    Date.parse(window) - Date.parse(last) !== 60000 ||
    previous?.status === 'recovered'
  )
    return 1;
  return Number(previous?.consecutive_windows || 0) + 1;
}
export function alertShouldNotify(
  status: string,
  previous: string,
  lastNotifiedAt: string | null,
  policy: AlertRuntimePolicy,
  now: number,
): boolean {
  if (!policy.enabled || !policy.receiverUserIds.length || status === 'pending')
    return false;
  if (status === 'recovered') return previous === 'open';
  return (
    previous !== 'open' ||
    !lastNotifiedAt ||
    now - Date.parse(lastNotifiedAt) >= policy.cooldownMinutes * 60_000
  );
}
