import {
  DEFAULT_OPERATIONS_SETTINGS,
  alertShouldNotify,
  consecutiveAlertWindows,
  dependencyFailure,
  estimateModelCost,
  modelUsage,
  validateOperationsSettings,
} from '../../server/modules/operations/operations-insights.model';
import { FeishuRequestError } from '../../server/modules/requirements/feishu.service';
import {
  analysisElapsedMs,
  distributionQuantile,
} from '../../shared/iteration-analysis';
import type { AiPricing } from '../../shared/operations-insights.interface';
describe('operational metrics are evidence, not invented success', () => {
  it.each([
    [401, 'permission'],
    [403, 'permission'],
    [429, 'rate_limited'],
    [99991400, 'rate_limited'],
    [99991401, 'rate_limited'],
    [1254607, 'rate_limited'],
  ])('classifies Feishu envelope %s rather than Nest 503', (code, outcome) =>
    expect(
      dependencyFailure(
        new FeishuRequestError('redacted', true, `feishu_rejected_${code}`),
      ).outcome,
    ).toBe(outcome),
  );
  it('distinguishes network/timeout and safe unknown', () => {
    expect(dependencyFailure({ code: 'ECONNRESET' }).outcome).toBe('network');
    expect(dependencyFailure({ name: 'AbortError' }).outcome).toBe('timeout');
    expect(dependencyFailure({}).outcome).toBe('unknown');
  });
  const pricing: AiPricing = {
    version: 'p1',
    model: 'model',
    currency: 'CNY',
    inputPerMillion: 2,
    cachedInputPerMillion: 1,
    outputPerMillion: 4,
    effectiveAt: '2026-01-01T00:00:00Z',
  };
  it('does not invent tokens or costs for missing usage/pricing/cache splits', () => {
    expect(modelUsage({}).inputTokens).toBeNull();
    expect(
      estimateModelCost(modelUsage({}), pricing, 'model', '2026-02-01'),
    ).toBeNull();
    expect(
      estimateModelCost(
        modelUsage({ prompt_tokens: 100, completion_tokens: 20 }),
        pricing,
        'model',
        '2026-02-01',
      ),
    ).toBeNull();
    expect(
      estimateModelCost(
        modelUsage({
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_cache_hit_tokens: 120,
        }),
        pricing,
        'model',
        '2026-02-01',
      ),
    ).toBeNull();
  });
  it('uses execution model and effective pricing version with cache split', () => {
    const usage = modelUsage({
      prompt_tokens: 1000000,
      completion_tokens: 500000,
      prompt_cache_hit_tokens: 200000,
      prompt_cache_miss_tokens: 800000,
    });
    expect(estimateModelCost(usage, pricing, 'model', '2026-02-01')).toBe(3.8);
    expect(
      estimateModelCost(usage, pricing, 'different', '2026-02-01'),
    ).toBeNull();
    expect(estimateModelCost(usage, pricing, 'model', '2025-02-01')).toBeNull();
  });
  it('requires valid routing before enabling alerts and enforces bounds', () => {
    expect(() =>
      validateOperationsSettings(DEFAULT_OPERATIONS_SETTINGS),
    ).not.toThrow();
    const next = structuredClone(DEFAULT_OPERATIONS_SETTINGS);
    next.alerts.enabled = true;
    expect(() => validateOperationsSettings(next)).toThrow();
    next.alerts.receiverUserIds = ['123'];
    next.ai.concurrency = 99;
    expect(() => validateOperationsSettings(next)).toThrow();
  });
  it('cooldown and recovery do not notify pending or disabled policies', () => {
    const policy = {
      ...DEFAULT_OPERATIONS_SETTINGS.alerts,
      enabled: true,
      receiverUserIds: ['123'],
    };
    const now = Date.now();
    expect(alertShouldNotify('pending', 'pending', null, policy, now)).toBe(
      false,
    );
    expect(
      alertShouldNotify(
        'open',
        'open',
        new Date(now - 1000).toISOString(),
        policy,
        now,
      ),
    ).toBe(false);
    expect(alertShouldNotify('recovered', 'open', null, policy, now)).toBe(
      true,
    );
    expect(alertShouldNotify('recovered', 'recovered', null, policy, now)).toBe(
      false,
    );
  });
  it('missed evaluation windows reset consecutive breach count', () => {
    const previous = {
      status: 'pending',
      evaluated_window: '2026-09-12T00:00:00Z',
      consecutive_windows: 2,
    };
    expect(
      consecutiveAlertWindows(true, previous, '2026-09-12T00:01:00Z'),
    ).toBe(3);
    expect(
      consecutiveAlertWindows(true, previous, '2026-09-12T00:03:00Z'),
    ).toBe(1);
    expect(
      consecutiveAlertWindows(false, previous, '2026-09-12T00:01:00Z'),
    ).toBe(0);
  });
  it('uses original observations for quantiles and excludes weekend only when configured', () => {
    expect(distributionQuantile([1, 2, 3, 4, 100], 0.5)).toBe(3);
    const fri = Date.parse('2026-09-11T00:00:00+08:00'),
      mon = Date.parse('2026-09-14T00:00:00+08:00');
    expect(analysisElapsedMs(fri, mon, 'calendar')).toBe(72 * 3600000);
    expect(analysisElapsedMs(fri, mon, 'weekdays')).toBe(24 * 3600000);
  });
});
