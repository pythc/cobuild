import { logger } from '@/lib/selfhost-http';
export * as operationsApi from './operations';
export * as workspaceEfficiencyApi from './workspace-efficiency';
export * as operationsInsightsApi from './operations-insights';
import { axiosForBackend } from '@/lib/selfhost-http';
import type {
  AcceptanceCreateInput,
  AcceptanceUpdateInput,
  BulkMutationResult,
  BulkRequirementUpdateInput,
  CommentCreateInput,
  CurrentUserSummary,
  GroupAction,
  McpCredentialResponse,
  McpCredentialStatus,
  McpEncryptedCredentialResponse,
  MutationResult,
  NotificationDeliveryListResponse,
  NotificationDeliveryStatus,
  PullRequestDetailResponse,
  PullRequestRefreshResult,
  PullRequestReviewerUpdateInput,
  PullRequestReviewerUpdateResult,
  PullRequestSummary,
  PullRequestWorkspaceResponse,
  RelationCreateInput,
  RequirementCreateInput,
  RequirementArchiveListResponse,
  RequirementDetailResponse,
  RequirementAiReviewOverrideInput,
  RequirementAiReviewType,
  RequirementArtifactKind,
  RequirementArtifactUpsertInput,
  RequirementEngineeringResponse,
  RequirementEditContext,
  RequirementListQuery,
  RequirementListResponse,
  RequirementPersonnelResponse,
  RequirementReleaseReadiness,
  RequirementUpdateInput,
  RequirementUpdateJobAccepted,
  RequirementUpdateJobSummary,
  WorkspaceBrowserResponse,
  WorkspaceResponse,
  WorkspaceSummaryResponse,
} from '@shared/api.interface';
import { createMcpCredentialExchange } from '@/lib/mcp-credential-crypto';
import type {
  IterationConfiguration,
  IterationSettingsResponse,
  IterationSettingsInput,
  IterationSettingsImpact,
} from '@shared/iteration-workflow';

export const getIterationSettings = (id: string, signal?: AbortSignal) =>
  request<IterationSettingsResponse>({
    url: `/api/workspace/iterations/${encodeURIComponent(id)}/settings`,
    method: 'GET',
    signal,
    logLabel: '读取迭代配置',
  });
export const saveIterationSettings = (
  id: string,
  input: IterationSettingsInput,
  publish = false,
) =>
  request<IterationSettingsResponse>({
    url: `/api/workspace/iterations/${encodeURIComponent(id)}/settings/${publish ? 'publish' : 'draft'}`,
    method: 'POST',
    data: input,
    logLabel: '保存迭代配置',
  });
export const validateIterationSettings = (
  id: string,
  configuration: IterationConfiguration,
) =>
  request<IterationSettingsImpact>({
    url: `/api/workspace/iterations/${encodeURIComponent(id)}/settings/validate`,
    method: 'POST',
    data: { configuration },
    logLabel: '检查迭代配置',
  });

interface BackendResponse<T> {
  status: number;
  data: T;
}

function backendErrorMessage(error: unknown): string {
  const payload: unknown = (error as { response?: { data?: unknown } })
    ?.response?.data;
  if (!payload || typeof payload !== 'object') return '';
  const body: Record<string, unknown> = payload as Record<string, unknown>;
  const candidates: unknown[] = [
    body.message,
    body.msg,
    (body.error as Record<string, unknown> | undefined)?.message,
    (body.data as Record<string, unknown> | undefined)?.message,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
    if (Array.isArray(candidate)) {
      const messages: string[] = candidate
        .filter((item: unknown): item is string => typeof item === 'string')
        .map((item: string): string => item.trim())
        .filter(Boolean);
      if (messages.length) return messages.join('；');
    }
  }
  return '';
}

async function request<T>(config: {
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  params?: Record<string, unknown>;
  data?: unknown;
  signal?: AbortSignal;
  logLabel: string;
}): Promise<T> {
  try {
    const response: BackendResponse<T> = (await axiosForBackend({
      url: config.url,
      method: config.method,
      params: config.params,
      data: config.data,
      signal: config.signal,
    })) as BackendResponse<T>;
    if (response.status === 403) {
      throw Object.assign(new Error('无操作权限，请联系应用管理员'), {status:403});
    }
    return response.data;
  } catch (error) {
    logger.error(config.logLabel, error);
    const status: number | undefined = (
      error as { response?: { status?: number } }
    )?.response?.status;
    if (status === 403) {
      throw Object.assign(new Error('无操作权限，请联系应用管理员'), {status:403});
    }
    const message: string = backendErrorMessage(error);
    if (message) throw Object.assign(new Error(message), {status});
    throw error;
  }
}

