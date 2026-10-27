import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RelayProfile, RelayState } from '@shared/api.interface';
import { relayRequest } from '@/api';
export function useRelayProfile() {
  return useQuery({
    queryKey: ['relay', 'profile'],
    queryFn: () => relayRequest<RelayProfile>('/api/relay/profile'),
    staleTime: 60_000,
    retry: false,
  });
}
export function useRelayState(view: 'customer' | 'operator', enabled: boolean) {
  return useQuery({
    queryKey: ['relay', view],
    queryFn: () => relayRequest<RelayState>('/api/relay/state?view=' + view),
    enabled,
    retry: false,
    refetchInterval: enabled ? 5000 : false,
    refetchIntervalInBackground: false,
  });
}
export function useRefreshRelay() {
  const cache = useQueryClient();
  return () => cache.invalidateQueries({ queryKey: ['relay'] });
}
export function relayError(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请重试';
}
