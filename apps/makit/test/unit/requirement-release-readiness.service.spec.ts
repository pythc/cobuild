import type { RequirementSummary } from '@shared/api.interface';
import { RequirementReleaseReadinessService } from '../../server/modules/requirements/requirement-release-readiness.service';

function requirement(): RequirementSummary {
  return {
    id: 'rec_requirement',
    code: 'REQ-202608120001',
    title: '发布门禁测试',
    gitBranchName: 'dev/test/release-gate',
    githubPullRequestUrl: 'https://github.com/pythc/ai-homework-system/pull/42',
    selfTestReport: '自测通过',
    defectCause: '',
    testers: [{ id: 'ou_tester', name: '测试' }],
    releaseOwners: [{ id: 'ou_release', name: '发布' }],
  } as RequirementSummary;
}

function database(rows: Record<string, unknown>[]) {
  const orderBy = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ orderBy, limit: jest.fn().mockResolvedValue(rows.slice(0,1)) });
  const from = jest.fn().mockReturnValue({ where });
  return { select: jest.fn().mockReturnValue({ from }), execute: jest.fn().mockResolvedValue([]), where };
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    repository: 'pythc/ai-homework-system',
    pullNumber: 42,
    title: 'feat: release gate',
    body: '',
    state: 'OPEN',
    draft: false,
    url: 'https://github.com/pythc/ai-homework-system/pull/42',
    headRef: 'dev/test/release-gate',
    reviewDecision: 'APPROVED',
    checksStatus: 'SUCCESS',
    reviewsJson: '[]',
    checksJson: '[]',
    requestedReviewersJson: '[]',
    reviewThreadsJson: '[]',
    githubUpdatedAt: new Date(),
    syncedAt: new Date(),
    ...overrides,
  };
}

function acceptanceFeishu() {
  return {
    searchRecords: jest.fn().mockResolvedValue([
      {
        record_id: 'acc-1',
        fields: {
          需求: [{ record_id: 'rec_requirement' }],
          是否完成: true,
        },
      },
    ]),
  };
}

function readinessService(rows: Record<string, unknown>[]) {
  const db = database(rows);
  const refreshCoordinator = {
    refresh: jest.fn().mockImplementation(async () => {
      rows.forEach((row) => {
        row.syncedAt = new Date();
      });
      return {
        refreshed: true,
        reason: 'refreshed',
        syncedAt: new Date(),
        syncedCount: rows.length,
      };
    }),
  };
  return {
    db,
    refreshCoordinator,
    service: new RequirementReleaseReadinessService(
      db as never,
      acceptanceFeishu() as never,
      { table: jest.fn().mockReturnValue('acceptance') } as never,
      refreshCoordinator as never,
    ),
  };
}

describe('RequirementReleaseReadinessService', () => {
  const previousRepository = process.env.GITHUB_REPOSITORY;

  beforeEach(() => {
    process.env.GITHUB_REPOSITORY = 'pythc/ai-homework-system';
  });

  afterAll(() => {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
  });

  it('ignores snapshots from another repository', async () => {
    const { db, service } = readinessService([
      snapshot({ repository: 'other/repository' }),
    ]);

    const result = await service.evaluate(requirement(), '待发布');

    expect(result.ready).toBe(false);
    expect(
      result.checks.find((check) => check.key === 'pull_request')?.passed,
    ).toBe(false);
    expect(db.where).toHaveBeenCalledTimes(1);
  });

  it('refreshes GitHub before enforcing the release gate', async () => {
    const { refreshCoordinator, service } = readinessService([
      snapshot({ syncedAt: new Date(Date.now() - 31 * 60 * 1000) }),
    ]);

    const result = await service.assertReady(requirement(), '待发布');

    expect(result.ready).toBe(true);
    expect(refreshCoordinator.refresh).toHaveBeenCalledWith({
      pullNumber: 42,
      waitForConcurrent: true,
      cooldownSeconds: 0,
      authoritative: true,
    });
    expect(
      result.checks.find((check) => check.key === 'pull_request_snapshot_fresh')
        ?.passed,
    ).toBe(true);
  });

  it('finds the release pull request by its exact GitHub link', async () => {
    const linkedRequirement = requirement();
    linkedRequirement.gitBranchName = '';
    linkedRequirement.githubPullRequestUrl =
      'https://github.com/pythc/ai-homework-system/pull/42';
    const { service } = readinessService([
      snapshot({ headRef: 'another-branch' }),
    ]);

    const result = await service.evaluate(linkedRequirement, '待发布');

    expect(result.ready).toBe(true);
    expect(
      result.checks.find((check) => check.key === 'pull_request')?.passed,
    ).toBe(true);
  });

  it('does not silently substitute a branch match for an explicit different PR link', async () => {
    const input = requirement();
    input.githubPullRequestUrl = 'https://github.com/pythc/ai-homework-system/pull/99';
    const { service } = readinessService([snapshot()]);
    const result = await service.evaluate(input, '待发布');
    expect(result.checks.find((check) => check.key === 'pull_request')?.passed).toBe(false);
  });

  it('treats a repository with no required checks or reviews as unblocked', async () => {
    const { service } = readinessService([
      snapshot({ checksStatus: 'UNKNOWN', reviewDecision: '' }),
    ]);

    const result = await service.evaluate(requirement(), '待发布');

    expect(result.ready).toBe(true);
    expect(
      result.checks.find((check) => check.key === 'github_checks')?.detail,
    ).toContain('按无阻塞处理');
    expect(
      result.checks.find((check) => check.key === 'github_review')?.detail,
    ).toContain('未要求强制审批');
  });

  it('still blocks known failed checks and outstanding requested reviewers', async () => {
    const { service } = readinessService([
      snapshot({
        checksStatus: 'FAILURE',
        reviewDecision: '',
        requestedReviewersJson: JSON.stringify([
          { login: 'human-reviewer', avatarUrl: '' },
        ]),
      }),
    ]);

    const result = await service.evaluate(requirement(), '待发布');

    expect(result.ready).toBe(false);
    expect(
      result.checks.find((check) => check.key === 'github_checks')?.passed,
    ).toBe(false);
    expect(
      result.checks.find((check) => check.key === 'github_review')?.passed,
    ).toBe(false);
  });

  it('accepts a merged pull request even when GitHub keeps historical review state', async () => {
    const { service } = readinessService([
      snapshot({
        state: 'MERGED',
        checksStatus: 'UNKNOWN',
        reviewDecision: '',
        requestedReviewersJson: JSON.stringify([
          { login: 'historical-reviewer', avatarUrl: '' },
        ]),
        reviewThreadsJson: JSON.stringify([
          { id: 'thread-1', resolved: false, outdated: false, comments: [] },
        ]),
      }),
    ]);

    const result = await service.evaluate(requirement(), '已发布');

    expect(result.ready).toBe(true);
    expect(
      result.checks.find((check) => check.key === 'github_review')?.detail,
    ).toContain('已完成评审门禁');
    expect(
      result.checks.find((check) => check.key === 'review_threads')?.passed,
    ).toBe(true);
  });
});
