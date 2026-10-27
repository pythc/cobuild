const mockGet = jest.fn();
const mockPost = jest.fn();
const mockDelete = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: jest.fn(() => ({
      get: mockGet,
      post: mockPost,
      delete: mockDelete,
    })),
  },
  isAxiosError: jest.fn(() => false),
}));

import { GitHubPullRequestsService } from '../../server/modules/pull-requests/github-pull-requests.service';

describe('GitHubPullRequestsService', () => {
  const originalToken: string | undefined = process.env.GITHUB_TOKEN;
  const originalRepository: string | undefined = process.env.GITHUB_REPOSITORY;

  beforeEach((): void => {
    jest.clearAllMocks();
    process.env.GITHUB_TOKEN = 'test-token';
    process.env.GITHUB_REPOSITORY = 'owner/repository';
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_INSTALLATION_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  afterAll((): void => {
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
    if (originalRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = originalRepository;
  });

  it('lists only collaborators with push permission and caches the result', async () => {
    mockGet.mockResolvedValueOnce({
      data: [
        {
          login: 'writer',
          avatar_url: 'https://example.test/writer.png',
          permissions: { push: true },
        },
        {
          login: 'reader',
          avatar_url: 'https://example.test/reader.png',
          permissions: { push: false },
        },
      ],
    });
    const service: GitHubPullRequestsService = new GitHubPullRequestsService();

    await expect(service.reviewerCandidates()).resolves.toEqual([
      {
        login: 'writer',
        avatarUrl: 'https://example.test/writer.png',
      },
    ]);
    await service.reviewerCandidates();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledWith(
      '/repos/owner/repository/collaborators',
      expect.objectContaining({
        params: expect.objectContaining({ permission: 'push' }),
      }),
    );
  });

  it('adds and removes only the changed GitHub review requests', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: {
          users: [
            { login: 'alice', avatar_url: 'alice.png' },
            { login: 'bob', avatar_url: 'bob.png' },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          users: [
            { login: 'alice', avatar_url: 'alice.png' },
            { login: 'carol', avatar_url: 'carol.png' },
          ],
        },
      });
    mockPost.mockResolvedValueOnce({ data: {} });
    mockDelete.mockResolvedValueOnce({ data: {} });
    const service: GitHubPullRequestsService = new GitHubPullRequestsService();

    await expect(
      service.replaceRequestedReviewers(34, ['alice', 'carol']),
    ).resolves.toEqual({
      requestedReviewers: [
        { login: 'alice', avatarUrl: 'alice.png' },
        { login: 'carol', avatarUrl: 'carol.png' },
      ],
      addedLogins: ['carol'],
      removedLogins: ['bob'],
      fullyApplied: true,
      warning: '',
    });

    const path: string = '/repos/owner/repository/pulls/34/requested_reviewers';
    expect(mockPost).toHaveBeenCalledWith(
      path,
      { reviewers: ['carol'] },
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(mockDelete).toHaveBeenCalledWith(
      path,
      expect.objectContaining({ data: { reviewers: ['bob'] } }),
    );
  });

  it('does not write when the requested reviewer set is unchanged', async () => {
    mockGet.mockResolvedValueOnce({
      data: { users: [{ login: 'alice', avatar_url: 'alice.png' }] },
    });
    const service: GitHubPullRequestsService = new GitHubPullRequestsService();

    await expect(
      service.replaceRequestedReviewers(35, ['ALICE']),
    ).resolves.toEqual({
      requestedReviewers: [{ login: 'alice', avatarUrl: 'alice.png' }],
      addedLogins: [],
      removedLogins: [],
      fullyApplied: true,
      warning: '',
    });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockPost).not.toHaveBeenCalled();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('reads back and reports the authoritative state after a partial replacement', async () => {
    mockGet
      .mockResolvedValueOnce({
        data: {
          users: [
            { login: 'alice', avatar_url: 'alice.png' },
            { login: 'bob', avatar_url: 'bob.png' },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          users: [
            { login: 'alice', avatar_url: 'alice.png' },
            { login: 'bob', avatar_url: 'bob.png' },
            { login: 'carol', avatar_url: 'carol.png' },
          ],
        },
      });
    mockPost.mockResolvedValueOnce({ data: {} });
    mockDelete.mockRejectedValueOnce(new Error('remove failed'));
    const service: GitHubPullRequestsService = new GitHubPullRequestsService();

    await expect(
      service.replaceRequestedReviewers(34, ['alice', 'carol']),
    ).resolves.toEqual({
      requestedReviewers: [
        { login: 'alice', avatarUrl: 'alice.png' },
        { login: 'bob', avatarUrl: 'bob.png' },
        { login: 'carol', avatarUrl: 'carol.png' },
      ],
      addedLogins: ['carol'],
      removedLogins: [],
      fullyApplied: false,
      warning: expect.stringContaining('设置 GitHub 评审人失败'),
    });
  });

  it('stores requested reviewers from the GraphQL snapshot', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 36,
                  title: 'feat: reviewers',
                  state: 'OPEN',
                  updatedAt: '2026-08-10T00:00:00Z',
                  reviewRequests: {
                    nodes: [
                      {
                        requestedReviewer: {
                          login: 'reviewer',
                          avatarUrl: 'reviewer.png',
                        },
                      },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
    const service: GitHubPullRequestsService = new GitHubPullRequestsService();

    const result = await service.fetchPullRequests();

    expect(result[0]?.requestedReviewers).toEqual([
      { login: 'reviewer', avatarUrl: 'reviewer.png' },
    ]);
  });

  it('fails closed when GitHub release-gate connections are truncated', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 37,
                  title: 'feat: large review history',
                  state: 'OPEN',
                  url: 'https://github.com/owner/repository/pull/37',
                  updatedAt: '2026-08-10T00:00:00Z',
                  reviews: { totalCount: 51, nodes: [] },
                  reviewRequests: { totalCount: 0, nodes: [] },
                  reviewThreads: { totalCount: 0, nodes: [] },
                  commits: {
                    totalCount: 1,
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: 'SUCCESS',
                            contexts: { totalCount: 0, nodes: [] },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
    const service: GitHubPullRequestsService = new GitHubPullRequestsService();

    const [result] = await service.fetchPullRequests();

    expect(result.checksStatus).toBe('ERROR');
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        name: 'GitHub 评审数据完整性',
        conclusion: 'FAILURE',
      }),
    );
  });

  it('fails closed when the cached PR comments are truncated', async () => {
    mockPost.mockResolvedValueOnce({
      data: {
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  number: 38,
                  title: 'feat: large comment history',
                  state: 'OPEN',
                  url: 'https://github.com/owner/repository/pull/38',
                  updatedAt: '2026-08-10T00:00:00Z',
                  comments: { totalCount: 51, nodes: [] },
                  reviews: { totalCount: 0, nodes: [] },
                  reviewRequests: { totalCount: 0, nodes: [] },
                  reviewThreads: { totalCount: 0, nodes: [] },
                  commits: {
                    totalCount: 1,
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: {
                            state: 'SUCCESS',
                            contexts: { totalCount: 0, nodes: [] },
                          },
                        },
                      },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    });
    const service: GitHubPullRequestsService = new GitHubPullRequestsService();

    const [result] = await service.fetchPullRequests();

    expect(result.checksStatus).toBe('ERROR');
    expect(result.commentCount).toBe(51);
    expect(result.comments).toHaveLength(0);
  });
});
