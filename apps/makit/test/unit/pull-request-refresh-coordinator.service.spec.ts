import { PullRequestRefreshCoordinatorService } from '../../server/modules/pull-requests/pull-request-refresh-coordinator.service';

function snapshot() {
  return {
    repository: 'pythc/ai-homework-system',
    number: 42,
    title: 'feat: coordinated refresh',
    body: '',
    state: 'OPEN',
    draft: false,
    url: 'https://github.com/pythc/ai-homework-system/pull/42',
    author: { login: 'author', avatarUrl: '' },
    headRef: 'dev/test/refresh',
    baseRef: 'ahs_v1.0.1',
    mergeable: 'MERGEABLE',
    reviewDecision: '',
    checksStatus: 'SUCCESS',
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    commitCount: 1,
    commentCount: 0,
    reviewCount: 0,
    reviewThreadCount: 0,
    comments: [],
    reviews: [],
    requestedReviewers: [],
    reviewThreads: [],
    checks: [],
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:01:00.000Z',
    closedAt: null,
    mergedAt: null,
  };
}

function claim(
  claimed: boolean,
  reason: string,
  startedAt: string | null = null,
  lastSucceededAt: string | null = null,
  observedAt: string = '2026-08-12T08:00:00.000Z',
) {
  return [
    {
      result: {
        claimed,
        reason,
        observedAt,
        startedAt,
        lastSucceededAt,
      },
    },
  ];
}

