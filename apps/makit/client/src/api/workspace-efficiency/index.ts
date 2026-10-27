import { axiosForBackend } from '@/lib/selfhost-http';
import type {
  RequirementDetailCoreResponse,
  RequirementDetailSection,
  RequirementDetailSectionResponse,
  WorkspaceSavedView,
  WorkspaceSavedViewInput,
  WorkspaceSavedViewsResponse,
} from '@shared/workspace-efficiency';
import type { RequirementBatch, RequirementBatchPreviewInput } from '@shared/requirement-batch';

async function request<T>(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  data?: object,
  signal?: AbortSignal,
): Promise<T> {
  try {
    const response: { status: number; data: T } = await axiosForBackend({
      url,
      method,
      data,
      signal,
    });
    if (response.status === 401 || response.status === 403)
      throw new Error('无权查看或修改此内容');
    return response.data;
  } catch (error: unknown) {
    const failure = error as {
      response?: {
        status?: number;
        data?: { message?: unknown; error?: { message?: unknown } };
      };
    };
    if ([401, 403].includes(failure?.response?.status || 0))
      throw new Error('无权查看或修改此内容');
    const message =
      failure?.response?.data?.message ||
      failure?.response?.data?.error?.message;
    if (typeof message === 'string') throw new Error(message);
    throw error;
  }
}

export const getViews = (
  signal?: AbortSignal,
): Promise<WorkspaceSavedViewsResponse> =>
  request('/api/workspace/views', 'GET', undefined, signal);
export const previewBatch = (input: RequirementBatchPreviewInput): Promise<RequirementBatch> =>
  request('/api/workspace/requirement-batches/preview', 'POST', input);
export const getBatch = (id: string): Promise<RequirementBatch> =>
  request(`/api/workspace/requirement-batches/${encodeURIComponent(id)}`, 'GET');
export const executeBatch = (id: string): Promise<RequirementBatch> =>
  request(`/api/workspace/requirement-batches/${encodeURIComponent(id)}/execute`, 'POST');
export const retryBatchPreview = (id: string, clientMutationId: string): Promise<RequirementBatch> =>
  request(`/api/workspace/requirement-batches/${encodeURIComponent(id)}/retry-preview`, 'POST', { clientMutationId });
export const saveView = (
  input: WorkspaceSavedViewInput,
  id?: string,
): Promise<WorkspaceSavedView> =>
  request(
    `/api/workspace/views${id ? `/${encodeURIComponent(id)}` : ''}`,
    id ? 'PUT' : 'POST',
    input,
  );
export const deleteView = (
  id: string,
  version: number,
): Promise<{ success: boolean; message: string }> =>
  request(
    `/api/workspace/views/${encodeURIComponent(id)}?version=${version}`,
    'DELETE',
  );
export const getRequirementCore = (
  id: string,
  signal?: AbortSignal,
): Promise<RequirementDetailCoreResponse> =>
  request(
    `/api/workspace/requirements/${encodeURIComponent(id)}/core`,
    'GET',
    undefined,
    signal,
  );
export const getRequirementSection = <T extends RequirementDetailSection>(
  id: string,
  section: T,
  signal?: AbortSignal,
): Promise<RequirementDetailSectionResponse<T>> =>
  request(
    `/api/workspace/requirements/${encodeURIComponent(id)}/sections/${section}`,
    'GET',
    undefined,
    signal,
  );
