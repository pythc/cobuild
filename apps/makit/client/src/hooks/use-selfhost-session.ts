import { useQuery } from '@tanstack/react-query';
import type { MakitSessionProfile } from '@shared/selfhost-api';
import { axiosForBackend } from '@/lib/selfhost-http';
export const SELFHOST_SESSION_QUERY = ['selfhost-session'];
export function useSelfhostSession() {
  return useQuery({ queryKey: SELFHOST_SESSION_QUERY,
    queryFn: async () => (await axiosForBackend.get<MakitSessionProfile>('/api/selfhost/session')).data,
    staleTime: 30000, retry: false });
}
export function useCurrentUserProfile() {
  return useSelfhostSession().data || { user_id: '', name: { zh_cn: '' }, avatar: '', employeeId: '', openId: '', roles: [] };
}
