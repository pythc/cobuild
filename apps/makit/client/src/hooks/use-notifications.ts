import { useQuery } from '@tanstack/react-query';
import type {
  NotificationDeliveryListResponse,
  NotificationDeliveryStatus,
} from '@shared/api.interface';
import { getNotificationDeliveries } from '@/api';

export const NOTIFICATIONS_QUERY_KEY = ['notification-deliveries'] as const;

export function useNotificationDeliveries(
  status: NotificationDeliveryStatus | undefined,
  page: number,
  pageSize: number,
) {
  return useQuery<NotificationDeliveryListResponse>({
    queryKey: [...NOTIFICATIONS_QUERY_KEY, status || 'all', page, pageSize],
    queryFn: ({ signal }) =>
      getNotificationDeliveries(status, page, pageSize, signal),
    staleTime: 15_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}
