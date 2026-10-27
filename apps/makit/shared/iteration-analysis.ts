import type {
  IterationAnalysisConfiguration,
  IterationStatusAnalysis,
} from './operations-insights.interface';
import type { IterationConfiguration } from './iteration-workflow';

export const ANALYSIS_STAGE_LABELS = {
  intake: '需求',
  development: '开发',
  testing: '测试',
  experience: '产品体验',
  release: '待发布',
  done: '完成',
} as const;
const status = (
  id: string,
  name: string,
  stage: IterationStatusAnalysis['stage'],
  start = false,
  terminal = false,
): IterationStatusAnalysis => ({ id, status: name, stage, start, terminal });
export const DEFAULT_STATUS_ANALYSIS: IterationAnalysisConfiguration['statuses'] =
  {
    requirement: [
      status('req.new', '新', 'intake', true),
      status('req.reviewed', '需求已评审', 'intake'),
      status('req.developing', '开发中', 'development'),
      status('req.handoff', '开发转测试', 'testing'),
      status('req.testing', '测试中', 'testing'),
      status('req.experience', '产品体验中', 'experience'),
      status('req.release', '待发布', 'release'),
      status('req.done', '已发布', 'done', false, true),
    ],
    defect: [
      status('bug.new', '新建', 'intake', true),
      status('bug.fixing', '处理中', 'development'),
      status('bug.fixed', '已解决', 'testing'),
      status('bug.verified', '已验证', 'testing'),
      status('bug.closed', '已关闭', 'done', false, true),
      status('bug.reopened', '重新打开', 'development'),
      status('bug.rejected', '已拒绝', 'done', false, true),
    ],
  };
export function defaultIterationAnalysis(
  config: Pick<IterationConfiguration, 'workflows' | 'milestones'>,
): IterationAnalysisConfiguration {
  const gates: Record<
    string,
    { requirementStatusId: string; defectStatusId: string | null }
  > = {};
  const known: Record<string, string> = {
    start: 'req.new',
    review: 'req.reviewed',
    development: 'req.developing',
    testing: 'req.handoff',
    release: 'req.done',
  };
  for (const milestone of config.milestones) {
    const entry = DEFAULT_STATUS_ANALYSIS.requirement.find(
      (item) => item.id === known[milestone.id],
    );
    if (entry && config.workflows.requirement.statuses.includes(entry.status))
      gates[milestone.id] = {
        requirementStatusId: entry.id,
        defectStatusId: milestone.id === 'release' ? 'bug.closed' : null,
      };
  }
  return {
    clock: 'calendar',
    timezone: 'Asia/Shanghai',
    excludeBlockedTime: false,
    statuses: structuredClone(DEFAULT_STATUS_ANALYSIS),
    milestoneGates: gates,
  };
}

export function iterationAnalysisErrors(
  raw: unknown,
  config: Pick<IterationConfiguration, 'workflows' | 'milestones'>,
): string[] {
  if (raw === undefined) return [];
  const errors: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return ['统计口径格式无效'];
  const value = raw as IterationAnalysisConfiguration;
  if (
    !['calendar', 'weekdays'].includes(value.clock) ||
    value.timezone !== 'Asia/Shanghai' ||
    typeof value.excludeBlockedTime !== 'boolean' ||
    !value.statuses ||
    !value.milestoneGates ||
    typeof value.milestoneGates !== 'object' ||
    Array.isArray(value.milestoneGates)
  )
    return ['统计时间和阶段配置无效'];
  for (const kind of ['requirement', 'defect'] as const) {
    const items = value.statuses[kind];
    if (!Array.isArray(items) || items.length > 30) {
      errors.push('统计阶段映射无效');
      continue;
    }
    const ids = new Set<string>(),
      names = new Set<string>();
    for (const item of items) {
      const original = DEFAULT_STATUS_ANALYSIS[kind].find(
        (entry) => entry.status === item?.status,
      );
      // IDs are deliberately not editable; a rename cannot silently rewrite history.
      if (
        !item ||
        !original ||
        item.id !== original.id ||
        ids.has(item.id) ||
        names.has(item.status) ||
        !Object.prototype.hasOwnProperty.call(ANALYSIS_STAGE_LABELS, item.stage) ||
        typeof item.start !== 'boolean' ||
        typeof item.terminal !== 'boolean' ||
        (item.start && item.terminal)
      )
        errors.push('状态统计标识、阶段或起终态无效');
      ids.add(item?.id);
      names.add(item?.status);
    }
    if (config.workflows[kind].statuses.some((name) => !names.has(name)))
      errors.push('每个可用状态都需要统计阶段映射');
    if (
      !items.some(
        (item) =>
          item.start && config.workflows[kind].statuses.includes(item.status),
      ) ||
      !items.some(
        (item) =>
          item.terminal &&
          config.workflows[kind].statuses.includes(item.status),
      )
    )
      errors.push('统计口径必须保留开始状态和终态');
  }
  for (const [id, gate] of Object.entries(value.milestoneGates)) {
    if (
      !config.milestones.some((m) => m.id === id) ||
      !gate ||
      typeof gate !== 'object' ||
      !value.statuses.requirement?.some(
        (item) =>
          item.id === gate.requirementStatusId &&
          config.workflows.requirement.statuses.includes(item.status),
      ) ||
      (gate.defectStatusId !== null &&
        !value.statuses.defect?.some(
          (item) =>
            item.id === gate.defectStatusId &&
            config.workflows.defect.statuses.includes(item.status),
        ))
    )
      errors.push('里程碑统计目标无效');
  }
  return [...new Set(errors)];
}

/** Weekdays means Monday–Friday in Shanghai; statutory holidays are intentionally not inferred. */
export function analysisElapsedMs(
  start: number,
  end: number,
  clock: 'calendar' | 'weekdays',
): number {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return 0;
  if (clock === 'calendar') return end - start;
  const offset = 8 * 3_600_000,
    day = 86_400_000;
  let cursor = start,
    total = 0;
  while (cursor < end) {
    const local = cursor + offset,
      boundary = Math.min(end, (Math.floor(local / day) + 1) * day - offset),
      weekDay = new Date(local).getUTCDay();
    if (weekDay !== 0 && weekDay !== 6) total += boundary - cursor;
    cursor = boundary;
  }
  return total;
}

export function distributionQuantile(
  values: number[],
  percentile: number,
): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    position = (sorted.length - 1) * percentile,
    low = Math.floor(position),
    fraction = position - low;
  return (
    sorted[low] + ((sorted[low + 1] ?? sorted[low]) - sorted[low]) * fraction
  );
}
