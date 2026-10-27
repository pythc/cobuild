import type {
  PullRequestRequirementLink,
  PullRequestReviewerNotificationSummary,
  PullRequestSummary,
  PullRequestWorkspaceStats,
  RequirementSummary,
} from '@shared/api.interface';

export function reviewerNotificationSummary(
  row: {
    id: string;
    reviewerName: string;
    githubLogin: string | null;
    assignedByName: string;
    notificationAttempts: number;
    notificationError: string | null;
    createdAt: Date;
    notifiedAt: Date | null;
  },
  maxAttempts: number,
): PullRequestReviewerNotificationSummary {
  const status: PullRequestReviewerNotificationSummary['status'] =
    row.notifiedAt
      ? 'delivered'
      : row.notificationAttempts >= maxAttempts
        ? 'failed'
        : row.notificationAttempts > 0
          ? 'retrying'
          : 'pending';
  return {
    id: row.id,
    reviewerName: row.reviewerName,
    githubLogin: row.githubLogin || '',
    assignedByName: row.assignedByName,
    status,
    attempts: row.notificationAttempts,
    errorMessage: row.notificationError || '',
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.notifiedAt?.toISOString() || null,
  };
}

export function parseJsonArray<T>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export function requirementCodesFromPullRequest(input: {
  title: string;
  body: string;
  headRef: string;
}): Set<string> {
  return new Set(
    `${input.headRef}\n${input.title}\n${input.body}`
      .match(/REQ-\d+/giu)
      ?.map((code: string): string => code.toUpperCase()) || [],
  );
}

export function linkedRequirementsForPullRequest(
  pullRequest: { title: string; body: string; headRef: string; url?: string },
  requirements: RequirementSummary[],
): PullRequestRequirementLink[] {
  const headRef: string = pullRequest.headRef.trim();
  const codes: Set<string> = requirementCodesFromPullRequest(pullRequest);
  return requirements
    .filter((requirement: RequirementSummary): boolean =>
      Boolean(
        (headRef && requirement.gitBranchName.trim() === headRef) ||
        (pullRequest.url &&
          requirement.githubPullRequestUrl.trim() === pullRequest.url.trim()) ||
        codes.has(requirement.code.toUpperCase()),
      ),
    )
    .map(
      (requirement: RequirementSummary): PullRequestRequirementLink => ({
        id: requirement.id,
        code: requirement.code,
        title: requirement.title,
        url: requirement.url,
        gitBranchName: requirement.gitBranchName,
        githubPullRequestUrl: requirement.githubPullRequestUrl,
        iterationIds: requirement.iterationIds,
        iterationNames: requirement.iterationNames,
      }),
    );
}

export function pullRequestStats(
  pullRequests: PullRequestSummary[],
): PullRequestWorkspaceStats {
  return {
    total: pullRequests.length,
    open: pullRequests.filter(
      (pullRequest: PullRequestSummary): boolean =>
        pullRequest.state === 'OPEN',
    ).length,
    waitingReview: pullRequests.filter(
      (pullRequest: PullRequestSummary): boolean =>
        pullRequest.state === 'OPEN' &&
        (pullRequest.reviewDecision === 'REVIEW_REQUIRED' ||
          pullRequest.reviewCount === 0),
    ).length,
    changesRequested: pullRequests.filter(
      (pullRequest: PullRequestSummary): boolean =>
        pullRequest.state === 'OPEN' &&
        pullRequest.reviewDecision === 'CHANGES_REQUESTED',
    ).length,
    checksFailed: pullRequests.filter(
      (pullRequest: PullRequestSummary): boolean =>
        pullRequest.state === 'OPEN' &&
        ['ERROR', 'FAILURE'].includes(pullRequest.checksStatus),
    ).length,
  };
}

export function uniqueUserIds(values: string[]): string[] {
  return [...new Set(values.map((value: string): string => value.trim()))]
    .filter(Boolean)
    .slice(0, 100);
}
