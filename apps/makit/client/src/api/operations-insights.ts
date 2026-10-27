import { axiosForBackend } from '@/lib/selfhost-http';
import type {
  AiExecutionsResponse,
  IterationEfficiencyResponse,
  OperationsSettings,
} from '@shared/operations-insights.interface';

async function request<T>(
  url: string,
  method: 'GET' | 'POST' = 'GET',
  data?: unknown,
  signal?: AbortSignal,
  params?: object,
): Promise<T> {
  try {
    const response: { status: number; data: T } = await axiosForBackend({
      url,
      method,
      data,
      signal,
      params,
    });
    return response.data;
  } catch (error: unknown) {
    const failure = error as {
      response?: { status?: number; data?: { message?: string } };
    };
    if (failure.response?.status === 401 || failure.response?.status === 403)
      throw new Error('无权查看或修改此内容');
    if (typeof failure.response?.data?.message === 'string')
      throw new Error(failure.response.data.message);
    throw error;
  }
}
export const getExecutions = (page: number, signal?: AbortSignal) =>
  request<AiExecutionsResponse>(
    '/api/operations/executions',
    'GET',
    undefined,
    signal,
    { page },
  );
export const getSettings = (signal?: AbortSignal) =>
  request<OperationsSettings>(
    '/api/operations/settings',
    'GET',
    undefined,
    signal,
  );
export const saveSettings = (
  settings: OperationsSettings,
  previewToken?: string,
) =>
  request<OperationsSettings>('/api/operations/settings', 'POST', {
    settings,
    previewToken,
  });
export const saveFeedback = (
  id: string,
  feedback: 'adopted' | 'ignored',
  reason: string,
) =>
  request<{ success: boolean }>(
    `/api/operations/executions/${encodeURIComponent(id)}/feedback`,
    'POST',
    { feedback, reason },
  );
export const getIterationEfficiency = (id: string, signal?: AbortSignal) =>
  request<IterationEfficiencyResponse>(
    `/api/workspace/iterations/${encodeURIComponent(id)}/efficiency`,
    'GET',
    undefined,
    signal,
  );
