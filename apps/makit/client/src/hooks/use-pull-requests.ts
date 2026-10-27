import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  PullRequestDetailResponse,
  PullRequestRefreshResult,
  PullRequestReviewerUpdateInput,
  PullRequestReviewerUpdateResult,
  PullRequestWorkspaceResponse,
} from '@shared/api.interface';
import {
  getPullRequestDetail,
  getPullRequestWorkspace,
  refreshPullRequests,
  updatePullRequestReviewers,
} from '@/api';
import { toast } from 'sonner';

export const PULL_REQUESTS_QUERY_KEY = ['pull-requests'] as const;

export function usePullRequests() {
  return useQuery<PullRequestWorkspaceResponse>({
    queryKey: PULL_REQUESTS_QUERY_KEY,
    queryFn: ({ signal }) => getPullRequestWorkspace(signal),
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function usePullRequestDetail(pullNumber: number | null) {
  return useQuery<PullRequestDetailResponse>({
    queryKey: [...PULL_REQUESTS_QUERY_KEY, pullNumber],
    queryFn: ({ signal }) => getPullRequestDetail(pullNumber || 0, signal),
    enabled: pullNumber != null,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

export function useRefreshPullRequests() {
  const queryClient = useQueryClient();
  return useMutation<PullRequestRefreshResult, Error>({
    mutationFn: refreshPullRequests,
    onSuccess: async (result) => {
      toast.success(result.message);
      await queryClient.invalidateQueries({
        queryKey: PULL_REQUESTS_QUERY_KEY,
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || '刷新合并请求失败');
    },
  });
}

export function useUpdatePullRequestReviewers(pullNumber: number) {
  const queryClient = useQueryClient();
  return useMutation<
    PullRequestReviewerUpdateResult,
    Error,
    PullRequestReviewerUpdateInput
  >({
    mutationFn: (input) => updatePullRequestReviewers(pullNumber, input),
    onSuccess: async (result) => {
      toast.success(result.message);
      await queryClient.invalidateQueries({
        queryKey: PULL_REQUESTS_QUERY_KEY,
      });
    },
    onError: (error: Error) => {
      toast.error(error.message || '保存合并请求评审人失败');
    },
  });
}