export async function getBrowserWorkspace(refresh = false, signal?: AbortSignal): Promise<WorkspaceBrowserResponse> {
  const result = await request<WorkspaceBrowserResponse>({
    url: '/api/workspace/browser-index', method: 'GET',
    params: refresh ? { refresh: 'true' } : undefined, signal,
    logLabel: '获取需求列表失败',
  });
  if (result.complete !== true) throw new Error('需求列表未完整加载，请刷新后重试');
  return result;
}

export async function getWorkspace(
  refresh: boolean = false,
  signal?: AbortSignal,
): Promise<WorkspaceResponse> {
  return request<WorkspaceResponse>({
    url: '/api/workspace',
    method: 'GET',
    params: refresh ? { refresh: 'true' } : undefined,
    signal,
    logLabel: '获取需求协作平台数据失败',
  });
}

export async function getWorkspaceSummary(
  refresh: boolean = false,
  signal?: AbortSignal,
): Promise<WorkspaceSummaryResponse> {
  return request<WorkspaceSummaryResponse>({
    url: '/api/workspace/summary',
    method: 'GET',
    params: refresh ? { refresh: 'true' } : undefined,
    signal,
    logLabel: '获取需求工作区摘要失败',
  });
}

export async function getCurrentPlatformUser(
  signal?: AbortSignal,
): Promise<CurrentUserSummary> {
  return request<CurrentUserSummary>({
    url: '/api/workspace/current-user',
    method: 'GET',
    signal,
    logLabel: '获取当前平台用户失败',
  });
}

export async function getRequirements(
  query: RequirementListQuery,
  refresh: boolean = false,
  signal?: AbortSignal,
): Promise<RequirementListResponse> {
  const params: Record<string, unknown> = {
    includeContent: query.includeContent === false ? '0' : undefined,
    page: query.page,
    pageSize: query.pageSize,
    q: query.search,
    status: query.status,
    priority: query.priority,
    project: query.project,
    type: query.type,
    source: query.source,
    iteration: query.iterationId,
    handler: query.handlerId,
    product: query.productOwnerId,
    developer: query.developerId,
    tester: query.testerId,
    fo: query.foOwnerId,
    risk: query.risk,
    mine: query.mineOnly ? '1' : undefined,
    excludeId: query.excludeId,
    groupBy: query.groupBy,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
    refresh: refresh ? 'true' : undefined,
  };
  Object.keys(params).forEach((key: string): void => {
    if (params[key] === undefined || params[key] === '') delete params[key];
  });
  return request<RequirementListResponse>({
    url: '/api/workspace/requirements',
    method: 'GET',
    params,
    signal,
    logLabel: '获取需求列表失败',
  });
}

export async function getRequirementArchive(
  signal?: AbortSignal,
): Promise<RequirementArchiveListResponse> {
  return request<RequirementArchiveListResponse>({
    url: '/api/workspace/requirement-archive',
    method: 'GET',
    signal,
    logLabel: '获取需求归档失败',
  });
}

export async function getRequirementEditContext(
  signal?: AbortSignal,
): Promise<RequirementEditContext> {
  return request<RequirementEditContext>({
    url: '/api/workspace/requirements/edit-context',
    method: 'GET',
    signal,
    logLabel: '获取需求编辑选项失败',
  });
}

export async function restoreRequirement(
  recordId: string,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: `/api/workspace/requirements/${recordId}/restore`,
    method: 'POST',
    logLabel: '恢复需求失败',
  });
}

export async function permanentlyDeleteRequirement(
  recordId: string,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: `/api/workspace/requirements/${recordId}/permanent`,
    method: 'DELETE',
    logLabel: '永久删除需求失败',
  });
}

export async function getPullRequestWorkspace(
  signal?: AbortSignal,
): Promise<PullRequestWorkspaceResponse> {
  return request<PullRequestWorkspaceResponse>({
    url: '/api/pull-requests',
    method: 'GET',
    signal,
    logLabel: '获取合并请求失败',
  });
}

