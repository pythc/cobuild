import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { BROWSER_WORKSPACE_QUERY_KEY } from './use-browser-workspace';
import { requirementUpdateQueues } from '@/lib/requirement-update-queues';
import { prepareOperationInput } from '@shared/requirement-operation';
import { sampleAfterPaint } from '@/lib/experience-sampling';
import type { QueryClient } from '@tanstack/react-query';
import type {
  BulkMutationResult,
  BulkRequirementUpdateInput,
  CurrentUserSummary,
  MutationResult,
  RequirementCreateInput,
  RequirementDetailResponse,
  RequirementListQuery,
  RequirementListResponse,
  RequirementSummary,
  RequirementUpdateInput,
  RequirementUpdateJobAccepted,
  RequirementUpdateJobSummary,
  WorkspaceResponse,
  WorkspaceSummaryResponse,
} from '@shared/api.interface';
import { toast } from 'sonner';
import {
  bulkUpdateRequirements,
  createRequirement,
  getCurrentPlatformUser,
  getRequirementDetail,
  getRequirements,
  getWorkspace,
  getWorkspaceSummary,
  getRequirementUpdateJob,
  updateRequirement,
} from '@/api';
import {
  updateRequirementDetail,
  updateRequirementList,
  updateWorkspaceRequirement,
} from '@/lib/optimistic-requirement';

export const WORKSPACE_QUERY_KEY = ['workspace'] as const;
export const WORKSPACE_SUMMARY_QUERY_KEY = ['workspace-summary'] as const;
export const REQUIREMENTS_QUERY_KEY = ['requirements'] as const;
export const CURRENT_PLATFORM_USER_QUERY_KEY = [
  'current-platform-user',
] as const;

const UPDATE_JOB_TIMEOUT_MS: number = 120_000;
const UPDATE_JOB_INITIAL_POLL_MS: number = 500;
const UPDATE_JOB_MAX_POLL_MS: number = 5_000;

interface SharedJobPoll {
  controller: AbortController;
  promise: Promise<RequirementUpdateJobSummary>;
  subscribers: Set<symbol>;
}

const updateJobPolls: Map<string, SharedJobPoll> = new Map();
const recoveredInvalidations: Map<string, Promise<void>> = new Map();
let updateJobPageHideRegistered: boolean = false;

/** Restore authoritative values only after newer optimistic changes have settled. */
export function invalidateRecoveredRequirement(
  queryClient: QueryClient,
  recordId: string,
): Promise<void> {
  const existing = recoveredInvalidations.get(recordId);
  if (existing) return existing;
  const operation = (async (): Promise<void> => {
    // Lists contain more than one requirement: do not overwrite another row's pending edit either.
    while (requirementUpdateQueues.size) {
      await Promise.allSettled([...requirementUpdateQueues.values()]);
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: WORKSPACE_SUMMARY_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: REQUIREMENTS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: ['requirement', recordId] }),
    ]);
  })();
  recoveredInvalidations.set(recordId, operation);
  void operation
    .finally(() => recoveredInvalidations.delete(recordId))
    .catch(() => undefined);
  return operation;
}

