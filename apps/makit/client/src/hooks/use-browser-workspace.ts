import { waitForRequirementUpdates } from '@/lib/requirement-update-queues';
import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RequirementListQuery } from '@shared/api.interface';
import { selectRequirementList } from '@shared/requirement-list';
import { getBrowserWorkspace } from '@/api';

export const BROWSER_WORKSPACE_QUERY_KEY = [
  'workspace',
  'browser-index',
] as const;

export function useBrowserWorkspace(enabled = true) {
  return useQuery({
    queryKey: BROWSER_WORKSPACE_QUERY_KEY,
    queryFn: async ({ signal }) => {
      await waitForRequirementUpdates(signal);
      return getBrowserWorkspace(false, signal);
    },
    enabled,
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
    // Fetch cadence is independent of search/filter changes. A stale server
    // snapshot is checked again soon after its background refresh completes.
    refetchInterval: (query) =>
      query.state.data?.freshness?.stale ? 5_000 : 30_000,
  });
}

export function useBrowserRequirementList(
  query: RequirementListQuery,
  enabled = true,
) {
  const workspace = useBrowserWorkspace(enabled);
  const data = useMemo(
    () =>
      workspace.data ? selectRequirementList(workspace.data, query) : undefined,
    [workspace.data, query],
  );
  return { ...workspace, data };
}

export function useRefreshBrowserWorkspace() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await client.cancelQueries({ queryKey: BROWSER_WORKSPACE_QUERY_KEY });
      // Use the same cancellable query as automatic reads. An edit starting
      // during manual refresh must cancel that response before optimistic data.
      return client.fetchQuery({
        queryKey: BROWSER_WORKSPACE_QUERY_KEY,
        staleTime: 0,
        queryFn: async ({ signal }) => {
          await waitForRequirementUpdates(signal);
          return getBrowserWorkspace(true, signal);
        },
      });
    },
  });
}
