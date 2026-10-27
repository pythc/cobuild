import { RequirementAccessService } from '../../server/modules/requirements/requirement-access.service';
import { PullRequestsService } from '../../server/modules/pull-requests/pull-requests.service';
import { FeishuMessageDeliveryError } from '../../server/modules/requirements/feishu.service';
import type { DeliveryPlan } from '../../server/modules/notifications/notification-delivery.model';

function deliveryStore() {
  let plan: DeliveryPlan;
  return {
    record: jest.fn().mockImplementation(async (input: DeliveryPlan) => {
      plan = input;
      return '8cff077c-ecdb-4bd0-b879-612fb152d64b';
    }),
    claim: jest
      .fn()
      .mockImplementation(async () => [
        {
          id: '8cff077c-ecdb-4bd0-b879-612fb152d64b',
          leaseToken: 'delivery-lease',
          targetId: plan.targetId,
          payload: plan.payload,
          idempotencyKey: '8cff077c-ecdb-4bd0-b879-612fb152d64b',
        },
      ]),
    result: jest.fn().mockResolvedValue({ accepted: true }),
  };
}

function serviceRoleDatabase(database: unknown): {
  run<T>(operation: (db: never) => Promise<T>): Promise<T>;
} {
  return {
    run: <T>(operation: (db: never) => Promise<T>): Promise<T> =>
      operation(database as never),
  };
}

interface NotifyReviewerInvoker {
  notifyReviewer(
    assignment: Record<string, unknown>,
    pullRequest: Record<string, unknown>,
  ): Promise<boolean>;
}

interface ReviewerAccessInvoker {
  assertCanUpdateReviewers(
    pullRequest: Record<string, unknown>,
    identity: Record<string, unknown>,
  ): Promise<void>;
}

interface ReviewerClaimInvoker {
  claimNotifications(
    assignmentIds: string[],
  ): Promise<Array<Record<string, unknown>>>;
}