function registerUpdateJobPageHideCancellation(): void {
  if (updateJobPageHideRegistered || typeof window === 'undefined') return;
  updateJobPageHideRegistered = true;
  window.addEventListener('pagehide', (): void => {
    updateJobPolls.forEach((poll: SharedJobPoll): void =>
      poll.controller.abort(),
    );
    updateJobPolls.clear();
  });
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject): void => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = (): void => {
      if (timer) clearTimeout(timer);
      const error = new Error('需求更新轮询已取消');
      error.name = 'AbortError';
      reject(error);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    timer = setTimeout((): void => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function pollRequirementUpdateJob(
  jobId: string,
  signal: AbortSignal,
): Promise<RequirementUpdateJobSummary> {
  const deadline: number = Date.now() + UPDATE_JOB_TIMEOUT_MS;
  let delayMs: number = UPDATE_JOB_INITIAL_POLL_MS;
  while (Date.now() < deadline) {
    await waitFor(delayMs, signal);
    try {
      const job: RequirementUpdateJobSummary = await getRequirementUpdateJob(
        jobId,
        signal,
      );
      if (job.status === 'failed' || job.status === 'succeeded' || job.status === 'unknown') return job;
    } catch (error) {
      if ((error as Error)?.name === 'AbortError' || signal.aborted)
        throw error;
      // Transient request failures keep the durable job running. The next
      // attempt uses exponential backoff instead of creating a tight loop.
    }
    delayMs = Math.min(UPDATE_JOB_MAX_POLL_MS, Math.round(delayMs * 1.6));
  }
  throw new Error('修改状态确认超时，请刷新查看最新结果');
}

function subscribeToUpdateJob(jobId: string): {
  promise: Promise<RequirementUpdateJobSummary>;
  cancel: () => void;
} {
  let poll: SharedJobPoll | undefined = updateJobPolls.get(jobId);
  if (poll?.controller.signal.aborted) {
    updateJobPolls.delete(jobId);
    poll = undefined;
  }
  if (!poll) {
    registerUpdateJobPageHideCancellation();
    const controller = new AbortController();
    const promise = pollRequirementUpdateJob(jobId, controller.signal);
    poll = { controller, promise, subscribers: new Set() };
    updateJobPolls.set(jobId, poll);
    const clear = (): void => {
      if (updateJobPolls.get(jobId) === poll) updateJobPolls.delete(jobId);
    };
    void promise.then(clear, clear);
  }
  const token = Symbol(jobId);
  poll.subscribers.add(token);
  let released: boolean = false;
  return {
    promise: poll.promise,
    cancel: (): void => {
      if (released) return;
      released = true;
      poll?.subscribers.delete(token);
      if (poll && poll.subscribers.size === 0) poll.controller.abort();
    },
  };
}

export function useCurrentPlatformUser() {
  return useQuery<CurrentUserSummary>({
    queryKey: CURRENT_PLATFORM_USER_QUERY_KEY,
    queryFn: ({ signal }) => getCurrentPlatformUser(signal),
    staleTime: 5 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useWorkspace() {
  return useQuery<WorkspaceResponse>({
    queryKey: WORKSPACE_QUERY_KEY,
    queryFn: ({ signal }) => getWorkspace(false, signal),
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useWorkspaceSummary() {
  return useQuery<WorkspaceSummaryResponse>({
    queryKey: WORKSPACE_SUMMARY_QUERY_KEY,
    queryFn: ({ signal }) => getWorkspaceSummary(false, signal),
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useRequirementList(
  query: RequirementListQuery,
  enabled: boolean = true,
) {
  const startedAt = useRef(performance.now());
  const sampled = useRef(false);
  const result = useQuery<RequirementListResponse>({
    queryKey: [...REQUIREMENTS_QUERY_KEY, query],
    queryFn: async ({ signal }) => {
      const result = await getRequirements({ ...query, includeContent: query.includeContent ?? false }, false, signal);
      return result;
    },
    placeholderData: (previous: RequirementListResponse | undefined) =>
      previous,
    enabled,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (result.isSuccess && !result.isPlaceholderData && !sampled.current) {
      sampled.current = true;
      sampleAfterPaint('first_usable', startedAt.current);
    }
  }, [result.isSuccess, result.isPlaceholderData]);
  return result;
}

export function useRefreshWorkspaceSummary() {
  const queryClient = useQueryClient();
  return useMutation<WorkspaceSummaryResponse, Error>({
    mutationFn: () => getWorkspaceSummary(true),
    onSuccess: (data: WorkspaceSummaryResponse): void => {
      queryClient.setQueryData(WORKSPACE_SUMMARY_QUERY_KEY, data);
      void queryClient.invalidateQueries({ queryKey: REQUIREMENTS_QUERY_KEY });
    },
  });
}

export function useRefreshWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<WorkspaceResponse, Error>({
    mutationFn: () => getWorkspace(true),
    onSuccess: (data) => {
      queryClient.setQueryData(WORKSPACE_QUERY_KEY, data);
    },
  });
}

export function useCreateRequirement() {
  const queryClient = useQueryClient();
  return useMutation<MutationResult, Error, RequirementCreateInput>({
    mutationFn: createRequirement,
    onSuccess: () => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }),
        queryClient.invalidateQueries({
          queryKey: WORKSPACE_SUMMARY_QUERY_KEY,
        }),
        queryClient.invalidateQueries({ queryKey: REQUIREMENTS_QUERY_KEY }),
      ]);
    },
    onError: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }),
        queryClient.invalidateQueries({
          queryKey: WORKSPACE_SUMMARY_QUERY_KEY,
        }),
        queryClient.invalidateQueries({ queryKey: REQUIREMENTS_QUERY_KEY }),
      ]);
    },
  });
}