describe('PullRequestRefreshCoordinatorService', () => {
  it('keeps GitHub I/O outside service-role transactions and persists under the lease', async () => {
    const completedAt = '2026-08-12T08:00:05.000Z';
    const execute = jest
      .fn()
      .mockResolvedValueOnce(claim(true, 'claimed', '2026-08-12T08:00:00.000Z'))
      .mockResolvedValueOnce(claim(true, 'renewed', '2026-08-12T08:00:04.000Z'))
      .mockResolvedValueOnce([
        {
          result: {
            finished: true,
            completedAt,
            lastSucceededAt: completedAt,
          },
        },
      ]);
    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    const database = {
      execute,
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({ onConflictDoUpdate }),
      }),
    };
    let inTransaction = false;
    const serviceRoleDatabase = {
      run: jest.fn(async <T>(operation: (db: never) => Promise<T>) => {
        inTransaction = true;
        try {
          return await operation(database as never);
        } finally {
          inTransaction = false;
        }
      }),
    };
    const github = {
      repository: jest.fn().mockReturnValue('pythc/ai-homework-system'),
      fetchPullRequests: jest.fn().mockImplementation(async () => {
        expect(inTransaction).toBe(false);
        return [snapshot()];
      }),
    };
    const service = new PullRequestRefreshCoordinatorService(
      github as never,
      serviceRoleDatabase as never,
    );

    await expect(service.refresh()).resolves.toEqual({
      refreshed: true,
      reason: 'refreshed',
      syncedAt: new Date(completedAt),
      syncedCount: 1,
    });
    expect(github.fetchPullRequests).toHaveBeenCalledTimes(1);
    expect(serviceRoleDatabase.run).toHaveBeenCalledTimes(3);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('splits snapshot upserts into proxy-safe batches inside the caller transaction', async () => {
    const onConflictDoUpdate = jest.fn().mockReturnValue({ getSQL: jest.fn() });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const execute = jest.fn().mockResolvedValue([]);
    const service = new PullRequestRefreshCoordinatorService(
      {} as never,
      {} as never,
    );
    const internal = service as unknown as {
      upsertSnapshots(
        database: never,
        snapshots: ReturnType<typeof snapshot>[],
        syncedAt: Date,
        reviewersFetchedAt: Date,
      ): Promise<void>;
    };
    const snapshots = Array.from({ length: 136 }, (_, index: number) => ({
      ...snapshot(),
      number: index + 1,
    }));

    await internal.upsertSnapshots(
      { insert, execute } as never,
      snapshots,
      new Date('2026-08-12T08:00:05.000Z'),
      new Date('2026-08-12T08:00:00.000Z'),
    );

    expect(insert).toHaveBeenCalledTimes(2);
    expect(values).toHaveBeenNthCalledWith(1, expect.any(Array));
    expect(values.mock.calls[0]?.[0]).toHaveLength(100);
    expect(values.mock.calls[1]?.[0]).toHaveLength(36);
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('honors the shared cooldown without calling GitHub', async () => {
    const lastSucceededAt = '2026-08-12T08:00:00.000Z';
    const database = {
      execute: jest
        .fn()
        .mockResolvedValue(claim(false, 'cooldown', null, lastSucceededAt)),
    };
    const github = {
      repository: jest.fn().mockReturnValue('pythc/ai-homework-system'),
      fetchPullRequests: jest.fn(),
    };
    const service = new PullRequestRefreshCoordinatorService(
      github as never,
      {
        run: <T>(operation: (db: never) => Promise<T>): Promise<T> =>
          operation(database as never),
      } as never,
    );

    await expect(service.refresh()).resolves.toEqual({
      refreshed: false,
      reason: 'cooldown',
      syncedAt: new Date(lastSucceededAt),
      syncedCount: 0,
    });
    expect(github.fetchPullRequests).not.toHaveBeenCalled();
  });

  it('passes a zero cooldown for an authoritative refresh', async () => {
    const service = new PullRequestRefreshCoordinatorService(
      {
        repository: jest.fn().mockReturnValue('pythc/ai-homework-system'),
      } as never,
      {} as never,
    );
    const internal = service as unknown as {
      claim: jest.Mock;
      startHeartbeat: jest.Mock;
      completeAndPersist: jest.Mock;
      github: { fetchPullRequests: jest.Mock };
    };
    internal.claim = jest
      .fn()
      .mockResolvedValueOnce({
        claimed: true,
        reason: 'claimed',
        observedAt: new Date('2026-08-12T08:00:00.000Z'),
        startedAt: new Date('2026-08-12T08:00:00.000Z'),
        lastSucceededAt: new Date('2026-08-12T07:59:59.000Z'),
      })
      .mockResolvedValue({
        claimed: true,
        reason: 'renewed',
        observedAt: new Date('2026-08-12T08:00:01.000Z'),
        startedAt: new Date('2026-08-12T08:00:01.000Z'),
        lastSucceededAt: new Date('2026-08-12T07:59:59.000Z'),
      });
    internal.startHeartbeat = jest.fn().mockReturnValue({
      leaseLost: (): boolean => false,
      stop: jest.fn().mockResolvedValue(undefined),
    });
    internal.completeAndPersist = jest
      .fn()
      .mockResolvedValue(new Date('2026-08-12T08:00:01.000Z'));
    internal.github.fetchPullRequests = jest.fn().mockResolvedValue([]);

    await service.refresh({
      waitForConcurrent: true,
      cooldownSeconds: 0,
      authoritative: true,
    });

    expect(internal.claim).toHaveBeenNthCalledWith(
      1,
      'pythc/ai-homework-system',
      expect.any(String),
      0,
    );
  });

  it('runs a new fetch when an older active refresh finishes after the authoritative check starts', async () => {
    const service = new PullRequestRefreshCoordinatorService(
      {
        repository: jest.fn().mockReturnValue('pythc/ai-homework-system'),
      } as never,
      {} as never,
    );
    const checkStartedAt = new Date('2026-08-12T08:00:00.000Z');
    const internal = service as unknown as {
      claim: jest.Mock;
      state: jest.Mock;
      startHeartbeat: jest.Mock;
      completeAndPersist: jest.Mock;
      github: { fetchPullRequests: jest.Mock };
    };
    internal.claim = jest
      .fn()
      .mockResolvedValueOnce({
        claimed: false,
        reason: 'active',
        observedAt: checkStartedAt,
        startedAt: null,
        lastSucceededAt: new Date('2026-08-12T07:59:00.000Z'),
      })
      .mockResolvedValueOnce({
        claimed: true,
        reason: 'claimed',
        observedAt: new Date('2026-08-12T08:00:02.000Z'),
        startedAt: new Date('2026-08-12T08:00:02.000Z'),
        lastSucceededAt: new Date('2026-08-12T08:00:01.000Z'),
      })
      .mockResolvedValueOnce({
        claimed: true,
        reason: 'renewed',
        observedAt: new Date('2026-08-12T08:00:03.000Z'),
        startedAt: new Date('2026-08-12T08:00:03.000Z'),
        lastSucceededAt: new Date('2026-08-12T08:00:01.000Z'),
      });
    // The active refresh did finish after our check began, but it might have
    // fetched GitHub before that point. Strict mode must claim another lease.
    internal.state = jest.fn().mockResolvedValue({
      active: false,
      lease_token: null,
      last_succeeded_at: new Date('2026-08-12T08:00:01.000Z'),
    });
    internal.startHeartbeat = jest.fn().mockReturnValue({
      leaseLost: (): boolean => false,
      stop: jest.fn().mockResolvedValue(undefined),
    });
    internal.completeAndPersist = jest
      .fn()
      .mockResolvedValue(new Date('2026-08-12T08:00:04.000Z'));
    internal.github.fetchPullRequests = jest.fn().mockResolvedValue([]);

    await service.refresh({
      waitForConcurrent: true,
      cooldownSeconds: 0,
      authoritative: true,
    });

    expect(internal.claim).toHaveBeenCalledTimes(3);
    expect(internal.github.fetchPullRequests).toHaveBeenCalledTimes(1);
  });

  it('discards fetched results when the database-time lease was lost', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(claim(true, 'claimed', '2026-08-12T08:00:00.000Z'))
      .mockResolvedValueOnce(claim(false, 'active'))
      .mockResolvedValueOnce([{ result: { finished: false } }]);
    const database = {
      execute,
      insert: jest.fn(),
    };
    const github = {
      repository: jest.fn().mockReturnValue('pythc/ai-homework-system'),
      fetchPullRequests: jest.fn().mockResolvedValue([snapshot()]),
    };
    const service = new PullRequestRefreshCoordinatorService(
      github as never,
      {
        run: <T>(operation: (db: never) => Promise<T>): Promise<T> =>
          operation(database as never),
      } as never,
    );

    await expect(service.refresh()).rejects.toThrow('合并请求刷新租约已失效');
    expect(database.insert).not.toHaveBeenCalled();
  });

  it('does not treat a newly claimed generation as renewal of an expired fetch', async () => {
    const execute = jest
      .fn()
      .mockResolvedValueOnce(claim(true, 'claimed', '2026-08-12T08:00:00.000Z'))
      // The old owner expired and, after another owner completed, its token
      // happened to claim an empty row again. It is a new generation, not a
      // valid renewal of the already-fetched response.
      .mockResolvedValueOnce(claim(true, 'claimed', '2026-08-12T08:02:00.000Z'))
      .mockResolvedValueOnce([{ result: { finished: true } }]);
    const database = {
      execute,
      insert: jest.fn(),
    };
    const github = {
      repository: jest.fn().mockReturnValue('pythc/ai-homework-system'),
      fetchPullRequests: jest.fn().mockResolvedValue([snapshot()]),
    };
    const service = new PullRequestRefreshCoordinatorService(
      github as never,
      {
        run: <T>(operation: (db: never) => Promise<T>): Promise<T> =>
          operation(database as never),
      } as never,
    );

    await expect(service.refresh()).rejects.toThrow('合并请求刷新租约已失效');
    expect(database.insert).not.toHaveBeenCalled();
  });

  it('marks the heartbeat lost unless the database explicitly returns renewed', async () => {
    jest.useFakeTimers();
    try {
      const service = new PullRequestRefreshCoordinatorService(
        {} as never,
        {} as never,
      );
      const internal = service as unknown as {
        claim: jest.Mock;
        startHeartbeat(
          repository: string,
          token: string,
          cooldownSeconds: number,
        ): { leaseLost(): boolean; stop(): Promise<void> };
      };
      internal.claim = jest.fn().mockResolvedValue({
        claimed: true,
        reason: 'claimed',
        observedAt: new Date(),
        startedAt: new Date(),
        lastSucceededAt: null,
      });
      const heartbeat = internal.startHeartbeat('owner/repo', 'token', 30);

      await jest.advanceTimersByTimeAsync(30_000);
      await heartbeat.stop();

      expect(heartbeat.leaseLost()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