export async function getNotificationDeliveries(
  status: NotificationDeliveryStatus | undefined,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<NotificationDeliveryListResponse> {
  return request<NotificationDeliveryListResponse>({
    url: '/api/notifications',
    method: 'GET',
    params: {
      status,
      page,
      pageSize,
    },
    signal,
    logLabel: '获取通知运行记录失败',
  });
}

export async function getPullRequestDetail(
  pullNumber: number,
  signal?: AbortSignal,
): Promise<PullRequestDetailResponse> {
  return request<PullRequestDetailResponse>({
    url: `/api/pull-requests/${pullNumber}`,
    method: 'GET',
    signal,
    logLabel: '获取合并请求详情失败',
  });
}

export async function getRequirementPullRequests(
  recordId: string,
  signal?: AbortSignal,
): Promise<PullRequestSummary[]> {
  return request<PullRequestSummary[]>({
    url: `/api/pull-requests/requirements/${recordId}`,
    method: 'GET',
    signal,
    logLabel: '获取需求关联的合并请求失败',
  });
}

export async function refreshPullRequests(): Promise<PullRequestRefreshResult> {
  return request<PullRequestRefreshResult>({
    url: '/api/pull-requests/refresh',
    method: 'POST',
    logLabel: '刷新合并请求失败',
  });
}

export async function updatePullRequestReviewers(
  pullNumber: number,
  input: PullRequestReviewerUpdateInput,
): Promise<PullRequestReviewerUpdateResult> {
  return request<PullRequestReviewerUpdateResult>({
    url: `/api/pull-requests/${pullNumber}/reviewers`,
    method: 'PATCH',
    data: input,
    logLabel: '保存合并请求评审人失败',
  });
}

export async function getMcpCredentialStatus(
  signal?: AbortSignal,
): Promise<McpCredentialStatus> {
  return request<McpCredentialStatus>({
    url: '/api/workspace/mcp-credential',
    method: 'GET',
    signal,
    logLabel: '获取 MCP 接入状态失败',
  });
}

export async function issueMcpCredential(
  signal?: AbortSignal,
): Promise<McpCredentialResponse> {
  const exchange = await createMcpCredentialExchange();
  const encrypted: McpEncryptedCredentialResponse =
    await request<McpEncryptedCredentialResponse>({
      url: '/api/workspace/mcp-credential',
      method: 'POST',
      data: exchange.input,
      signal,
      logLabel: '获取 MCP Key 失败',
    });
  return exchange.decrypt(encrypted);
}

export async function rotateMcpCredential(
  signal?: AbortSignal,
): Promise<McpCredentialResponse> {
  const exchange = await createMcpCredentialExchange();
  const encrypted: McpEncryptedCredentialResponse =
    await request<McpEncryptedCredentialResponse>({
      url: '/api/workspace/mcp-credential/rotate',
      method: 'POST',
      data: exchange.input,
      signal,
      logLabel: '重新生成 MCP Key 失败',
    });
  return exchange.decrypt(encrypted);
}

export async function getRequirementDetail(
  recordId: string,
  signal?: AbortSignal,
): Promise<RequirementDetailResponse> {
  return request<RequirementDetailResponse>({
    url: `/api/workspace/requirements/${recordId}`,
    method: 'GET',
    signal,
    logLabel: '获取需求详情失败',
  });
}

export async function getRequirementEngineering(
  recordId: string,
  signal?: AbortSignal,
): Promise<RequirementEngineeringResponse> {
  return request<RequirementEngineeringResponse>({
    url: `/api/workspace/requirements/${recordId}/engineering`,
    method: 'GET',
    signal,
    logLabel: '获取研发资料和 AI 评审失败',
  });
}

export async function saveRequirementArtifact(
  recordId: string,
  kind: RequirementArtifactKind,
  input: RequirementArtifactUpsertInput,
): Promise<RequirementEngineeringResponse> {
  return request<RequirementEngineeringResponse>({
    url: `/api/workspace/requirements/${recordId}/artifacts/${kind}`,
    method: 'PATCH',
    data: input,
    logLabel: '保存研发资料失败',
  });
}

export async function retryRequirementReview(
  recordId: string,
  type: RequirementAiReviewType,
): Promise<RequirementEngineeringResponse> {
  return request<RequirementEngineeringResponse>({
    url: `/api/workspace/requirements/${recordId}/reviews/${type}/retry`,
    method: 'POST',
    logLabel: '重新发起 AI 评审失败',
  });
}

export async function overrideRequirementReview(
  recordId: string,
  type: RequirementAiReviewType,
  input: RequirementAiReviewOverrideInput,
): Promise<RequirementEngineeringResponse> {
  return request<RequirementEngineeringResponse>({
    url: `/api/workspace/requirements/${recordId}/reviews/${type}/override`,
    method: 'POST',
    data: input,
    logLabel: '风险放行失败',
  });
}

export async function getRequirementReleaseReadiness(
  recordId: string,
  targetStatus: '待发布' | '已发布' = '待发布',
  signal?: AbortSignal,
): Promise<RequirementReleaseReadiness> {
  return request<RequirementReleaseReadiness>({
    url: `/api/workspace/requirements/${recordId}/release-readiness`,
    method: 'GET',
    params: { targetStatus },
    signal,
    logLabel: '检查发布就绪状态失败',
  });
}

export async function getRequirementPersonnel(
  recordId: string,
  signal?: AbortSignal,
): Promise<RequirementPersonnelResponse> {
  return request<RequirementPersonnelResponse>({
    url: `/api/workspace/requirements/${recordId}/personnel`,
    method: 'GET',
    signal,
    logLabel: '获取需求协作成员失败',
  });
}

export async function createRequirement(
  input: RequirementCreateInput,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: '/api/workspace/requirements',
    method: 'POST',
    data: input,
    logLabel: '创建需求失败',
  });
}

