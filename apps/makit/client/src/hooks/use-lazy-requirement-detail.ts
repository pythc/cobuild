import { useQuery } from '@tanstack/react-query';
import type { RequirementDetailResponse } from '@shared/api.interface';
import type { RequirementDetailSection } from '@shared/workspace-efficiency';
import { workspaceEfficiencyApi } from '@/api';
import { sampleAfterPaint } from '@/lib/experience-sampling';

export async function getLightRequirementDetail(
  id: string,
  signal?: AbortSignal,
): Promise<RequirementDetailResponse> {
  const startedAt = performance.now();
  const core = await workspaceEfficiencyApi.getRequirementCore(id, signal);
  sampleAfterPaint('first_usable', startedAt);
  return {
    requirement: core.requirement,
    comments: [],
    acceptanceItems: [],
    relations: [],
    activities: [],
  };
}

export function useLazyRequirementDetail(id: string, activeTab: string) {
  const core = useQuery({
    queryKey: ['requirement', id],
    queryFn: ({ signal }) => getLightRequirementDetail(id, signal),
    enabled: Boolean(id),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const useSection = <T extends RequirementDetailSection>(
    section: T,
    tab: string,
  ) =>
    useQuery({
      queryKey: ['requirement', id, 'sections', section],
      queryFn: ({ signal }) =>
        workspaceEfficiencyApi.getRequirementSection(id, section, signal),
      enabled: Boolean(id) && activeTab === tab,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    });
  const comments = useSection('comments', 'detail');
  const acceptance = useSection('acceptance', 'acceptance');
  const relations = useSection('relations', 'relations');
  const activities = useSection('activities', 'activity');
  const sections = {
    detail: comments,
    acceptance,
    relations,
    activity: activities,
  };
  const currentSection = sections[activeTab as keyof typeof sections];
  return {
    ...core,
    data: core.data
      ? {
          ...core.data,
          comments: comments.data?.items || [],
          acceptanceItems: acceptance.data?.items || [],
          relations: relations.data?.items || [],
          activities: activities.data?.items || [],
        }
      : undefined,
    sectionLoading: currentSection?.isLoading || false,
    sectionError: currentSection?.error || null,
    refetchSection: () => currentSection?.refetch(),
    loadedSections: {
      comments: Boolean(comments.data),
      acceptance: Boolean(acceptance.data),
      relations: Boolean(relations.data),
      activities: Boolean(activities.data),
    },
  };
}
