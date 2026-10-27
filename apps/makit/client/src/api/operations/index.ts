import { axiosForBackend } from '@/lib/selfhost-http';
import type {
  ForceRoleDTO,
  MutationResult,
  OperationListQuery,
  OperationListResponse,
  OperationProgressResponse,
  OperationsAccess,
  OperationsReviewListResponse,
  OperationsRoleMemberInput,
  WorkflowNotificationListResponse,
} from '@shared/api.interface';
import type {
  NotificationLedgerPage,
  NotificationRetryPreview,
} from '@shared/notification-ledger';

interface BackendResponse<T> {
  status: number;
  data: T;
}

interface RequestOptions {
  url: string;
  method: 'GET' | 'POST';
  params?: object;
  data?: object;
  signal?: AbortSignal;
}

async function request<T>(options: RequestOptions): Promise<T> {
  try {
    const response: BackendResponse<T> = await axiosForBackend(options);
    if (response.status === 401 || response.status === 403) {
      throw new Error('无权查看或修改此内容');
    }
    return response.data;
  } catch (error: unknown) {
    const failure: {
      response?: {
        status?: number;
        data?: { message?: unknown; error?: { message?: unknown } };
      };
    } = error instanceof Object ? error : {};
    if (failure.response?.status === 401 || failure.response?.status === 403) {
      throw new Error('无权查看或修改此内容');
    }
    const message: unknown =
      failure.response?.data?.message || failure.response?.data?.error?.message;
    if (typeof message === 'string' && message.trim()) throw new Error(message);
    throw error;
  }
}

export const getAccess = (signal?: AbortSignal): Promise<OperationsAccess> =>
  request({ url: '/api/operations/access', method: 'GET', signal });

export const getDeliveries = (
  page: number,
  signal?: AbortSignal,
): Promise<NotificationLedgerPage> =>
  request({
    url: '/api/operations/notification-deliveries',
    method: 'GET',
    params: { page, pageSize: 25 },
    signal,
  });
export const previewDeliveryRetry = (
  ids: string[],
): Promise<NotificationRetryPreview> =>
  request({
    url: '/api/operations/notification-deliveries/retry-preview',
    method: 'POST',
    data: { ids },
  });
export const confirmDeliveryRetry = (
  token: string,
): Promise<{ acceptedCount: number }> =>
  request({
    url: '/api/operations/notification-deliveries/retry',
    method: 'POST',
    data: { token },
  });
export interface OperationRecoveryPreview {
  operationId: string;
  requirementId: string;
  code: string;
  title: string;
  status: string;
  digest: string;
  warning: string;
}
export const previewOperationRecovery = (
  id: string,
): Promise<OperationRecoveryPreview> =>
  request({
    url: `/api/operations/recovery/${encodeURIComponent(id)}/preview`,
    method: 'GET',
  });
export const acknowledgeOperation = (
  id: string,
  digest: string,
  reason: string,
): Promise<{ success: boolean; message: string }> =>
  request({
    url: `/api/operations/recovery/${encodeURIComponent(id)}/acknowledge`,
    method: 'POST',
    data: { digest, reason, confirmed: true },
  });
export const retryOperationConsumer = (
  id: string,
  consumer: string,
): Promise<{ success: boolean; message: string }> =>
  request({
    url: `/api/operations/recovery/${encodeURIComponent(id)}/consumers/retry`,
    method: 'POST',
    data: { consumer, confirmed: true },
  });

export const getProgress = (
  query: OperationListQuery,
  signal?: AbortSignal,
): Promise<OperationProgressResponse> =>
  request({
    url: '/api/operations/progress',
    method: 'GET',
    params: query,
    signal,
  });

export const getRecords = (
  query: OperationListQuery,
  signal?: AbortSignal,
): Promise<OperationListResponse> =>
  request({
    url: '/api/operations/records',
    method: 'GET',
    params: query,
    signal,
  });

export const getReviews = (
  query: { page?: number; pageSize?: number },
  signal?: AbortSignal,
): Promise<OperationsReviewListResponse> =>
  request({
    url: '/api/operations/ai-reviews',
    method: 'GET',
    params: query,
    signal,
  });

export const getWorkflowNotifications = (
  query: { page?: number; pageSize?: number },
  signal?: AbortSignal,
): Promise<WorkflowNotificationListResponse> =>
  request({
    url: '/api/operations/workflow-notifications',
    method: 'GET',
    params: query,
    signal,
  });

export const getRoles = (signal?: AbortSignal): Promise<ForceRoleDTO[]> =>
  request({ url: '/api/operations/roles', method: 'GET', signal });

export const changeMember = (
  input: OperationsRoleMemberInput,
): Promise<MutationResult> =>
  request({
    url: '/api/operations/roles/members',
    method: 'POST',
    data: input,
  });
