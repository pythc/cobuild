import type { RequirementPatch, RequirementSummary } from './api.interface';
export const TICKET_STATUSES = [
  '待分派',
  '处理中',
  '待补充',
  '已解决',
  '已关闭',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const isTicketType = (type: string) => type === '工单';
export function ticketGroupName(title: string, priority: string): string {
  const level = /^P[0-3]$/.test(priority) ? priority : '未定级';
  let name = `【${level}工单】`;
  for (const character of title.trim() || '未命名工单') {
    if (name.length + character.length > 60) break;
    name += character;
  }
  return name;
}
const transitions: Record<TicketStatus, TicketStatus[]> = {
  待分派: ['处理中', '已关闭'],
  处理中: ['待分派', '待补充', '已解决', '已关闭'],
  待补充: ['待分派', '处理中', '已解决', '已关闭'],
  已解决: ['处理中', '已关闭'],
  已关闭: ['待分派', '处理中'],
};
export function ticketAllowedStatuses(status: string): string[] {
  return TICKET_STATUSES.includes(status as TicketStatus)
    ? [status, ...transitions[status as TicketStatus]]
    : [status];
}
/** Shared by direct, queued and MCP writes; multiple handlers are intentional. */
export function ticketPatchError(
  patch: RequirementPatch,
  current: RequirementSummary | null,
): string | null {
  if (!isTicketType(patch.type ?? current?.type ?? '')) return null;
  const status = patch.status ?? current?.status ?? '待分派';
  if (!TICKET_STATUSES.includes(status as TicketStatus)) return '工单状态无效';
  const handlers =
    patch.handlerLarkUserIds ?? patch.handlerUserIds ?? current?.handlers ?? [];
  if (status === '待分派' && handlers.length)
    return '已有处理人，请选择处理中或其他处理状态';
  if (['处理中', '待补充', '已解决'].includes(status) && !handlers.length)
    return '请先设置当前处理人';
  if (
    current &&
    status !== current.status &&
    ['已解决', '已关闭'].includes(status) &&
    !(patch.latestProgress ?? '').trim()
  )
    return '解决或关闭工单时请填写本次处理结果';
  if ((patch.iterationIds ?? current?.iterationIds ?? []).length)
    return '工单不纳入研发迭代';
  return null;
}

export function requirementComplete(
  item: Pick<RequirementSummary, 'type' | 'status'>,
): boolean {
  return isTicketType(item.type)
    ? ['已解决', '已关闭'].includes(item.status)
    : ['已发布', '已关闭'].includes(item.status);
}
export function requirementInProgress(
  item: Pick<RequirementSummary, 'type' | 'status'>,
): boolean {
  return (
    !requirementComplete(item) &&
    !['新', '新建', '待分派'].includes(item.status)
  );
}
