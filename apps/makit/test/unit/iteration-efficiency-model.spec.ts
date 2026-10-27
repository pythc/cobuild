import { defaultIterationConfiguration } from '../../shared/iteration-workflow';
import type { RequirementSummary } from '../../shared/api.interface';
import {
  requirementEfficiency,
  type EfficiencyEvent,
} from '../../server/modules/operations/iteration-efficiency.model';
const config = defaultIterationConfiguration([]);
const summary = (status = '测试中') =>
  ({
    id: 'recQaOnly',
    code: 'REQ-TEST',
    title: '测试',
    type: '产品需求',
    status,
    handlers: [],
    selfTestReport: '',
    deadlineAt: null,
    blocked: false,
  }) as RequirementSummary;
const event = (
  at: string,
  before: string,
  after: string,
  version: string | null = '1',
): EfficiencyEvent => ({
  id: at,
  requirementId: 'recQaOnly',
  operationId: 'op',
  at,
  workflowVersion: version,
  before: { status: before },
  after: { status: after },
});
describe('iteration stage duration evidence', () => {
  it('never interprets another iterations version using this iterations rules', () => {
    const events = [
      event('2026-09-10T00:00:00Z', '需求已评审', '开发中'),
      event('2026-09-11T00:00:00Z', '开发中', '测试中'),
    ];
    for (const item of events)
      item.before.workflow = { iterationId: 'recOther', version: 1 };
    const result = requirementEfficiency(
      summary(),
      events,
      config,
      new Map([[1, config]]),
      new Set(),
      Date.now(),
      'recCurrent',
    );
    expect(result.samples).toEqual([]);
    expect(result.requirement.dwellHours).toBeNull();
  });
  it('counts a confirmed completed phase and current dwell, not optimistic UI values', () => {
    const events = [
      event('2026-09-10T00:00:00Z', '需求已评审', '开发中'),
      event('2026-09-11T00:00:00Z', '开发中', '测试中'),
    ];
    const result = requirementEfficiency(
      summary(),
      events,
      config,
      new Map([[1, config]]),
      new Set(),
      Date.parse('2026-09-12T00:00:00Z'),
    );
    expect(result.samples).toEqual([
      expect.objectContaining({ stage: 'development', hours: 24 }),
    ]);
    expect(result.requirement.dwellHours).toBe(24);
    expect(result.requirement.historyComplete).toBe(false);
  });
  it('missing rule version and history gaps do not fabricate completed phases', () => {
    const events = [
      event('2026-09-10T00:00:00Z', '需求已评审', '开发中', '99'),
      event('2026-09-11T00:00:00Z', '开发中', '测试中', '99'),
    ];
    expect(
      requirementEfficiency(
        summary(),
        events,
        config,
        new Map([[1, config]]),
        new Set(),
        Date.now(),
      ).samples,
    ).toEqual([]);
    const gap = [
      event('2026-09-10T00:00:00Z', '需求已评审', '开发中'),
      event('2026-09-11T00:00:00Z', '产品体验中', '测试中'),
    ];
    expect(
      requirementEfficiency(
        summary(),
        gap,
        config,
        new Map([[1, config]]),
        new Set(),
        Date.now(),
      ).samples,
    ).toEqual([]);
  });
  it('current value without a corresponding latest transition has unknown dwell', () => {
    const result = requirementEfficiency(
      summary('开发中'),
      [event('2026-09-11T00:00:00Z', '开发中', '测试中')],
      config,
      new Map([[1, config]]),
      new Set(),
      Date.now(),
    );
    expect(result.requirement.enteredAt).toBeNull();
    expect(result.requirement.dwellHours).toBeNull();
  });
});
