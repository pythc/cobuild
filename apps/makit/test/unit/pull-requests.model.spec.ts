import type {
  PullRequestSummary,
  RequirementSummary,
} from '../../shared/api.interface';
import {
  linkedRequirementsForPullRequest,
  parseJsonArray,
  pullRequestStats,
  reviewerNotificationSummary,
  requirementCodesFromPullRequest,
  uniqueUserIds,
} from '../../server/modules/pull-requests/pull-requests.model';

function requirement(code: string, gitBranchName: string): RequirementSummary {
  return {
    id: code,
    code,
    title: `需求 ${code}`,
    url: `https://example.test/requirements/${code}`,
    gitBranchName,
    githubPullRequestUrl: '',
    iterationIds: ['iteration-1'],
    iterationNames: ['迭代一'],
  } as RequirementSummary;
}

function pullRequest(input: Partial<PullRequestSummary>): PullRequestSummary {
  return {
    state: 'OPEN',
    reviewDecision: '',
    reviewCount: 1,
    checksStatus: 'SUCCESS',
    ...input,
  } as PullRequestSummary;
}

describe('pull request model', () => {
  it('associates requirements by exact branch and requirement code', () => {
    const requirements = [
      requirement('REQ-202608080001', 'dev/zhoucanyu/lease'),
      requirement('REQ-202608080002', 'dev/zhoucanyu/other'),
    ];
    const linked = linkedRequirementsForPullRequest(
      {
        headRef: 'dev/zhoucanyu/lease',
        title: 'feat: 支持 REQ-202608080002',
        body: '',
      },
      requirements,
    );

    expect(linked.map((item) => item.code)).toEqual([
      'REQ-202608080001',
      'REQ-202608080002',
    ]);
  });

  it('associates a requirement by its exact GitHub pull request link', () => {
    const linkedByUrl = requirement('REQ-202608080004', '');
    linkedByUrl.githubPullRequestUrl =
      'https://github.com/pythc/ai-homework-system/pull/42';

    const linked = linkedRequirementsForPullRequest(
      {
        headRef: 'unrelated-branch',
        title: 'feat: unrelated title',
        body: '',
        url: 'https://github.com/pythc/ai-homework-system/pull/42',
      },
      [linkedByUrl],
    );

    expect(linked.map((item) => item.code)).toEqual(['REQ-202608080004']);
  });

  it('normalizes codes, user ids and malformed cached JSON', () => {
    expect([
      ...requirementCodesFromPullRequest({
        headRef: 'feature/req-202608080003',
        title: 'REQ-202608080003',
        body: '',
      }),
    ]).toEqual(['REQ-202608080003']);
    expect(uniqueUserIds([' 1 ', '1', '', '2'])).toEqual(['1', '2']);
    expect(parseJsonArray('{bad json')).toEqual([]);
  });

  it('computes actionable workspace counters', () => {
    const stats = pullRequestStats([
      pullRequest({ reviewDecision: 'REVIEW_REQUIRED', reviewCount: 0 }),
      pullRequest({ reviewDecision: 'CHANGES_REQUESTED' }),
      pullRequest({ checksStatus: 'FAILURE' }),
      pullRequest({ state: 'MERGED' }),
    ]);
    expect(stats).toEqual({
      total: 4,
      open: 3,
      waitingReview: 1,
      changesRequested: 1,
      checksFailed: 1,
    });
  });

  it('distinguishes delivered, retrying and exhausted Feishu notifications', () => {
    const base = {
      id: 'notification-1',
      reviewerName: '评审同学',
      githubLogin: 'reviewer',
      assignedByName: '操作人',
      notificationError: null,
      createdAt: new Date('2026-08-12T01:00:00.000Z'),
      notifiedAt: null,
    };

    expect(
      reviewerNotificationSummary({ ...base, notificationAttempts: 1 }, 8)
        .status,
    ).toBe('retrying');
    expect(
      reviewerNotificationSummary(
        {
          ...base,
          notificationAttempts: 8,
          notificationError: '发送失败',
        },
        8,
      ).status,
    ).toBe('failed');
    expect(
      reviewerNotificationSummary(
        {
          ...base,
          notificationAttempts: 1,
          notifiedAt: new Date('2026-08-12T01:01:00.000Z'),
        },
        8,
      ).status,
    ).toBe('delivered');
  });
});