export async function updateRequirement(
  recordId: string,
  input: RequirementUpdateInput,
): Promise<RequirementUpdateJobAccepted> {
  return request<RequirementUpdateJobAccepted>({
    url: `/api/workspace/requirements/${recordId}/update-jobs`,
    method: 'POST',
    data: input,
    logLabel: '提交需求更新失败',
  });
}

export async function getRequirementUpdateJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<RequirementUpdateJobSummary> {
  return request<RequirementUpdateJobSummary>({
    url: `/api/workspace/requirement-update-jobs/${jobId}`,
    method: 'GET',
    signal,
    logLabel: '获取需求更新进度失败',
  });
}

export async function bulkUpdateRequirements(
  input: BulkRequirementUpdateInput,
): Promise<BulkMutationResult> {
  return request<BulkMutationResult>({
    url: '/api/workspace/requirements/bulk-update',
    method: 'POST',
    data: input,
    logLabel: '批量更新需求失败',
  });
}

export async function deleteRequirement(
  recordId: string,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: `/api/workspace/requirements/${recordId}`,
    method: 'DELETE',
    logLabel: '删除需求失败',
  });
}

export async function addComment(
  recordId: string,
  input: CommentCreateInput,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: `/api/workspace/requirements/${recordId}/comments`,
    method: 'POST',
    data: input,
    logLabel: '发布评论失败',
  });
}

export async function addAcceptanceItem(
  recordId: string,
  input: AcceptanceCreateInput,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: `/api/workspace/requirements/${recordId}/acceptance`,
    method: 'POST',
    data: input,
    logLabel: '添加验收项失败',
  });
}

export async function updateAcceptanceItem(
  itemId: string,
  input: AcceptanceUpdateInput,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: `/api/workspace/acceptance/${itemId}`,
    method: 'PATCH',
    data: input,
    logLabel: '更新验收项失败',
  });
}

export async function addRelation(
  recordId: string,
  input: RelationCreateInput,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: `/api/workspace/requirements/${recordId}/relations`,
    method: 'POST',
    data: input,
    logLabel: '建立需求关联失败',
  });
}

export async function runGroupAction(
  recordId: string,
  action: GroupAction,
): Promise<MutationResult> {
  return request<MutationResult>({
    url: `/api/workspace/requirements/${recordId}/group/${action}`,
    method: 'POST',
    logLabel: action === 'create' ? '创建需求群失败' : '同步群成员失败',
  });
}

export async function getProjectManagement(
  signal?: AbortSignal,
): Promise<import('@shared/api.interface').ProjectManagementResponse> {
  return request({
    url: '/api/workspace/project-management',
    method: 'GET',
    signal,
    logLabel: '读取项目管理失败',
  });
}

/** Raw Relay controllers share the platform SDK transport and native login cookie. */
export async function relayRequest<T>(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  data?: unknown,
  key?: string,
): Promise<T> {
  try {
    const response = (await axiosForBackend({
      url,
      method,
      data,
      headers: key ? { 'Idempotency-Key': key } : undefined,
    })) as { data: T };
    return response.data;
  } catch (error) {
    const message = backendErrorMessage(error);
    const status = (error as { response?: { status?: number } })?.response
      ?.status;
    throw Object.assign(new Error(message || '客服服务暂时不可用，请重试'), {
      status,
    });
  }
}

export function relayWidgetGrant(challenge: string): Promise<{ grant: string }> {
  return request({
    url: '/api/relay/widget-grant',
    method: 'POST',
    data: { app: 'makit', challenge },
    logLabel: 'relay.widget.grant.failed',
  });
}

export async function projectAction(input: {
  projectId: string; requestId: string; action: import('@shared/project-actions').ProjectAction;
  input?: Record<string, unknown>;
}): Promise<import('@shared/project-actions').LiveProject> {
  return request({url:'/api/workspace/project-management/action',method:'POST',data:input,logLabel:'项目操作失败'});
}

export async function getMemberAvatar(openId:string):Promise<{avatarUrl:string}> {
  return request({url:'/api/workspace/members/'+encodeURIComponent(openId)+'/avatar',method:'GET',logLabel:'读取飞书头像失败'});
}
