import { useQueryClient } from '@tanstack/react-query';
import type { RequirementEngineeringResponse } from '@shared/api.interface';
import { LoaderCircle } from 'lucide-react';
import RequirementAiReviewCard from '@/components/RequirementAiReviewCard';
import { useRequirementEngineering } from '@/hooks/use-requirement-engineering';

export default function RequirementClarityReviewPanel({
  requirementId,
}: {
  requirementId: string;
}) {
  const queryClient = useQueryClient();
  const query = useRequirementEngineering(requirementId);
  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border px-4 py-3 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />正在加载清晰度评审
      </div>
    );
  }
  if (!query.data) return null;
  const update = (value: RequirementEngineeringResponse): void => {
    queryClient.setQueryData(['requirement', requirementId, 'engineering'], value);
  };
  return (
    <RequirementAiReviewCard
      requirementId={requirementId}
      review={query.data.reviews.clarity}
      canUpdate={query.data.canUpdate}
      canOverride={query.data.canOverride}
      onUpdated={update}
    />
  );
}