describe('PullRequestsService reviewer notifications', () => {
  const originalMode: string | undefined =
    process.env.PR_REVIEWER_NOTIFICATION_MODE;

  beforeEach(() => {
    process.env.PR_REVIEWER_NOTIFICATION_MODE = 'live';
  });

  afterAll(() => {
    if (originalMode === undefined) {
      delete process.env.PR_REVIEWER_NOTIFICATION_MODE;
    } else {
      process.env.PR_REVIEWER_NOTIFICATION_MODE = originalMode;
    }
  });

  it('allows an editor to request the shared refresh coordinator', async () => {
    const syncedAt = new Date('2026-08-12T08:00:00.000Z');
    const refreshCoordinator = {
      refresh: jest.fn().mockResolvedValue({
        refreshed: true,
        reason: 'refreshed',
        syncedAt,
        syncedCount: 34,
      }),
    };
    const service = new PullRequestsService(
      {} as never,
      {} as never,
      {
        currentUser: jest.fn().mockResolvedValue({
          miaodaUserId: 'editor',
          roles: ['editor'],
        }),
      } as never,
      {} as never,
      new RequirementAccessService() as never,
      {} as never,
      refreshCoordinator as never,
    );

    await expect(
      service.refresh({
        userId: 'editor',
        userName: '编辑者',
        roles: ['editor'],
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        syncedCount: 34,
        syncedAt: syncedAt.toISOString(),
      }),
    );
    expect(refreshCoordinator.refresh).toHaveBeenCalledWith({
      waitForConcurrent: true,
    });
  });

  it('rejects an anonymous refresh before GitHub work starts', async () => {
    const refreshCoordinator = { refresh: jest.fn() };
    const service = new PullRequestsService(
      {} as never,
      {} as never,
      {
        currentUser: jest.fn().mockResolvedValue({
          miaodaUserId: '',
          roles: [],
        }),
      } as never,
      {} as never,
      new RequirementAccessService() as never,
      {} as never,
      refreshCoordinator as never,
    );

    await expect(
      service.refresh({ userId: 'member', userName: '成员', roles: [] }),
    ).rejects.toThrow('请先登录');
    expect(refreshCoordinator.refresh).not.toHaveBeenCalled();
  });

  it('sends the GitHub reviewer assignment to the mapped Feishu member', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue([{ result: { success: true, affectedCount: 1 } }]);
    const sendMessageWithReceipt = jest
      .fn()
      .mockResolvedValue({
        messageId: 'om_receipt',
        providerRequestId: 'request-1',
      });
    const deliveries = deliveryStore();
    const service = new PullRequestsService(
      { execute } as never,
      { repository: (): string => 'pythc/ai-homework-system' } as never,
      {} as never,
      { sendMessageWithReceipt } as never,
      {} as never,
      serviceRoleDatabase({ execute }) as never,
      undefined,
      deliveries as never,
    );
    const assignment = {
      id: '8cff077c-ecdb-4bd0-b879-612fb152d64b',
      repository: 'pythc/ai-homework-system',
      pullNumber: 34,
      reviewerEmployeeId: 'ou_feishu_reviewer',
      reviewerName: '评审同学',
      reviewerUserId: 'ou_feishu_reviewer',
      githubLogin: 'reviewer-login',
      assignedByName: '周灿宇',
      notificationClaimToken: '00b209a2-f6db-45c5-8f3e-294d6aad26d9',
      deliveryEligible: true,
      suppressedAt: null,
    };
    const pullRequest = {
      title: 'feat: reviewer notification',
      headRef: 'dev/zhoucanyu/reviewer',
      baseRef: 'ahs_v1.0.1',
    };

    const result: boolean = await (
      service as unknown as NotifyReviewerInvoker
    ).notifyReviewer(assignment, pullRequest);

    expect(result).toBe(true);
    expect(sendMessageWithReceipt).toHaveBeenCalledWith(
      'ou_feishu_reviewer',
      'user_id',
      'post',
      expect.objectContaining({
        zh_cn: expect.objectContaining({ title: '您被添加为合并请求评审人' }),
      }),
      '8cff077c-ecdb-4bd0-b879-612fb152d64b',
    );
    expect(deliveries.result).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'sent', messageId: 'om_receipt' }),
    );
    expect(
      JSON.stringify(deliveries.record.mock.calls[0][0].payload),
    ).toContain('/pull-requests/34');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records a failed delivery for background retry', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue([{ result: { success: true, affectedCount: 1 } }]);
    const sendMessageWithReceipt = jest
      .fn()
      .mockRejectedValue(
        new FeishuMessageDeliveryError('rejected', 'feishu_rejected_429'),
      );
    const deliveries = deliveryStore();
    const service = new PullRequestsService(
      { execute } as never,
      { repository: (): string => 'pythc/ai-homework-system' } as never,
      {} as never,
      { sendMessageWithReceipt } as never,
      {} as never,
      serviceRoleDatabase({ execute }) as never,
      undefined,
      deliveries as never,
    );

    const result: boolean = await (
      service as unknown as NotifyReviewerInvoker
    ).notifyReviewer(
      {
        id: 'c97d0a95-3120-4c46-843d-8cfec672915d',
        repository: 'pythc/ai-homework-system',
        pullNumber: 35,
        reviewerEmployeeId: 'ou_feishu_reviewer',
        githubLogin: 'reviewer-login',
        assignedByName: '周灿宇',
        notificationClaimToken: '00b209a2-f6db-45c5-8f3e-294d6aad26d9',
        deliveryEligible: true,
        suppressedAt: null,
      },
      {
        title: 'feat: retry',
        headRef: 'dev/zhoucanyu/retry',
        baseRef: 'ahs_v1.0.1',
      },
    );

    expect(result).toBe(false);
    expect(deliveries.result).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'rejected',
        errorCode: 'feishu_rejected_429',
      }),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not send without a lease or when the persisted event is suppressed', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const sendDirectPost = jest.fn().mockResolvedValue(undefined);
    const service = new PullRequestsService(
      { execute } as never,
      { repository: (): string => 'pythc/ai-homework-system' } as never,
      {} as never,
      { sendDirectPost } as never,
      {} as never,
      serviceRoleDatabase({ execute }) as never,
    );
    const pullRequest = {
      title: 'feat: reviewer notification',
      headRef: 'dev/zhoucanyu/reviewer',
      baseRef: 'ahs_v1.0.1',
    };
    const assignment = {
      id: '8cff077c-ecdb-4bd0-b879-612fb152d64b',
      repository: 'pythc/ai-homework-system',
      pullNumber: 34,
      reviewerEmployeeId: 'employee-1',
      githubLogin: 'reviewer-login',
      assignedByName: '周灿宇',
      notificationClaimToken: null,
      deliveryEligible: true,
      suppressedAt: null,
    };

    expect(
      await (service as unknown as NotifyReviewerInvoker).notifyReviewer(
        assignment,
        pullRequest,
      ),
    ).toBe(false);
    expect(
      await (service as unknown as NotifyReviewerInvoker).notifyReviewer(
        {
          ...assignment,
          notificationClaimToken: '00b209a2-f6db-45c5-8f3e-294d6aad26d9',
          deliveryEligible: false,
          suppressedAt: new Date('2026-08-12T00:00:00.000Z'),
        },
        pullRequest,
      ),
    ).toBe(false);

    expect(sendDirectPost).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('atomically claims retry work before reading the event payload', async () => {
    const eventId = '8cff077c-ecdb-4bd0-b879-612fb152d64b';
    const execute = jest.fn().mockResolvedValueOnce([
      {
        assignment_id: eventId,
        repository: 'pythc/ai-homework-system',
        pull_number: 34,
        github_login: 'reviewer-login',
        reviewer_employee_id: 'employee-1',
        reviewer_name: '评审同学',
        assigned_by_name: '周灿宇',
        assigned_by_user_id: 'miaoda-admin',
        delivery_eligible: true,
        suppressed_at: null,
        notification_claim_token: '00b209a2-f6db-45c5-8f3e-294d6aad26d9',
      },
    ]);
    const service = new PullRequestsService(
      { execute } as never,
      { repository: (): string => 'pythc/ai-homework-system' } as never,
      {} as never,
      {} as never,
      {} as never,
      serviceRoleDatabase({ execute }) as never,
    );

    const claimed = await (
      service as unknown as ReviewerClaimInvoker
    ).claimNotifications([]);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(claimed).toEqual([
      expect.objectContaining({
        id: eventId,
        assignedByUserId: 'miaoda-admin',
        notificationClaimToken: '00b209a2-f6db-45c5-8f3e-294d6aad26d9',
      }),
    ]);
  });

  it('reconciles a missing outbox event on retry even when GitHub reports no new addition', async () => {
    const snapshot = {
      repository: 'pythc/ai-homework-system',
      pullNumber: 34,
      state: 'OPEN',
      authorLogin: 'author',
      requestedReviewersJson: '[]',
    };
    const db = {
      select: jest.fn(() => ({
        from: () => ({
          where: () => ({ limit: async () => [snapshot] }),
        }),
      })),
      update: jest.fn(() => ({
        set: (values: { requestedReviewersJson?: string }) => ({
          where: async () => {
            if (values.requestedReviewersJson) {
              snapshot.requestedReviewersJson = values.requestedReviewersJson;
            }
          },
        }),
      })),
    };
    const github = {
      repository: (): string => 'pythc/ai-homework-system',
      currentRequestedReviewers: jest
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ login: 'reviewer-login', avatarUrl: '' }]),
      reviewerCandidates: jest
        .fn()
        .mockResolvedValue([{ login: 'reviewer-login', avatarUrl: '' }]),
      replaceRequestedReviewers: jest
        .fn()
        .mockResolvedValueOnce({
          requestedReviewers: [{ login: 'reviewer-login', avatarUrl: '' }],
          addedLogins: ['reviewer-login'],
          removedLogins: [],
          fullyApplied: true,
          warning: '',
        })
        .mockResolvedValueOnce({
          requestedReviewers: [{ login: 'reviewer-login', avatarUrl: '' }],
          addedLogins: [],
          removedLogins: [],
          fullyApplied: true,
          warning: '',
        }),
    };
    const service = new PullRequestsService(
      db as never,
      github as never,
      {} as never,
      {} as never,
      {} as never,
      serviceRoleDatabase(db) as never,
    );
    const internal = service as unknown as {
      assertCanUpdateReviewers: jest.Mock;
      upsertReviewerBindings: jest.Mock;
      prepareReviewerNotificationState: jest.Mock;
      finalizeReviewerNotificationState: jest.Mock;
      claimNotifications: jest.Mock;
      refresh: jest.Mock;
    };
    internal.assertCanUpdateReviewers = jest.fn().mockResolvedValue(undefined);
    internal.upsertReviewerBindings = jest.fn().mockResolvedValue(new Map());
    internal.prepareReviewerNotificationState = jest
      .fn()
      .mockResolvedValueOnce({
        token: 'fb407b29-3c65-4d37-a465-c94c124056c6',
        reused: false,
      })
      .mockResolvedValueOnce({
        token: 'fb407b29-3c65-4d37-a465-c94c124056c6',
        reused: true,
      });
    internal.finalizeReviewerNotificationState = jest
      .fn()
      .mockRejectedValueOnce(new Error('outbox unavailable'))
      .mockResolvedValueOnce(['event-1']);
    internal.claimNotifications = jest.fn().mockResolvedValue([]);
    internal.refresh = jest.fn().mockResolvedValue({
      success: true,
      message: 'ok',
      syncedCount: 1,
      syncedAt: new Date().toISOString(),
    });
    const identity = { userId: 'user-1', userName: '周灿宇' };

    await expect(
      service.updateReviewers(34, ['reviewer-login'], identity),
    ).rejects.toThrow('outbox unavailable');
    await expect(
      service.updateReviewers(34, ['reviewer-login'], identity),
    ).resolves.toEqual(expect.objectContaining({ notificationQueuedCount: 1 }));

    expect(github.replaceRequestedReviewers).toHaveBeenCalledTimes(1);
    expect(github.replaceRequestedReviewers).toHaveBeenCalledWith(
      34,
      ['reviewer-login'],
      [],
    );
    expect(internal.prepareReviewerNotificationState).toHaveBeenNthCalledWith(
      1,
      'pythc/ai-homework-system',
      34,
      [],
      ['reviewer-login'],
      '周灿宇',
      identity,
      undefined,
    );
    expect(internal.prepareReviewerNotificationState).toHaveBeenNthCalledWith(
      2,
      'pythc/ai-homework-system',
      34,
      ['reviewer-login'],
      ['reviewer-login'],
      '周灿宇',
      identity,
      undefined,
    );
    expect(internal.finalizeReviewerNotificationState).toHaveBeenCalledTimes(2);
    expect(internal.finalizeReviewerNotificationState).toHaveBeenNthCalledWith(
      2,
      'pythc/ai-homework-system',
      34,
      [{ login: 'reviewer-login', avatarUrl: '' }],
      'fb407b29-3c65-4d37-a465-c94c124056c6',
      null,
      null,
      identity,
      undefined,
    );
  });

  it('does not repeat an in-flight GitHub mutation for the same operation', async () => {
    const db = {
      select: jest.fn(() => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                repository: 'pythc/ai-homework-system',
                pullNumber: 34,
                state: 'OPEN',
                authorLogin: 'author',
              },
            ],
          }),
        }),
      })),
    };
    const github = {
      repository: (): string => 'pythc/ai-homework-system',
      reviewerCandidates: jest
        .fn()
        .mockResolvedValue([{ login: 'reviewer-login', avatarUrl: '' }]),
      currentRequestedReviewers: jest.fn().mockResolvedValue([]),
      replaceRequestedReviewers: jest.fn(),
    };
    const service = new PullRequestsService(
      db as never,
      github as never,
      {} as never,
      {} as never,
      {} as never,
      serviceRoleDatabase(db) as never,
    );
    const internal = service as unknown as {
      assertCanUpdateReviewers: jest.Mock;
      upsertReviewerBindings: jest.Mock;
      prepareReviewerNotificationState: jest.Mock;
    };
    internal.assertCanUpdateReviewers = jest.fn().mockResolvedValue(undefined);
    internal.upsertReviewerBindings = jest.fn().mockResolvedValue(new Map());
    internal.prepareReviewerNotificationState = jest.fn().mockResolvedValue({
      token: 'fb407b29-3c65-4d37-a465-c94c124056c6',
      reused: true,
    });

    await expect(
      service.updateReviewers(34, ['reviewer-login'], {
        userId: 'user-1',
        userName: '周灿宇',
      }),
    ).rejects.toThrow('相同的评审人变更仍在处理中');
    expect(github.replaceRequestedReviewers).not.toHaveBeenCalled();
  });

  it('allows an editor reviewer update without requiring a linked requirement', async () => {
    const requirements = {
      currentUser: jest.fn().mockResolvedValue({
        miaodaUserId: 'miaoda-editor',
        employeeId: 'employee-editor',
        openId: 'ou_editor',
        name: '编辑者',
        roles: ['editor'],
      }),
    };
    const access = new RequirementAccessService();
    const service = new PullRequestsService(
      {} as never,
      {} as never,
      requirements as never,
      {} as never,
      access as never,
      serviceRoleDatabase({}) as never,
    );

    await expect(
      (service as unknown as ReviewerAccessInvoker).assertCanUpdateReviewers(
        { title: '无关联 PR', body: '', headRef: 'dev/unlinked' },
        { userId: 'miaoda-editor', userName: '编辑者', roles: ['editor'] },
      ),
    ).resolves.toBeUndefined();
  });

  it('allows a signed-in requirement participant to set reviewers', async () => {
    const requirements = {
      currentUser: jest.fn().mockResolvedValue({
        miaodaUserId: 'miaoda-member',
        employeeId: 'employee-member',
        openId: 'ou_member',
        name: '需求负责人',
        roles: [],
      }),
    };
    const access = new RequirementAccessService();
    const service = new PullRequestsService(
      {} as never,
      {} as never,
      requirements as never,
      {} as never,
      access as never,
      serviceRoleDatabase({}) as never,
    );

    await expect(
      (service as unknown as ReviewerAccessInvoker).assertCanUpdateReviewers(
        { title: '关联 PR', body: '', headRef: 'dev/linked' },
        { userId: 'miaoda-member', userName: '需求负责人', roles: [] },
      ),
    ).resolves.toBeUndefined();
  });
});
