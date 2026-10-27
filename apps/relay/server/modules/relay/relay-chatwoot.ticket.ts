import type { RequirementSummary } from '../../../shared/api.interface';
import { relayMarker } from '../requirements/relay-intake.model';
export function mapRelayTicket(
  r: RequirementSummary,
  id: string,
  context: any,
  createdAt: string | undefined,
  contextBaseUrl: string,
  sourceId: string,
): any {
  return {
    live: true,
    id: r.id,
    code: r.code,
    type: '工单',
    projectId: 'relay-support',
    conversationId: id,
    title: r.title,
    description: context.description ?? r.introduction,
    priority: ['P0', 'P1'].includes(r.priority)
      ? '紧急'
      : r.priority === 'P3'
        ? '较低'
        : '普通',
    handlerIds: r.personnelUserIds.handlers,
    handlerName: r.handlers.map((h) => h.name).join('、') || '未分派',
    owner: r.handlers.map((h) => h.name).join('、') || '未分派',
    status: r.status,
    nativeStatus: r.status,
    nativeUrl: r.url,
    revision: r.updatedAt,
    createdAt: createdAt || r.updatedAt,
    created: createdAt || r.updatedAt,
    updatedAt: r.updatedAt,
    creatorId: '',
    context: {
      ...context,
      downloadUrl: contextBaseUrl + relayMarker(sourceId, id),
      messages: (context.messages || []).map((m: any) => ({
        ...m,
        side:
          (
            { 用户: 'customer', 客服: 'operator', 系统: 'system' } as Record<
              string,
              string
            >
          )[m.side] || m.side,
      })),
      capturedAt: context.capturedAt || new Date().toISOString(),
    },
    events: r.latestProgress
      ? [
          {
            id: 'latest-progress',
            text: r.latestProgress,
            actorId: '',
            actorName: r.updatedByName,
            time: r.updatedAt,
          },
        ]
      : [],
    replies: [],
    group: {
      state: r.groupChatId
        ? 'created'
        : r.groupStatus === '创建中'
          ? 'unknown'
          : r.groupStatus === '失败'
            ? 'failed'
            : 'none',
      id: r.groupChatId,
      url: r.groupLink,
      memberIds: r.personnelUserIds.handlers,
    },
  };
}
