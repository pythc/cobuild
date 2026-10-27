import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MutationResult,
  RequirementArchiveListResponse,
} from '@shared/api.interface';
import {
  getRequirementArchive,
  permanentlyDeleteRequirement,
  restoreRequirement,
} from '@/api';
import {
  REQUIREMENTS_QUERY_KEY,
  WORKSPACE_QUERY_KEY,
  WORKSPACE_SUMMARY_QUERY_KEY,
} from '@/hooks/use-workspace';

export const REQUIREMENT_ARCHIVE_QUERY_KEY = ['requirement-archive'] as const;

export function useRequirementArchive(enabled: boolean) {
  return useQuery<RequirementArchiveListResponse>({
    queryKey: REQUIREMENT_ARCHIVE_QUERY_KEY,
    queryFn: ({ signal }) => getRequirementArchive(signal),
    enabled,
    staleTime: 15_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}

function useInvalidateRequirements() {
  const queryClient = useQueryClient();
  return async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: REQUIREMENT_ARCHIVE_QUERY_KEY,
      }),
      queryClient.invalidateQueries({ queryKey: WORKSPACE_QUERY_KEY }),
      queryClient.invalidateQueries({
        queryKey: WORKSPACE_SUMMARY_QUERY_KEY,
      }),
      queryClient.invalidateQueries({ queryKey: REQUIREMENTS_QUERY_KEY }),
    ]);
  };
}

export function useRestoreRequirement() {
  const invalidate = useInvalidateRequirements();
  return useMutation<MutationResult, Error, string>({
    mutationFn: restoreRequirement,
    onSuccess: invalidate,
  });
}

export function usePermanentlyDeleteRequirement() {
  const invalidate = useInvalidateRequirements();
  return useMutation<MutationResult, Error, string>({
    mutationFn: permanentlyDeleteRequirement,
    onSuccess: invalidate,
  });
}
