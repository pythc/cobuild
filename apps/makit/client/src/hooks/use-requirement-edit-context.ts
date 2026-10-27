import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  RequirementEditContext,
  WorkspaceBrowserResponse,
} from '@shared/api.interface';
import { getRequirementEditContext } from '@/api';
import { BROWSER_WORKSPACE_QUERY_KEY } from './use-browser-workspace';

export function useRequirementEditContext() {
  const client = useQueryClient();
  return useQuery<RequirementEditContext>({
    queryKey: ['requirement-edit-context'],
    queryFn: ({ signal }) => getRequirementEditContext(signal),
    initialData: () => {
      const snapshot = client.getQueryData<WorkspaceBrowserResponse>(
        BROWSER_WORKSPACE_QUERY_KEY,
      );
      return snapshot
        ? { iterations: snapshot.iterations, options: snapshot.options }
        : undefined;
    },
    initialDataUpdatedAt: () => {
      const snapshot = client.getQueryData<WorkspaceBrowserResponse>(
        BROWSER_WORKSPACE_QUERY_KEY,
      );
      return snapshot?.freshness?.stale
        ? 0
        : client.getQueryState(BROWSER_WORKSPACE_QUERY_KEY)?.dataUpdatedAt;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}