export function useUpdateRequirement() {
  const queryClient = useQueryClient();
  const invalidateRequirement = async (recordId: string): Promise<void> => {
    await invalidateRecoveredRequirement(queryClient, recordId);
  };
  return useMutation<
    RequirementUpdateJobAccepted,
    Error,
    {
      recordId: string;
      input: RequirementUpdateInput;
      optimistic?: Partial<RequirementSummary>;
    }
  >({
    mutationFn: async ({ recordId, input }) => {
      const predecessor: Promise<void> | undefined =
        requirementUpdateQueues.get(recordId);
      let releaseQueue: () => void = (): void => undefined;
      const completion = new Promise<void>((resolve): void => {
        releaseQueue = resolve;
      });
      const queueTail: Promise<void> = (predecessor || Promise.resolve())
        .catch((): void => undefined)
        .then(() => completion);
      requirementUpdateQueues.set(recordId, queueTail);

      try {
        if (predecessor) await predecessor.catch((): void => undefined);
        const effectiveInput: RequirementUpdateInput = predecessor
          ? {
              ...input,
              expectedUpdatedAt: (await getRequirementDetail(recordId))
                .requirement.updatedAt,
            }
          : input;
        const validationStartedAt = performance.now();
        const accepted: RequirementUpdateJobAccepted = await updateRequirement(
          recordId, effectiveInput,
        ).finally(() => {
          if (input.intent === 'status-transition') sampleAfterPaint('transition_validation', validationStartedAt);
        });
        const subscription = subscribeToUpdateJob(accepted.jobId);
        void subscription.promise
          .then((job: RequirementUpdateJobSummary): void => {
            if (job.status === 'succeeded' && input.recoveryOf) {
              const url = new URL(window.location.href);
              if (url.pathname.endsWith(`/requirements/${encodeURIComponent(recordId)}`) && url.searchParams.get('recoveryOf') === input.recoveryOf) {
                url.searchParams.delete('recoveryOf');
                window.history.replaceState(window.history.state, '', url);
              }
            }
            if (job.status === 'failed') {
              toast.error(`修改失败：${job.errorMessage || '请重试'}`);
            }
            if (job.status === 'unknown') toast.error('修改结果待核实，请在操作记录中查看；未自动重试');
          })
          .catch((error: unknown): void => {
            if ((error as Error)?.name !== 'AbortError') {
              toast.error(
                `修改结果确认失败：${(error as Error)?.message || '请重试'}`,
              );
            }
          })
          .finally((): void => {
            subscription.cancel();
            const hasQueuedSuccessor: boolean =
              requirementUpdateQueues.get(recordId) !== queueTail;
            releaseQueue();
            if (!hasQueuedSuccessor) {
              requirementUpdateQueues.delete(recordId);
              void invalidateRequirement(recordId);
            }
          });
        return accepted;
      } catch (error) {
        releaseQueue();
        if (requirementUpdateQueues.get(recordId) === queueTail) {
          requirementUpdateQueues.delete(recordId);
        }
        throw error;
      }
    },
    onMutate: async ({ recordId, input, optimistic }): Promise<void> => {
      const feedbackStartedAt = performance.now();
      input.clientMutationId ||= crypto.randomUUID();
      input.source ||= 'web';
      const recoveryUrl = new URL(window.location.href);
      if (recoveryUrl.pathname.endsWith(`/requirements/${encodeURIComponent(recordId)}`)) {
        const recoveryOf = recoveryUrl.searchParams.get('recoveryOf');
        if (recoveryOf && /^[a-f0-9-]{36}$/iu.test(recoveryOf)) input.recoveryOf = recoveryOf;
      }
      const snapshot = queryClient.getQueryData<RequirementDetailResponse>(['requirement', recordId])?.requirement
        || queryClient.getQueryData<WorkspaceResponse>(WORKSPACE_QUERY_KEY)?.requirements?.find((item) => item.id === recordId)
        || queryClient.getQueryData<WorkspaceResponse>(BROWSER_WORKSPACE_QUERY_KEY)?.requirements.find((item) => item.id === recordId)
        || queryClient.getQueriesData<RequirementListResponse>({ queryKey: REQUIREMENTS_QUERY_KEY })
          .flatMap(([, value]) => value?.items || []).find((item) => item.id === recordId);
      if (snapshot) Object.assign(input, prepareOperationInput(snapshot, input));
      await Promise.all([
        queryClient.cancelQueries({ queryKey: WORKSPACE_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: REQUIREMENTS_QUERY_KEY }),
        queryClient.cancelQueries({ queryKey: ['requirement', recordId] }),
      ]);
      queryClient.setQueryData<WorkspaceResponse | undefined>(
        WORKSPACE_QUERY_KEY,
        (current) =>
          updateWorkspaceRequirement(
            current,
            recordId,
            input.patch,
            optimistic,
          ),
      );
      queryClient.setQueryData<WorkspaceResponse | undefined>(
        BROWSER_WORKSPACE_QUERY_KEY,
        (current) => updateWorkspaceRequirement(current, recordId, input.patch, optimistic),
      );
      queryClient.setQueriesData<RequirementListResponse | undefined>(
        { queryKey: REQUIREMENTS_QUERY_KEY },
        (current) =>
          updateRequirementList(current, recordId, input.patch, optimistic),
      );
      queryClient.setQueryData<RequirementDetailResponse | undefined>(
        ['requirement', recordId],
        (current) =>
          updateRequirementDetail(current, recordId, input.patch, optimistic),
      );
      sampleAfterPaint('interaction_feedback', feedbackStartedAt);
    },
    onError: (_error, variables): void => {
      void invalidateRequirement(variables.recordId);
    },
  });
}

export function useBulkUpdateRequirements() {
  const queryClient = useQueryClient();
  return useMutation<BulkMutationResult, Error, BulkRequirementUpdateInput>({
    mutationFn: bulkUpdateRequirements,
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }),
        queryClient.invalidateQueries({
          queryKey: WORKSPACE_SUMMARY_QUERY_KEY,
        }),
        queryClient.invalidateQueries({ queryKey: REQUIREMENTS_QUERY_KEY }),
      ]);
    },
  });
}
