import { useQuery } from '@tanstack/react-query';
import { useCurrentUserProfile } from '@/hooks/use-selfhost-session';
import { operationsApi } from '@/api';

export const OPERATIONS_QUERY_KEY = ['operations'] as const;

export function useOperationsAccess() {
  const currentUser = useCurrentUserProfile();
  const userId: string = currentUser?.user_id || '';
  return useQuery({
    queryKey: [...OPERATIONS_QUERY_KEY, 'access', userId],
    queryFn: async ({ signal }) => {
      const access = await operationsApi.getAccess(signal);
      if (access.userId !== userId)
        throw new Error('登录身份已变化，请刷新页面');
      return access;
    },
    enabled: Boolean(userId),
    staleTime: 15_000,
    refetchInterval: 60_000,
    retry: false,
  });
}
