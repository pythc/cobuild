import type {
  OperationRecord,
  RequirementUpdateJobStatus,
} from '@shared/api.interface';

export const OPERATION_STATUS: Record<
  RequirementUpdateJobStatus,
  { label: string; tone: string }
> = {
  queued: {
    label: '待处理',
    tone: 'border-slate-200 bg-slate-50 text-slate-600',
  },
  running: {
    label: '处理中',
    tone: 'border-blue-200 bg-blue-50 text-blue-700',
  },
  succeeded: {
    label: '已完成',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  },
  failed: { label: '未完成', tone: 'border-red-200 bg-red-50 text-red-700' },
  unknown: { label: '待核实', tone: 'border-amber-200 bg-amber-50 text-amber-700' },
};

export function operationStatus(
  value: string | null,
): RequirementUpdateJobStatus | 'all' {
  return value === 'queued' ||
    value === 'running' ||
    value === 'succeeded' ||
    value === 'failed' ||
    value === 'unknown'
    ? value
    : 'all';
}

export function operationPage(value: string | null): number {
  const parsed: number = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, 100_000)
    : 1;
}

export function operationTime(value: string | number | null): string {
  if (value === null || value === '') return '—';
  const parsed: Date = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(parsed);
}

export function operationTitle(item: OperationRecord): string {
  return item.intent === 'status-transition'
    ? `流转${item.targetStatus ? `至${item.targetStatus}` : '需求状态'}`
    : '修改需求';
}

export function operationNeedsPolling(items: OperationRecord[]): boolean {
  return items.some(
    (item: OperationRecord): boolean =>
      item.status === 'queued' || item.status === 'running',
  );
}
