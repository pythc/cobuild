import type { PersonRef, RequirementSummary } from '@shared/api.interface';
import { marked } from 'marked';

export const STATUS_ORDER: string[] = [
  '新',
  '需求已评审',
  '开发中',
  '开发转测试',
  '测试中',
  '产品体验中',
  '待发布',
  '已发布',
];

export const DEFECT_STATUS_ORDER: string[] = [
  '新建',
  '处理中',
  '已解决',
  '已验证',
  '已关闭',
  '重新打开',
  '已拒绝',
];

export const PRIORITY_STYLES: Record<string, string> = {
  P0: 'border-red-200 bg-red-50 text-red-700',
  P1: 'border-orange-200 bg-orange-50 text-orange-700',
  P2: 'border-blue-200 bg-blue-50 text-blue-700',
  P3: 'border-slate-200 bg-slate-50 text-slate-600',
};

export const REQUIREMENT_TYPE_STYLES: Record<string, string> = {
  缺陷: 'border-red-200 bg-red-50 text-red-700',
  产品需求: 'border-blue-200 bg-blue-50 text-blue-700',
  技术需求: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  体验优化: 'border-violet-200 bg-violet-50 text-violet-700',
  稳定性: 'border-amber-200 bg-amber-50 text-amber-700',
  安全需求: 'border-orange-200 bg-orange-50 text-orange-700',
  需求: 'border-slate-200 bg-slate-50 text-slate-700',
};

export const STATUS_STYLES: Record<string, string> = {
  新: 'border-slate-200 bg-slate-50 text-slate-700',
  需求已评审: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  开发中: 'border-blue-200 bg-blue-50 text-blue-700',
  开发转测试: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  测试中: 'border-violet-200 bg-violet-50 text-violet-700',
  产品体验中: 'border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700',
  待发布: 'border-amber-200 bg-amber-50 text-amber-700',
  已发布: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  新建: 'border-slate-200 bg-slate-50 text-slate-700',
  处理中: 'border-blue-200 bg-blue-50 text-blue-700',
  已解决: 'border-violet-200 bg-violet-50 text-violet-700',
  已验证: 'border-cyan-200 bg-cyan-50 text-cyan-700',
  已关闭: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  重新打开: 'border-amber-200 bg-amber-50 text-amber-700',
  已拒绝: 'border-red-200 bg-red-50 text-red-700',
};

export function dateTimestamp(value: string | number | null): number | null {
  if (value == null || value === '') return null;
  const raw =
    typeof value === 'number' || /^\d{11,}$/u.test(String(value))
      ? Number(value)
      : Date.parse(String(value).replace(' ', 'T'));
  return Number.isFinite(raw) ? raw : null;
}

export function formatDate(
  value: string | number | null,
  includeTime = false,
): string {
  if (value == null || value === '') return '未设置';
  const raw = dateTimestamp(value);
  if (raw == null) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(includeTime
      ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const }
      : {}),
  }).format(new Date(raw));
}

export function toDateInput(value: string | number | null): string {
  if (value == null || value === '') return '';
  const raw = dateTimestamp(value);
  if (raw == null) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(raw));
  const map = Object.fromEntries(parts.map((item) => [item.type, item.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function dateInputToTimestamp(value: string): number | null {
  return value ? Date.parse(`${value}T00:00:00+08:00`) : null;
}

export function peopleLabel(people: PersonRef[]): string {
  return people.length
    ? people.map((person) => person.name || '成员').join('、')
    : '未设置';
}

export function nextStatus(requirement: RequirementSummary): string | null {
  if (requirement.workflow) {
    const index = requirement.workflow.statuses.indexOf(requirement.status);
    return (
      requirement.workflow.statuses
        .slice(index + 1)
        .find((status) => requirement.allowedStatuses.includes(status)) ||
      requirement.allowedStatuses[0] ||
      null
    );
  }
  if (requirement.type === '缺陷') {
    const preferred: Record<string, string> = {
      新建: '处理中',
      处理中: '已解决',
      已解决: '已验证',
      已验证: '已关闭',
      重新打开: '处理中',
    };
    return preferred[requirement.status] || null;
  }
  const index = STATUS_ORDER.indexOf(requirement.status);
  return index >= 0 && index < STATUS_ORDER.length - 1
    ? STATUS_ORDER[index + 1]
    : null;
}

export function plainText(html: string): string {
  return html
    .replace(/<style[^>]*>.*?<\/style>/gsu, ' ')
    .replace(/<script[^>]*>.*?<\/script>/gsu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function isHtmlContent(value: string): boolean {
  return /<\/?(?:p|div|h[1-6]|ul|ol|li|blockquote|pre|code|strong|em|u|s|a|img|br|hr|table|thead|tbody|tr|th|td)(?:\s[^>]*)?\/?>/iu.test(
    value,
  );
}

export function editorHtml(value: string): string {
  if (!value.trim() || isHtmlContent(value)) return value;
  return marked.parse(value, {
    async: false,
    breaks: true,
    gfm: true,
  }) as string;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return '操作失败，请稍后重试';
}
