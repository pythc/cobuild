import { useQuery } from '@tanstack/react-query';
import type { RequirementEngineeringResponse } from '@shared/api.interface';
import { getRequirementEngineering } from '@/api';

export function useRequirementEngineering(
  requirementId: string,
  enabled: boolean = true,
) {
  return useQuery<RequirementEngineeringResponse>({
    queryKey: ['requirement', requirementId, 'engineering'],
    queryFn: ({ signal }) => getRequirementEngineering(requirementId, signal),
    enabled: Boolean(requirementId) && enabled,
    staleTime: 10_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query): number | false => {
      const data = query.state.data;
      const active = data
        ? Object.values(data.reviews).some((review) =>
            ['queued', 'running'].includes(review.status),
          )
        : false;
      return active ? 2_000 : false;
    },
  });
}
