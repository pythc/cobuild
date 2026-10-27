import type {
  RequirementDetailResponse,
  RequirementListResponse,
  RequirementPatch,
  RequirementSummary,
  WorkspaceResponse,
} from '@shared/api.interface';

const DIRECT_PATCH_KEYS: ReadonlySet<keyof RequirementSummary> = new Set([
  'title',
  'introduction',
  'acceptanceCriteria',
  'selfTestReport',
  'defectCause',
  'gitBranchName',
  'githubPullRequestUrl',
  'type',
  'source',
  'tags',
  'status',
  'priority',
  'project',
  'iterationIds',
  'startAt',
  'deadlineAt',
  'developmentStartAt',
  'developmentEndAt',
  'testingAt',
  'actualStartAt',
  'actualTestingAt',
  'actualReleaseAt',
  'effort',
  'latestProgress',
  'blocked',
  'blocker',
]);

export function applyOptimisticRequirementUpdate(
  requirement: RequirementSummary,
  patch: RequirementPatch,
  optimistic: Partial<RequirementSummary> = {},
): RequirementSummary {
  const next: RequirementSummary = { ...requirement };
  if (patch.introduction !== undefined) next.introductionPreview = undefined;
  Object.entries(patch).forEach(([key, value]): void => {
    if (
      value !== undefined &&
      DIRECT_PATCH_KEYS.has(key as keyof RequirementSummary)
    ) {
      Object.assign(next, { [key]: value });
    }
  });
  return { ...next, ...optimistic };
}

export function updateWorkspaceRequirement(
  workspace: WorkspaceResponse | undefined,
  requirementId: string,
  patch: RequirementPatch,
  optimistic?: Partial<RequirementSummary>,
): WorkspaceResponse | undefined {
  if (!workspace) return workspace;
  return {
    ...workspace,
    requirements: workspace.requirements.map((requirement) =>
      requirement.id === requirementId
        ? applyOptimisticRequirementUpdate(requirement, patch, optimistic)
        : requirement,
    ),
  };
}

export function updateRequirementList(
  list: RequirementListResponse | undefined,
  requirementId: string,
  patch: RequirementPatch,
  optimistic?: Partial<RequirementSummary>,
): RequirementListResponse | undefined {
  if (!list) return list;
  const update = (requirement: RequirementSummary): RequirementSummary =>
    requirement.id === requirementId
      ? applyOptimisticRequirementUpdate(requirement, patch, optimistic)
      : requirement;
  return {
    ...list,
    items: list.items.map(update),
    groups: list.groups?.map((group) => ({
      ...group,
      items: group.items.map(update),
    })),
  };
}

export function updateRequirementDetail(
  detail: RequirementDetailResponse | undefined,
  requirementId: string,
  patch: RequirementPatch,
  optimistic?: Partial<RequirementSummary>,
): RequirementDetailResponse | undefined {
  if (!detail || detail.requirement.id !== requirementId) return detail;
  return {
    ...detail,
    requirement: applyOptimisticRequirementUpdate(
      detail.requirement,
      patch,
      optimistic,
    ),
  };
}
